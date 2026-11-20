import { afterEach, describe, expect, it, vi } from 'vitest'

// claude_prompt.txt ("v185 -- Fix SSO Fragment Authentication & Permission
// Hydration"): the module under test captures a `#sso=` URL fragment and
// decides token/permission state entirely at import time, so each test
// here builds a minimal fake `window`/`sessionStorage`/`fetch` BEFORE a
// fresh `import()` of api.ts (via vi.resetModules()) -- the real
// consumeSsoFragmentToken()/module-load logic runs unchanged, just against
// fakes instead of a real browser. No new test dependency (jsdom/RTL) is
// introduced: the module only ever touches window.location.hash,
// window.history.replaceState, sessionStorage, and fetch, all of which are
// trivial to fake by hand.

type FakeStore = Map<string, string>

function installFakeBrowser(hash: string): FakeStore {
  const store: FakeStore = new Map()

  ;(globalThis as any).sessionStorage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  }

  const location = {
    hash,
    pathname: '/',
    search: '',
    protocol: 'http:',
    hostname: 'localhost',
  }

  ;(globalThis as any).window = {
    location,
    history: {
      replaceState: (_state: unknown, _title: string, _url: string) => {
        location.hash = ''
      },
    },
  }

  return store
}

function uninstallFakeBrowser(): void {
  delete (globalThis as any).window
  delete (globalThis as any).sessionStorage
  delete (globalThis as any).fetch
}

async function freshApi() {
  vi.resetModules()
  return import('./api')
}

describe('SSO Fragment authentication & permission hydration (v185)', () => {
  afterEach(() => {
    uninstallFakeBrowser()
    vi.restoreAllMocks()
  })

  it('1. a fragment token calls GET /auth/me with it as a Bearer header', async () => {
    installFakeBrowser('#sso=admin-jwt')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        user: { id: 'u1', name: 'Admin' },
        roles: ['admin'],
        permissions: ['sales.update', 'sales.revise', 'sales.read', 'sales.approve'],
      }),
    })
    ;(globalThis as any).fetch = fetchMock

    const api = await freshApi()
    expect(api.getToken()).toBe('admin-jwt')
    expect(api.hasPendingFragmentAuth()).toBe(true)

    const ok = await api.hydrateFromSsoFragmentToken()

    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/auth/me')
    expect(init?.headers?.Authorization).toBe('Bearer admin-jwt')
  })

  it('2. a returned sales.update permission enables Edit access (hasPermission)', async () => {
    installFakeBrowser('#sso=admin-jwt')
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: ['sales.update', 'sales.read'] }),
    })

    const api = await freshApi()
    await api.hydrateFromSsoFragmentToken()

    expect(api.hasPermission('sales.update')).toBe(true)
  })

  it('3. a user without sales.update does not receive Edit access', async () => {
    installFakeBrowser('#sso=viewer-jwt')
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: ['sales.read'] }),
    })

    const api = await freshApi()
    await api.hydrateFromSsoFragmentToken()

    expect(api.hasPermission('sales.update')).toBe(false)
  })

  it('4. a failed /auth/me does not leave the app authenticated with stale permissions', async () => {
    installFakeBrowser('#sso=expired-jwt')
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Unauthorized' }),
    })

    const api = await freshApi()
    const ok = await api.hydrateFromSsoFragmentToken()

    expect(ok).toBe(false)
    expect(api.getToken()).toBeNull()
    expect(api.getPermissions()).toEqual([])
    expect(api.hasPermission('sales.update')).toBe(false)
  })

  it('4b. a network error calling /auth/me also clears state rather than throwing', async () => {
    installFakeBrowser('#sso=admin-jwt')
    ;(globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('network down'))

    const api = await freshApi()
    const ok = await api.hydrateFromSsoFragmentToken()

    expect(ok).toBe(false)
    expect(api.getToken()).toBeNull()
    expect(api.getPermissions()).toEqual([])
  })

  it('5. a new fragment arrival (account switch) clears whatever permissions a previous session left behind', async () => {
    // Simulates: Admin was signed in on this tab, their permissions are
    // already sitting in sessionStorage, then a restricted account arrives
    // via a brand-new #sso= fragment (e.g. a different EMS login handing
    // off again). The stale Admin permissions must never be visible before
    // (or if) the new account's own /auth/me call resolves.
    const store = installFakeBrowser('#sso=restricted-user-jwt')
    store.set('qt_ems_permissions', JSON.stringify(['sales.update', 'sales.approve']))
    ;(globalThis as any).fetch = vi.fn()

    const api = await freshApi()

    expect(api.getPermissions()).toEqual([])
    expect(api.hasPermission('sales.update')).toBe(false)
    expect(store.has('qt_ems_permissions')).toBe(false)
  })

  it('5b. switching accounts end-to-end: hydrating the restricted account never exposes the previous admin permissions', async () => {
    const store = installFakeBrowser('#sso=restricted-user-jwt')
    store.set('qt_ems_permissions', JSON.stringify(['sales.update', 'sales.approve']))
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: ['sales.read'] }),
    })

    const api = await freshApi()
    await api.hydrateFromSsoFragmentToken()

    expect(api.getPermissions()).toEqual(['sales.read'])
    expect(api.hasPermission('sales.update')).toBe(false)
  })

  it('9. refreshing after a successful SSO fragment hydration keeps the validated permissions without re-bypassing validation', async () => {
    // First load: the fragment arrives, hydration succeeds, token +
    // permissions land in sessionStorage.
    installFakeBrowser('#sso=admin-jwt')
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: ['sales.update'] }),
    })
    const firstLoad = await freshApi()
    await firstLoad.hydrateFromSsoFragmentToken()
    const persistedToken = firstLoad.getToken()
    const persistedPermissions = firstLoad.getPermissions()

    // Simulate a page refresh: new module instance, same sessionStorage
    // contents, but the URL no longer carries the `#sso=` fragment (it was
    // already stripped via history.replaceState on first load).
    const store = installFakeBrowser('')
    store.set('qt_ems_token', persistedToken as string)
    store.set('qt_ems_permissions', JSON.stringify(persistedPermissions))
    const fetchAfterRefresh = vi.fn()
    ;(globalThis as any).fetch = fetchAfterRefresh

    const afterRefresh = await freshApi()

    expect(afterRefresh.getToken()).toBe('admin-jwt')
    expect(afterRefresh.getPermissions()).toEqual(['sales.update'])
    expect(afterRefresh.hasPendingFragmentAuth()).toBe(false)
    expect(afterRefresh.hasPermission('sales.update')).toBe(true)
    // No fragment on reload means no re-hydration call is even attempted --
    // the stored permissions are trusted as-is for this tab, exactly as the
    // cookie/manual-login paths already behave.
    expect(fetchAfterRefresh).not.toHaveBeenCalled()
  })

  it('bootstrapSsoAuth() is race-safe under React StrictMode-style double effect invocation (mount -> cleanup -> mount)', async () => {
    // StrictMode runs the bootstrap effect twice in dev. If the second
    // invocation re-derived "fragment vs cookie" from the mutable
    // fragmentHydrationPending flag, it would see that flag already false
    // (flipped synchronously by the first invocation) and wrongly fall
    // through to the cookie path instead of awaiting the same fragment
    // hydration already in flight. bootstrapSsoAuth() must return the
    // identical promise both times instead.
    installFakeBrowser('#sso=admin-jwt')
    let resolveMe: (value: { ok: true; json: () => Promise<unknown> }) => void
    const meResponse = new Promise((resolve) => {
      resolveMe = resolve as typeof resolveMe
    })
    const fetchMock = vi.fn().mockReturnValue(meResponse)
    ;(globalThis as any).fetch = fetchMock

    const api = await freshApi()

    const firstInvocation = api.bootstrapSsoAuth()
    const secondInvocation = api.bootstrapSsoAuth()

    expect(secondInvocation).toBe(firstInvocation)

    resolveMe!({ ok: true, json: async () => ({ permissions: ['sales.update'] }) })
    const [firstResult, secondResult] = await Promise.all([firstInvocation, secondInvocation])

    expect(firstResult).toBe(true)
    expect(secondResult).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(api.hasPermission('sales.update')).toBe(true)
  })

  it('a second call to hydrateFromSsoFragmentToken() does not re-fire the request (no infinite hydration loop)', async () => {
    installFakeBrowser('#sso=admin-jwt')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: ['sales.update'] }),
    })
    ;(globalThis as any).fetch = fetchMock

    const api = await freshApi()
    await api.hydrateFromSsoFragmentToken()
    const second = await api.hydrateFromSsoFragmentToken()

    expect(second).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
