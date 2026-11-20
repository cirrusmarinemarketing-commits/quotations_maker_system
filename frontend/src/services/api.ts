export type ApiMode = 'legacy' | 'ems'

export type Company = {
  id: string
  name: string
  code: string
  isActive: boolean
}

export const API_MODE: ApiMode =
  (import.meta.env.VITE_API_MODE as string | undefined) === 'ems' ? 'ems' : 'legacy'

function currentOriginBase(port: number): string {
  if (typeof window === 'undefined') return `http://localhost:${port}`
  return `${window.location.protocol}//${window.location.hostname}:${port}`
}

const LEGACY_BASE =
  (import.meta.env.VITE_API_URL as string | undefined) || `${currentOriginBase(4500)}/api/inventory`

const EMS_ROOT = (import.meta.env.VITE_EMS_API_URL as string | undefined) || currentOriginBase(3000)
const EMS_BASE = `${EMS_ROOT}/api/v1/ems`

export const EMS_FRONTEND_URL =
  (import.meta.env.VITE_EMS_FRONTEND_URL as string | undefined) || currentOriginBase(5174)

const TOKEN_KEY = 'qt_ems_token'
const PERMISSIONS_KEY = 'qt_ems_permissions'

function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

function readStoredPermissions(): string[] {
  try {
    const raw = sessionStorage.getItem(PERMISSIONS_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function consumeSsoFragmentToken(): string | null {
  if (typeof window === 'undefined') return null

  const hash = window.location.hash
  if (!hash.startsWith('#sso=')) return null

  window.history.replaceState(null, '', window.location.pathname + window.location.search)

  const raw = hash.slice('#sso='.length)
  return raw ? decodeURIComponent(raw) : null
}

const ssoToken = API_MODE === 'ems' ? consumeSsoFragmentToken() : null

// claude_prompt.txt ("v185 -- Fix SSO Fragment Authentication & Permission
// Hydration"): a fragment token means a (possibly different) account is
// arriving fresh -- any permissions already sitting in this tab's
// sessionStorage belong to whichever session was here before and must
// never be trusted for the incoming one. Cleared synchronously, before
// `permissions` below ever reads storage.
if (ssoToken) {
  try {
    sessionStorage.removeItem(PERMISSIONS_KEY)
  } catch {
    // sessionStorage unavailable -- nothing to clear.
  }
}

// True from module load until hydrateFromSsoFragmentToken() below actually
// runs. While true, `token` may already be set (from the fragment) but has
// NOT been validated against the backend yet -- callers (App.tsx) must not
// treat the tab as logged in purely because getToken() is non-null.
let fragmentHydrationPending = !!ssoToken

let token: string | null = ssoToken ?? (API_MODE === 'ems' ? readStoredToken() : null)

if (ssoToken) {
  try {
    sessionStorage.setItem(TOKEN_KEY, ssoToken)
  } catch {
    // sessionStorage unavailable (private mode, etc.) -- the in-memory
    // token still works for the rest of this tab's session.
  }
}

export function getToken(): string | null {
  return token
}

export function setToken(next: string | null): void {
  token = next
  try {
    if (next) sessionStorage.setItem(TOKEN_KEY, next)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // sessionStorage unavailable (private mode, etc.) -- the in-memory
    // token still works for the rest of this tab's session.
  }
}

// claude_prompt.txt ("v185"): true only until a fragment-delivered token
// has actually been checked against GET /auth/me. App.tsx reads this (via
// hasPendingFragmentAuth()) alongside getToken() to decide whether it's
// safe to treat the tab as logged in, instead of trusting a token's mere
// presence.
export function hasPendingFragmentAuth(): boolean {
  return fragmentHydrationPending
}

// Implement -- Quotation Permissions & Accepted Immutability, §7: the
// login/SSO response already carries a `permissions` array (ems-backend's
// SessionResult) -- this file previously discarded it entirely. Same
// module-level-variable + sessionStorage-mirror shape as the token above,
// for the same reason (survives this tab's own re-renders without a
// context provider, consistent with how this file already handles the
// token -- not a new authorization architecture, just the one array this
// app already receives and never stored).
let permissions: string[] = API_MODE === 'ems' ? readStoredPermissions() : []

export function getPermissions(): string[] {
  return permissions
}

export function setPermissions(next: string[] | undefined): void {
  permissions = next ?? []
  try {
    sessionStorage.setItem(PERMISSIONS_KEY, JSON.stringify(permissions))
  } catch {
    // sessionStorage unavailable -- the in-memory value still works for
    // the rest of this tab's session.
  }
}

// UX-only convenience, used to show/hide/disable controls. Never a
// security boundary on its own -- every permission this checks is
// re-enforced server-side regardless of what this returns.
export function hasPermission(code: string): boolean {
  return permissions.includes(code)
}

// v179: the one place this file already cleared both token and permissions
// together was the 401 handler below -- App.tsx's logout button cleared
// only the token, leaving the previous account's permissions in memory and
// in sessionStorage. Shared helper so the two can't drift apart again.
export function clearSession(): void {
  setToken(null)
  setPermissions(undefined)
}

// claude_prompt.txt ("SSO: opening a direct link to another app asks for
// login again"): sessionStorage (used above) is per-tab even within the
// same origin -- a direct/bookmarked/pasted visit, or a plain new tab,
// never has it, fragment or not. Callers (App.tsx, CostAndProfitPage.tsx)
// call this once on boot when getToken() is still null: it asks
// ems-backend's GET /auth/sso whether the browser holds a valid shared
// session cookie (verified server-side there, never trusted client-side
// here), and on success stores the SAME real access token this file's
// normal login path already stores, through the exact same setToken() --
// no new token format, no new login method. Resolves to whether it found
// one; never throws.
export async function attemptSsoHydrate(): Promise<boolean> {
  if (API_MODE !== 'ems' || token) return !!token
  try {
    const response = await fetch(`${EMS_BASE}/auth/sso`, { credentials: 'include' })
    if (!response.ok) return false
    const result = (await response.json()) as LoginResult
    setToken(result.accessToken)
    setPermissions(result.permissions)
    return true
  } catch {
    return false
  }
}

export type MeResult = {
  user?: { id: string; name?: string; email?: string }
  roles?: string[]
  permissions?: string[]
}

// claude_prompt.txt ("v185 -- Fix SSO Fragment Authentication & Permission
// Hydration"): the SSO Fragment handoff's own hydration -- separate from
// attemptSsoHydrate() above (the *cookie* path, for a direct/bookmarked
// visit with no fragment and no token yet). A fragment token already came
// with a real JWT, so this calls GET /auth/me with it as a Bearer header
// -- the contract that actually accepts one; /auth/sso does not and
// returns 401 for a Bearer-only caller with no session cookie. Resolves
// true only once both authentication AND permission hydration succeed;
// never throws. Single-shot: fragmentHydrationPending is cleared before
// the request so a remount/retry can't re-fire it or loop.
export async function hydrateFromSsoFragmentToken(): Promise<boolean> {
  if (API_MODE !== 'ems' || !fragmentHydrationPending) return false
  fragmentHydrationPending = false

  try {
    const result = await request<MeResult>(`${EMS_BASE}/auth/me`)
    setPermissions(result.permissions)
    return true
  } catch {
    clearSession()
    return false
  }
}

// claude_prompt.txt ("v189 -- Unified EMS & Quotation Authentication /
// Shared Login Session"): a token already sitting in sessionStorage from
// an earlier visit to THIS tab was never re-checked against the backend
// on a plain refresh -- `token` being non-null was treated as sufficient
// on its own, with permission hydration (and session revocation) only
// ever discovered lazily, on whatever the next real API call happened to
// be. ems-frontend's own equivalent (current-user.tsx's hydrate effect)
// always calls GET /auth/me when a local token exists, every mount, for
// exactly this reason -- this brings that same discipline here, closing
// the gap "verify that stale frontend state cannot grant access" calls
// out directly. On an actual rejection, request()'s own generic 401
// handling has already cleared the session before this function's catch
// runs (clearSession() + unauthorizedHandler()), so `token` is correctly
// null by the time this resolves; on a network/timeout failure (never
// reached the server), nothing was cleared and the existing session is
// left in place rather than signed out on inconclusive evidence.
async function verifyExistingSession(): Promise<boolean> {
  try {
    const result = await request<MeResult>(`${EMS_BASE}/auth/me`)
    setPermissions(result.permissions)
    return true
  } catch {
    return !!token
  }
}

let bootstrapPromise: Promise<boolean> | null = null

// claude_prompt.txt ("v185", extended "v189"): the one entry point
// App.tsx's boot effect calls, now covering all three possible startup
// states uniformly: a fragment token (hydrateFromSsoFragmentToken), an
// existing stored token (verifyExistingSession, new this round), or
// neither (attemptSsoHydrate, the cookie-based bridge). Branches on
// `ssoToken`/`token` -- values fixed at module load or only mutated
// synchronously before this function's first await -- rather than on a
// flag read fresh per call, for the same StrictMode-safety reason as
// before: React's dev-only mount -> cleanup -> mount double-invoke of the
// calling effect must always observe the identical decision, never a
// different bootstrap racing the one already in flight. Memoizing the
// resulting promise means every invocation (StrictMode's extra one
// included) always awaits the exact same bootstrap, so at most one
// network call ever happens for a given tab load either way.
export function bootstrapSsoAuth(): Promise<boolean> {
  if (API_MODE !== 'ems') return Promise.resolve(true)
  if (!bootstrapPromise) {
    bootstrapPromise = ssoToken
      ? hydrateFromSsoFragmentToken()
      : token
        ? verifyExistingSession()
        : attemptSsoHydrate()
  }
  return bootstrapPromise
}

// claude_prompt.txt ("SSO: opening a direct link to another app asks for
// login again"): logout must also clear the shared cookie server-side --
// otherwise the next direct visit here (or to any other app sharing this
// login) would silently sign back in via attemptSsoHydrate() moments
// later. Best-effort: the caller clears its own local token regardless of
// whether this resolves.
//
// claude_prompt.txt ("v189 -- Unified EMS & Quotation Authentication /
// Shared Login Session"): now also sends the Bearer token (via
// authHeaders(), not just the cookie) -- the backend's /auth/logout
// identifies the caller from whichever is present to invalidate that
// account's sessions server-side (see ems-backend's
// AuthController.logout()), and the cookie alone wouldn't exist for a
// tab that only ever held a token (e.g. arrived via the `#sso=` fragment
// in an environment where the cookie didn't make it across). `keepalive`
// lets the request actually complete even though the caller
// (App.tsx's handleLogout) navigates away immediately afterward.
export async function logoutSso(): Promise<void> {
  if (API_MODE !== 'ems') return
  try {
    await fetch(`${EMS_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: authHeaders(),
    })
  } catch {
    // best-effort
  }
}

let unauthorizedHandler: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn
}

function authHeaders(): Record<string, string> {
  if (API_MODE !== 'ems' || !token) return {}
  return { Authorization: `Bearer ${token}` }
}

type ErrorBody = { error?: string; message?: string | string[] }

async function readableError(response: Response): Promise<string> {
  let body: ErrorBody | null = null

  try {
    body = await response.json()
  } catch {
    // no JSON body -- fall through to the status-based messages below
  }

  if (body?.message) {
    return Array.isArray(body.message) ? body.message.join('; ') : body.message
  }

  if (body?.error) return body.error

  if (response.status === 401) return 'Your session has expired — please log in again.'
  if (response.status === 403) return 'You do not have permission to do this.'

  return `Request failed (${response.status})`
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response

  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
        ...init?.headers,
      },
    })
  } catch {
    throw new Error('Network error — check your connection and try again.')
  }

  if (!response.ok) {
    const message = await readableError(response)

    if (response.status === 401 && API_MODE === 'ems') {
      clearSession()
      unauthorizedHandler?.()
    }

    throw new Error(message)
  }

  if (response.status === 204) return undefined as T

  return (await response.json()) as T
}

function quotationsUrl(suffix = ''): string {
  return API_MODE === 'ems' ? `${EMS_BASE}/sales/quotations${suffix}` : `${LEGACY_BASE}/quotations${suffix}`
}

function itemsUrl(suffix = ''): string {
  return API_MODE === 'ems' ? `${EMS_BASE}/sales/quotations/items${suffix}` : `${LEGACY_BASE}/items${suffix}`
}

function clientsUrl(): string {
  return `${EMS_BASE}/sales/quotations/clients`
}

function companiesUrl(): string {
  return `${EMS_BASE}/inventory/companies`
}

function unitsUrl(): string {
  return API_MODE === 'ems' ? `${EMS_BASE}/inventory/units` : `${LEGACY_BASE}/units`
}

function projectsUrl(): string {
  return API_MODE === 'ems' ? `${EMS_BASE}/projects` : `${LEGACY_BASE}/quotations/projects`
}

function exchangeRateUrl(date: string): string {
  return `${EMS_BASE}/exchange-rate?date=${encodeURIComponent(date)}`
}

export type LoginResult = {
  accessToken: string
  user?: { id: string; name?: string; email?: string }
  permissions?: string[]
}

// Cost & Profit report (claude_prompt.txt) -- mirrors
// ems-backend's cost-profit-calculator.ts output shape exactly.

// claude_prompt.txt ("Cost & Profit report: list quotations of every
// status, count only accepted ones in all totals"): the real, full
// `sales.quotation_status` enum (ems-backend's QuotationStatusFilter,
// read from the live DB catalog) -- was 'accepted' | 'sent'.
export type QuotationStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired'

export type CostProfitTotals = {
  // claude_prompt.txt (this round, "revenue = stored total due"): no longer
  // computed from lines -- at quotation level this is simply the stored
  // `sales.quotations.total` (nullable: a quotation with no stored total
  // shows "--" and is excluded from sums, but still listed). At project/
  // grand level this is the plain sum of member quotations' revenue
  // (null treated as a 0 contribution), so it's never null there in
  // practice. `revenueCostedIncVat` is gone -- there is no "line-costed
  // revenue" concept any more (profit = revenue - cost directly).
  revenueIncVat: number | null
  // Total cost = Σ costed part/stock cost + Σ shipping cost + Σ import tax
  // -- unchanged from the prior round.
  costQuoted: number
  costBank: number
  // claude_prompt.txt: "profit = revenue (stored total) - cost" -- null
  // whenever revenue is null (no replacement computation).
  profitQuoted: number | null
  profitBank: number | null
  // claude_prompt.txt ("Cost & Profit report: list quotations of every
  // status, count only accepted ones in all totals"): widened to `| null`
  // -- at project/grand level, null when no accepted quotation
  // contributed to this bucket (decision 5: "--", not 0.00).
  bufferGain: number | null
  linesWithoutCost: number
  // claude_prompt.txt (this round): informational only now -- shipping and
  // import tax ARE counted in revenue/cost/profit/margin above; these two
  // fields carry the subtotals the Revenue KPI sub-line needs.
  passThroughImportTax: number
  passThroughShipping: { cost: number; priceIncVat: number }
}
export type CostProfitLine = {
  kind: 'part' | 'stock' | 'shipping' | 'import_tax' | 'ctl' | 'discount'
  name: string
  qty: number
  unit: string | null
  unitCostFc: number | null
  markupPercent: number | null
  unitPriceIncVat: number | null
  // claude_prompt.txt (this round): renamed from `revenueExVat` -- always
  // the VAT-inclusive amount now. `passThrough` is gone -- shipping/import
  // tax rows are still grouped into the page's separate reference block,
  // but purely by `kind`, not by a numeric exclusion flag (they now count
  // in every total).
  revenueIncVat: number
  costQuoted: number | null
  costBank: number | null
  costKnown: boolean
  // claude_prompt.txt ("Cost & Profit report — shipping/import tax as
  // reference rows"): per-item import tax ('part' lines only; null for
  // 'stock' lines and every other kind, or when the lot has no import tax).
  importTaxAmount: number | null
  // claude_prompt.txt ("Cost & Profit report: export one quotation as
  // PDF"): per-unit THB cost ("Cost price THB Per Unit" PDF column),
  // 'part'/'stock' lines only, null otherwise.
  unitCostThb: number | null
}
export type CostProfitGroup = {
  kind: 'external' | 'stock' | 'other'
  groupId: string | null
  sourceName: string
  country: string | null
  sourceType: string | null
  currency: string | null
  exchangeRate: number | null
  actualExchangeRate: number | null
  bufferPercent: number | null
  exchangeRateDate: string | null
  bankRateMissing: boolean
  // claude_prompt.txt ("Cost & Profit report — shipping/import tax as
  // reference rows"): raw transfer fee (THB) -- used to build the
  // reference block's shipping sub-text without re-parsing the line name.
  transferFee: number | null
  lines: CostProfitLine[]
}
// claude_prompt.txt ("Cost & Profit report display improvements"): null
// when there is no discount on this quotation.
export type CostProfitDiscount = { amountIncVat: number; percentOfPartsSubtotal: number } | null

// claude_prompt.txt ("... discount-price table, Excel basis"): "what if
// this quotation's items AND shipping were discounted d%, Excel-style" --
// always present now (previously null when the quotation had its own
// discount; this round's text makes it always present, based on prices
// BEFORE the quotation's own discount, as in Excel).
export type CostProfitDiscountScenario = {
  discountPercent: number
  totalPriceIncVat: number
  profit: number
  profitExcelBasis: number
  margin: number
  // claude_prompt.txt ("Cost & Profit report: two totals, numbers equal to
  // the Excel sheet"): additive fields for the discount table's new
  // columns -- Quotation total = revenue + shipping charged + import tax
  // (import tax undiscounted); Revenue = goods price x (1-d); Cost is the
  // quotation's own two-totals Cost, constant across every row, carried in
  // both basis variants here (unlike the five fields above, which stay
  // quoted-basis-only, unchanged).
  quotationTotal: number
  revenue: number
  costQuoted: number
  costBank: number
  profitQuoted: number
  profitBank: number
  marginQuoted: number
  marginBank: number
}

// claude_prompt.txt ("... two totals"): the report page's own
// Quotation-total/Revenue/Cost/Profit bundle -- kept separate from
// CostProfitTotals (which the dashboard reads unchanged) so this page can
// show its own two totals without affecting the dashboard's numbers.
// claude_prompt.txt ("Cost & Profit report: list quotations of every
// status, count only accepted ones in all totals"): every field widened
// to `| null` -- at project/grand level, null when no accepted quotation
// contributed (decision 5: project header cells show "--"). At
// quotation level only `quotationTotal` is ever actually null in
// practice (unchanged); the wider type just lets the same type serve
// both levels.
export type CostProfitTwoTotals = {
  quotationTotal: number | null
  revenue: number | null
  costQuoted: number | null
  costBank: number | null
  profitQuoted: number | null
  profitBank: number | null
}

export type CostProfitQuotation = {
  id: string
  number: string
  // claude_prompt.txt ("Cost & Profit report: export one quotation as
  // PDF"): straight pass-through of `sales.quotations.description`.
  description: string | null
  // claude_prompt.txt ("Cost & Profit PDF export: fixes"), rule 3: new
  // read-only field -- straight pass-through of `sales.quotations.issue_date`.
  // Used by the PDF's top-right header (fix 3); NOT the same as statusDate
  // below (accepted_at/sent_at-derived, unchanged).
  issueDate: string
  // claude_prompt.txt ("Cost & Profit PDF: header date = the quotation's
  // updated date"): new read-only field -- Bangkok calendar date (YYYY-MM-DD)
  // of `sales.quotations.updated_at`. The PDF header's "Date:" now reads
  // this instead of issueDate (which stays on the response, unused by that
  // one spot from now on).
  updatedAt: string | null
  status: QuotationStatus
  statusDate: string
  statusDateEstimated: boolean
  totals: CostProfitTotals
  twoTotals: CostProfitTwoTotals
  // claude_prompt.txt: "keep reconcile exactly as it is" -- unchanged in
  // meaning; widened to `| null` since the stored total it compares
  // against can itself be null.
  reconcile: { headerTotal: number | null; computedIncVat: number; diff: number | null }
  discount: CostProfitDiscount
  // claude_prompt.txt ("show the discount percentage..."): straight
  // pass-through of the stored `discount_value` column -- never reused
  // from, or merged into, `discount.percentOfPartsSubtotal` above (that
  // stays a derived figure; this is the raw stored percent, read as-is).
  discountPercent: number | null
  discountScenarios: CostProfitDiscountScenario[]
  // claude_prompt.txt ("... Excel basis"): total selling price inc. VAT
  // (items + shipping, before the quotation's own discount) minus total
  // cost (items + shipping cost). Import tax excluded. Two variants,
  // mirroring totals.profitQuoted/profitBank, so the page's existing
  // Quoted/Bank toggle drives this card the same way it drives Profit.
  profitExcelBasisQuoted: number
  profitExcelBasisBank: number
  groups: CostProfitGroup[]
}
export type CostProfitProject = {
  projectId: string | null
  name: string
  clientName: string
  totals: CostProfitTotals
  twoTotals: CostProfitTwoTotals
  profitExcelBasisQuoted: number
  profitExcelBasisBank: number
  quotations: CostProfitQuotation[]
}
export type CostProfitReport = {
  month: string
  statuses: QuotationStatus[]
  totals: CostProfitTotals
  twoTotals: CostProfitTwoTotals
  profitExcelBasisQuoted: number
  profitExcelBasisBank: number
  projects: CostProfitProject[]
}

// claude_prompt.txt ("... monthly Dashboard"), 1.2 -- mirrors
// ems-backend's cost-profit-calculator.ts MonthlyCostProfitReport exactly.
export type CostProfitMonthlySummary = {
  month: string
  quotationCount: number
  revenue: number
  cost: number
  profit: number
  margin: number | null
}
export type CostProfitMonthlyProjectSummary = {
  projectName: string
  revenue: number
  cost: number
  profit: number
  margin: number | null
}
export type CostProfitMonthlyReport = {
  month: string
  months: CostProfitMonthlySummary[]
  averageMargin: number | null
  previousMonthMargin: number | null
  projects: CostProfitMonthlyProjectSummary[]
}

export const api = {
  mode: API_MODE,

  listQuotations: (): Promise<unknown[]> => request(quotationsUrl()),

  getQuotation: (id: string): Promise<unknown> => request(quotationsUrl(`/${id}`)),

  createQuotation: (payload: unknown): Promise<{ id: string; number: string; status: string }> =>
    request(quotationsUrl(), { method: 'POST', body: JSON.stringify(payload) }),

  updateQuotation: (id: string, payload: unknown): Promise<{ id: string; number: string; status: string }> =>
    request(quotationsUrl(`/${id}`), { method: 'PUT', body: JSON.stringify(payload) }),

  updateQuotationStatus: (id: string, status: string): Promise<{ quotation: { status: string } }> =>
    request(quotationsUrl(`/${id}/status`), { method: 'PATCH', body: JSON.stringify({ status }) }),

  // claude_prompt.txt ("v186 -- Quotation Authorization & Editing Workflow
  // Refactor"): the only way to change a non-Draft quotation's data --
  // creates a brand-new Draft copy server-side (QuotationService.
  // createRevision, gated by sales.revise there); no request body, the
  // source id and the authenticated caller are all the backend needs.
  createRevision: (id: string): Promise<{ id: string; number: string; status: string; revisedFromId: string }> =>
    request(quotationsUrl(`/${id}/revisions`), { method: 'POST' }),

  listItems: (): Promise<unknown[]> => request(itemsUrl()),

  getItem: (id: string): Promise<unknown> => request(itemsUrl(`/${id}`)),

  listUnits: (): Promise<unknown[]> => request(unitsUrl()),

  listProjects: (): Promise<unknown[]> => request(projectsUrl()),

  listClients: (): Promise<unknown[]> => request(clientsUrl()),
  listCompanies: (): Promise<Company[]> => request(companiesUrl()),

  listExchangeRates: (date: string): Promise<unknown[]> => request(exchangeRateUrl(date)),

  // claude_prompt.txt ("v189 -- Unified EMS & Quotation Authentication"):
  // `username`, not `email` -- confirmed live against the running
  // ems-backend (apps/ems-api/src/modules/auth/dto/login.dto.ts has no
  // `email` field at all, only `username`/`password`; main.ts's global
  // ValidationPipe is `whitelist: true, forbidNonWhitelisted: true`) that
  // sending `{ email, password }` here has always been rejected with a
  // 400 ("property email should not exist") before ever reaching
  // AuthService.login()'s credential check -- this app's manual login had
  // been completely broken, not just differently labeled. ems-frontend's
  // own login() (api/auth.ts) already sends `{ username, password }` to
  // this exact endpoint; this now matches it exactly, including the field
  // name, so both apps authenticate the same account the same way.
  // `credentials: 'include'` (unchanged) is what lets this response's
  // Set-Cookie actually land -- see ems-backend's AuthController.login().
  login: (username: string, password: string): Promise<LoginResult> =>
    request(`${EMS_BASE}/auth/login`, { method: 'POST', body: JSON.stringify({ username, password }), credentials: 'include' }),

  getCostProfit: (month: string, statuses: QuotationStatus[]): Promise<CostProfitReport> =>
    request(`${EMS_BASE}/sales/reports/cost-profit?month=${encodeURIComponent(month)}&statuses=${statuses.join(',')}`),

  getCostProfitMonthly: (month: string, months = 7): Promise<CostProfitMonthlyReport> =>
    request(`${EMS_BASE}/sales/reports/cost-profit/monthly?month=${encodeURIComponent(month)}&months=${months}`),
}
