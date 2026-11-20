import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  attemptSsoHydrate,
  clearSession,
  getPermissions,
  getToken,
  hasPermission,
  setPermissions,
  setToken,
} from './api'

// claude_prompt.txt ("v185 -- Fix SSO Fragment Authentication & Permission
// Hydration"), Required Tests 6-7: these two flows were unchanged by that
// round's fix (LoginScreen.tsx and attemptSsoHydrate() itself had no code
// changes) -- this file was regression coverage confirming they still
// behaved as before, run alongside api.ssoFragment.test.ts's own coverage
// of the fragment path that round actually changed.
//
// claude_prompt.txt ("v189 -- Unified EMS & Quotation Authentication"):
// api.login() itself DID change this round (see the new describe block
// below) -- confirmed live against the real ems-backend that the
// previous `{ email, password }` body was always rejected with a 400
// before AuthService.login() ever ran, since auth/dto/login.dto.ts only
// ever declared `username`. The two describe blocks below are kept
// separate: "the request now sends username" (new, v189) vs. "permission
// hydration from whatever the response contains" (unchanged since v185).

describe('Manual Login request contract (v189)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (globalThis as any).fetch
  })

  it('sends { username, password } to /auth/login, not { email, password }', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: 't', permissions: [] }),
    })
    ;(globalThis as any).fetch = fetchMock

    await api.login('jane.doe', 'secret')

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/auth/login')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ username: 'jane.doe', password: 'secret' })
    expect(body.email).toBeUndefined()
    expect(init.credentials).toBe('include')
  })
})

describe('Manual Login permission hydration (unchanged since v185, #6)', () => {
  beforeEach(() => {
    clearSession()
  })

  it('hydrates permissions from the login response, the same way LoginScreen.tsx does', () => {
    // Mirrors LoginScreen.tsx's handleSubmit exactly: setToken + setPermissions
    // from the login API response, nothing else.
    const result = { accessToken: 'manual-login-token', permissions: ['sales.update', 'sales.read'] }
    setToken(result.accessToken)
    setPermissions(result.permissions)

    expect(getToken()).toBe('manual-login-token')
    expect(hasPermission('sales.update')).toBe(true)
  })

  it('a user without sales.update logging in manually does not get Edit access', () => {
    setToken('viewer-token')
    setPermissions(['sales.read'])

    expect(hasPermission('sales.update')).toBe(false)
  })
})

describe('SSO Cookie hydration (unchanged, #7)', () => {
  beforeEach(() => {
    clearSession()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (globalThis as any).fetch
  })

  it('a valid shared session cookie hydrates token + permissions via GET /auth/sso', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: 'cookie-token', permissions: ['sales.update'] }),
    })
    ;(globalThis as any).fetch = fetchMock

    const ok = await attemptSsoHydrate()

    expect(ok).toBe(true)
    expect(getToken()).toBe('cookie-token')
    expect(hasPermission('sales.update')).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/auth/sso')
    expect(init?.credentials).toBe('include')
  })

  it('no valid session cookie (401) resolves false without throwing', async () => {
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 })

    const ok = await attemptSsoHydrate()

    expect(ok).toBe(false)
    expect(getToken()).toBeNull()
    expect(getPermissions()).toEqual([])
  })

  it('does not call /auth/sso at all when a token is already present', async () => {
    setToken('already-logged-in')
    const fetchMock = vi.fn()
    ;(globalThis as any).fetch = fetchMock

    const ok = await attemptSsoHydrate()

    expect(ok).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
