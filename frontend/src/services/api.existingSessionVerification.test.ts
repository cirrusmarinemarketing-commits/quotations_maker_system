import { afterEach, describe, expect, it, vi } from 'vitest'

// claude_prompt.txt ("v189 -- Unified EMS & Quotation Authentication /
// Shared Login Session"): before this round, a token already sitting in
// sessionStorage from an earlier visit to this tab was trusted on sight --
// bootstrapSsoAuth() (and App.tsx's own `loggedIn` initializer) never made
// a server round trip for that case, unlike ems-frontend's own equivalent
// (current-user.tsx), which always calls GET /auth/me when a local token
// exists. This file covers the new verifyExistingSession() branch that
// closes that gap. Same hand-rolled fake window/sessionStorage/fetch
// harness as api.ssoFragment.test.ts (no jsdom/RTL dependency), reused
// here because the module's initial `token` value is also decided at
// import time, from sessionStorage.

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

describe('Existing-session re-verification on mount (v189)', () => {
  afterEach(() => {
    uninstallFakeBrowser()
    vi.restoreAllMocks()
  })

  it('a stored token (no fragment) triggers GET /auth/me via bootstrapSsoAuth(), not a blind trust', async () => {
    const store = installFakeBrowser('')
    store.set('qt_ems_token', 'returning-user-token')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: ['sales.update'] }),
    })
    ;(globalThis as any).fetch = fetchMock

    const api = await freshApi()
    // Before verification: token is present, but nothing has confirmed it
    // is still valid, and the stale permissions snapshot from last time
    // (none set here) must not be assumed correct either.
    const ok = await api.bootstrapSsoAuth()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/auth/me')
    expect(init?.headers?.Authorization).toBe('Bearer returning-user-token')
    expect(ok).toBe(true)
    expect(api.hasPermission('sales.update')).toBe(true)
  })

  it('a revoked/expired stored token (401) clears the session instead of leaving stale access', async () => {
    const store = installFakeBrowser('')
    store.set('qt_ems_token', 'revoked-token')
    store.set('qt_ems_permissions', JSON.stringify(['sales.update', 'sales.approve']))
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Unauthorized' }),
    })

    const api = await freshApi()
    const ok = await api.bootstrapSsoAuth()

    expect(ok).toBe(false)
    expect(api.getToken()).toBeNull()
    expect(api.getPermissions()).toEqual([])
    expect(api.hasPermission('sales.update')).toBe(false)
  })

  it('a network error (not a real rejection) leaves the existing session in place rather than signing out on inconclusive evidence', async () => {
    const store = installFakeBrowser('')
    store.set('qt_ems_token', 'returning-user-token')
    store.set('qt_ems_permissions', JSON.stringify(['sales.read']))
    ;(globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('network down'))

    const api = await freshApi()
    const ok = await api.bootstrapSsoAuth()

    expect(ok).toBe(true)
    expect(api.getToken()).toBe('returning-user-token')
    expect(api.getPermissions()).toEqual(['sales.read'])
  })

  it('permissions revoked server-side (e.g. role changed) are reflected on the next verification, not just additions', async () => {
    const store = installFakeBrowser('')
    store.set('qt_ems_token', 'admin-token')
    store.set('qt_ems_permissions', JSON.stringify(['sales.update', 'sales.approve', 'sales.revise']))
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: ['sales.read'] }),
    })

    const api = await freshApi()
    await api.bootstrapSsoAuth()

    expect(api.hasPermission('sales.update')).toBe(false)
    expect(api.hasPermission('sales.revise')).toBe(false)
    expect(api.hasPermission('sales.read')).toBe(true)
  })

  it('a fragment token still takes priority over an existing stored token (fragment wins; this is a brand-new/switched account arriving)', async () => {
    const store = installFakeBrowser('#sso=new-account-jwt')
    store.set('qt_ems_token', 'old-account-token')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: ['sales.read'] }),
    })
    ;(globalThis as any).fetch = fetchMock

    const api = await freshApi()
    await api.bootstrapSsoAuth()

    const [, init] = fetchMock.mock.calls[0]
    expect(init?.headers?.Authorization).toBe('Bearer new-account-jwt')
    expect(api.getToken()).toBe('new-account-jwt')
  })

  it('no stored token and no fragment still falls through to the cookie-based bridge (attemptSsoHydrate), unaffected by this round', async () => {
    installFakeBrowser('')
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 })
    ;(globalThis as any).fetch = fetchMock

    const api = await freshApi()
    const ok = await api.bootstrapSsoAuth()

    expect(ok).toBe(false)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/auth/sso')
    expect(init?.credentials).toBe('include')
  })
})
