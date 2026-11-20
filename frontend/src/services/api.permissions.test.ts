import { describe, it, expect } from 'vitest'
import { getPermissions, getToken, setPermissions, setToken, hasPermission, clearSession } from './api'

// Implement -- Quotation Permissions & Accepted Immutability, §7: focused
// tests for the new permission-capture/check helpers only (the login
// response's `permissions` array was previously received and discarded
// entirely by this file). Not a security boundary on its own -- these are
// the UX-gating helpers QuotationView/QuotationList use to show/hide
// controls; the backend remains authoritative regardless of what this
// returns. sessionStorage access inside setPermissions/getPermissions is
// already wrapped in try/catch (same pattern as the existing token
// storage), so this runs fine under vitest's default (non-jsdom) node
// environment -- the in-memory value still works even if the
// sessionStorage mirror silently no-ops.

describe('permissions helpers', () => {
  it('hasPermission is false for anything before any permissions are set', () => {
    setPermissions(undefined)
    expect(hasPermission('sales.approve')).toBe(false)
  })

  it('setPermissions(undefined) resets to an empty list (e.g. on 401/logout)', () => {
    setPermissions(['sales.update', 'sales.approve'])
    expect(getPermissions()).toEqual(['sales.update', 'sales.approve'])
    setPermissions(undefined)
    expect(getPermissions()).toEqual([])
    expect(hasPermission('sales.update')).toBe(false)
  })

  it('hasPermission reflects exactly the codes captured from the login/SSO response', () => {
    setPermissions(['sales.create', 'sales.update'])
    expect(hasPermission('sales.create')).toBe(true)
    expect(hasPermission('sales.update')).toBe(true)
    expect(hasPermission('sales.approve')).toBe(false)
    expect(hasPermission('sales.revise')).toBe(false)
  })

  it('a user with sales.approve but not sales.update is reflected correctly', () => {
    setPermissions(['sales.approve'])
    expect(hasPermission('sales.approve')).toBe(true)
    expect(hasPermission('sales.update')).toBe(false)
  })

  // v179: App.tsx's logout handler cleared only the token, leaving the
  // previous account's permissions in memory/sessionStorage -- the one
  // asymmetric call site among every place that sets a token. clearSession()
  // is the shared fix (also now used by the 401 handler, which already did
  // this correctly); this locks both call sites to clear together.
  it('clearSession() clears both the token and permissions together', () => {
    setToken('some-token')
    setPermissions(['sales.update', 'sales.approve'])
    clearSession()
    expect(getToken()).toBeNull()
    expect(getPermissions()).toEqual([])
    expect(hasPermission('sales.update')).toBe(false)
  })

  it('a session cleared by clearSession() cannot leak into a subsequent failed login', () => {
    setToken('account-a-token')
    setPermissions(['sales.approve'])
    clearSession()
    // simulates a failed login attempt for a different account: neither
    // setToken nor setPermissions is called on the error path (LoginScreen's
    // catch block), so whatever clearSession() left in place must already
    // be empty -- not account A's stale permissions.
    expect(getPermissions()).toEqual([])
    expect(hasPermission('sales.approve')).toBe(false)
  })
})
