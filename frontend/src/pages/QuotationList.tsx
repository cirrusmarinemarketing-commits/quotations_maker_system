import { useEffect, useMemo, useState } from 'react'
import { api, hasPermission, type Company } from '../services/api'
import { getCreatedByName } from './quotationListHelpers'
import './QuotationList.css'

type Quotation = {
  id: string
  number: string
  company_id?: string | null
  companyId?: string | null
  customerName?: string | null
  customer_name?: string | null
  projectName?: string | null
  project_name?: string | null
  description?: string | null
  issueDate?: string
  issue_date?: string
  validUntil?: string | null
  valid_until?: string | null
  status: string
  currency?: string
  total: string | number
  created_by_name?: string | null
}

type QuotationListProps = {
  onView: (quotationId: string) => void
  onCreate?: () => void
  // claude_prompt.txt ("v186 -- Quotation Authorization & Editing Workflow
  // Refactor"): lets this list's own Revise action land directly in the
  // new Draft's edit form, the same way QuotationView's Revise already
  // does -- optional so existing callers that only pass onView keep
  // working (Revise simply falls back to onView for those).
  onEdit?: (quotationId: string) => void
}

const STATUS_OPTIONS = [
  { value: 'all', label: 'All Status' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'expired', label: 'Expired' },
]

function formatDate(value?: string | null) {
  if (!value) return '-'

  const dateValue = value.slice(0, 10)
  const [year, month, day] = dateValue.split('-').map(Number)

  if (!year || !month || !day) return '-'

  return new Date(year, month - 1, day).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

function formatMoney(value: string | number, currency = 'THB') {
  const amount = Number(value || 0)

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

function getCustomerName(quotation: Quotation) {
  return quotation.customerName || quotation.customer_name || 'No customer'
}

function getProjectName(quotation: Quotation) {
  return quotation.projectName || quotation.project_name || '-'
}

function getJobDescription(quotation: Quotation) {
  return quotation.description || '-'
}

function getIssueDate(quotation: Quotation) {
  return quotation.issueDate || quotation.issue_date
}

function getValidUntil(quotation: Quotation) {
  return quotation.validUntil || quotation.valid_until
}

function getStatusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function getCompanyCode(
  quotation: Quotation,
  companies: Company[],
) {
  const companyId = quotation.company_id || quotation.companyId
  const company = companies.find((item) => item.id === companyId)

  return company?.code?.toUpperCase() || '-'
}

// claude_prompt.txt ("Restyle the Quotation List page ... and make Cost &
// Profit open the specific quotation"), Part B: /cost-and-profit only ever
// fetches one month at a time, so the link must carry both this
// quotation's real id (the same identifier onView/onEdit already use, not
// its display `number`) and the month its issueDate falls in -- that page
// has no way to search across months on its own. With no issue date (should
// not happen in practice), falls back to the plain overview link rather
// than guessing a month.
function getCostProfitHref(quotation: Quotation): string {
  const issueDate = getIssueDate(quotation)
  const month = issueDate ? issueDate.slice(0, 7) : null

  if (!month) return '/cost-and-profit'

  return `/cost-and-profit?quotationId=${encodeURIComponent(quotation.id)}&month=${encodeURIComponent(month)}`
}

function QuotationList({ onView, onCreate, onEdit }: QuotationListProps) {
  const [quotations, setQuotations] = useState<Quotation[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [companyFilter, setCompanyFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  // claude_prompt.txt ("v186"): Revise is its own per-row async action,
  // separate from updatingId (status-change) above.
  const [revisingId, setRevisingId] = useState<string | null>(null)
  const [reviseError, setReviseError] = useState('')
  // claude_prompt.txt ("Investigate and fix -- Company filter ... cannot be
  // selected"): diagnostic only, not a confirmed fix for an unconfirmed
  // cause (see progress_log_v2.md for the full investigation). loadCompanies()
  // previously swallowed a failed fetch with only a console.error -- unlike
  // loadQuotations() right above it, which already surfaces its own
  // failures via `error`. If the real cause of the reported symptom turns
  // out to be a failed/forbidden request (not yet confirmed either way),
  // this makes it visible instead of silently leaving the filter showing
  // only "All Companies".
  const [companiesError, setCompaniesError] = useState('')

  const loadQuotations = async () => {
    setLoading(true)
    setError('')

    try {
      const result = (await api.listQuotations()) as unknown

      const rows = Array.isArray(result)
        ? result
        : Array.isArray((result as { quotations?: unknown })?.quotations)
          ? (result as { quotations: Quotation[] }).quotations
          : []

      setQuotations(rows as Quotation[])
    } catch (err) {
      console.error('Failed to load quotations:', err)
      setError(err instanceof Error ? err.message : 'Failed to load quotations')
    } finally {
      setLoading(false)
    }
  }

  const loadCompanies = async () => {
    setCompaniesError('')

    try {
      const result = await api.listCompanies()
      setCompanies(result.filter((company) => company.isActive))
    } catch (err) {
      console.error('Failed to load companies:', err)
      setCompaniesError(err instanceof Error ? err.message : 'Failed to load companies')
    }
  }

  const updateStatus = async (quotationId: string, status: string) => {
    setUpdatingId(quotationId)
    setError('')

    try {
      const result = await api.updateQuotationStatus(quotationId, status)

      setQuotations((current) =>
        current.map((quotation) =>
          quotation.id === quotationId
            ? { ...quotation, status: result?.quotation?.status || status }
            : quotation,
        ),
      )
    } catch (err) {
      console.error('Failed to update quotation status:', err)
      setError(err instanceof Error ? err.message : 'Failed to update quotation status')
    } finally {
      setUpdatingId(null)
    }
  }

  // claude_prompt.txt ("v186"): the list's own Revise entry point -- same
  // backend call and same "navigate into the new Draft" behavior as
  // QuotationView's Revise button. The source quotation's row is untouched;
  // this list isn't re-fetched since the new Draft isn't shown here until
  // the user navigates back.
  const handleRevise = async (quotationId: string) => {
    setRevisingId(quotationId)
    setReviseError('')
    try {
      const result = await api.createRevision(quotationId)
      if (onEdit) onEdit(result.id)
      else onView(result.id)
    } catch (err) {
      console.error('Failed to create revision:', err)
      setReviseError(err instanceof Error ? err.message : 'Failed to create revision')
    } finally {
      setRevisingId(null)
    }
  }

  useEffect(() => {
    void loadQuotations()
    void loadCompanies()
  }, [])

  const companyFilteredQuotations = useMemo(() => {
    if (companyFilter === 'all') return quotations

    return quotations.filter(
      (quotation) =>
        (quotation.company_id || quotation.companyId) === companyFilter,
    )
  }, [quotations, companyFilter])

  const summary = useMemo(() => ({
    total: companyFilteredQuotations.length,
    draft: companyFilteredQuotations.filter((item) => item.status.toLowerCase() === 'draft').length,
    sent: companyFilteredQuotations.filter((item) => item.status.toLowerCase() === 'sent').length,
    accepted: companyFilteredQuotations.filter((item) => item.status.toLowerCase() === 'accepted').length,
    rejected: companyFilteredQuotations.filter((item) => item.status.toLowerCase() === 'rejected').length,
    expired: companyFilteredQuotations.filter((item) => item.status.toLowerCase() === 'expired').length,
  }), [companyFilteredQuotations])

  const filteredQuotations = useMemo(() => {
    const keyword = search.trim().toLowerCase()

    return companyFilteredQuotations.filter((quotation) => {
      const number = (quotation.number || '').toLowerCase()
      const customer = getCustomerName(quotation).toLowerCase()
      const project = getProjectName(quotation).toLowerCase()
      const description = getJobDescription(quotation).toLowerCase()

      const matchesSearch =
        !keyword ||
        number.includes(keyword) ||
        customer.includes(keyword) ||
        project.includes(keyword) ||
        description.includes(keyword)

      const matchesStatus =
        statusFilter === 'all' || quotation.status.toLowerCase() === statusFilter

      const issueDate = getIssueDate(quotation)?.slice(0, 10) || ''
      const validUntil = getValidUntil(quotation)?.slice(0, 10) || ''

      const matchesDate =
        (!dateFrom && !dateTo) ||
        [issueDate, validUntil].some((date) =>
          Boolean(date) &&
          (!dateFrom || date >= dateFrom) &&
          (!dateTo || date <= dateTo),
        )

      return matchesSearch && matchesStatus && matchesDate
    })
  }, [companyFilteredQuotations, search, statusFilter, dateFrom, dateTo])

  const clearDateFilters = () => {
    setDateFrom('')
    setDateTo('')
  }

  const clearFilters = () => {
    setSearch('')
    setCompanyFilter('all')
    setStatusFilter('all')
    clearDateFilters()
  }

  const hasFilters = Boolean(
    search.trim() ||
    companyFilter !== 'all' ||
    statusFilter !== 'all' ||
    dateFrom ||
    dateTo,
  )

  const selectedCompanyName = companies.find(
    (company) => company.id === companyFilter,
  )?.name

  return (
    <div className="quotation-list-page qt-list">
      <div className="quotation-list-header">
        <div>
          <div className="quotation-list-eyebrow">SALES</div>
          <h1>Quotations</h1>
          <p>
            Manage customer quotations and quotation status.
            {selectedCompanyName ? ` Company: ${selectedCompanyName}` : ''}
          </p>
        </div>

        <div className="quotation-list-header-actions">
          <button
            type="button"
            className="quotation-btn quotation-btn-secondary"
            onClick={() => {
              void loadQuotations()
              void loadCompanies()
            }}
            disabled={loading}
          >
            Refresh
          </button>

          {onCreate && (
            <button
              type="button"
              className="quotation-btn quotation-btn-primary"
              onClick={onCreate}
            >
              + New Quotation
            </button>
          )}
        </div>
      </div>

      <div className="quotation-stat-grid">
        <div className="quotation-stat-card qt-stat-total">
          <span>Total Quotations</span>
          <strong>{summary.total}</strong>
        </div>
        <div className="quotation-stat-card qt-stat-draft">
          <span>Draft</span>
          <strong>{summary.draft}</strong>
        </div>
        <div className="quotation-stat-card qt-stat-sent">
          <span>Sent</span>
          <strong>{summary.sent}</strong>
        </div>
        <div className="quotation-stat-card qt-stat-accepted">
          <span>Accepted</span>
          <strong>{summary.accepted}</strong>
        </div>
        <div className="quotation-stat-card quotation-stat-card-muted qt-stat-rejected">
          <span>Rejected</span>
          <strong>{summary.rejected}</strong>
        </div>
        <div className="quotation-stat-card quotation-stat-card-muted qt-stat-expired">
          <span>Expired</span>
          <strong>{summary.expired}</strong>
        </div>
      </div>

      <div className="quotation-list-card">
        <div className="quotation-list-toolbar">
          <div className="quotation-list-toolbar-left">
            <div className="quotation-search">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="m21 21-4.35-4.35m1.35-5.15a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
              <input
                type="text"
                placeholder="Search quotation, customer, project or job description..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>

            <select
              className="quotation-filter"
              value={companyFilter}
              onChange={(event) => setCompanyFilter(event.target.value)}
              aria-label="Filter by company"
            >
              <option value="all">All Companies</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>

            <select
              className="quotation-filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              aria-label="Filter by status"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <div className="quotation-date-filter">
              <label htmlFor="quotation-date-from">From</label>
              <input
                id="quotation-date-from"
                className="quotation-filter"
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(event) => setDateFrom(event.target.value)}
              />

              <label htmlFor="quotation-date-to">To</label>
              <input
                id="quotation-date-to"
                className="quotation-filter"
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(event) => setDateTo(event.target.value)}
              />

              {(dateFrom || dateTo) && (
                <button
                  type="button"
                  className="quotation-btn quotation-btn-secondary"
                  onClick={clearDateFilters}
                >
                  Clear dates
                </button>
              )}
            </div>

            {hasFilters && (
              <button
                type="button"
                className="quotation-btn quotation-btn-secondary"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            )}
          </div>

          <div className="quotation-result-count">
            {filteredQuotations.length} of {companyFilteredQuotations.length}
          </div>
        </div>

        {error && <div className="quotation-list-error">{error}</div>}
        {reviseError && <div className="quotation-list-error">{reviseError}</div>}
        {companiesError && <div className="quotation-list-error">Company filter: {companiesError}</div>}

        {loading ? (
          <div className="quotation-list-message">Loading quotations...</div>
        ) : filteredQuotations.length === 0 ? (
          <div className="quotation-list-empty">
            <div className="quotation-empty-icon">Q</div>
            <strong>No quotations found</strong>
            <span>
              {hasFilters
                ? 'Try changing your search or filters.'
                : 'No quotations have been created yet.'}
            </span>
            {hasFilters && (
              <button
                type="button"
                className="quotation-btn quotation-btn-secondary"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="quotation-table-wrapper">
            <table className="quotation-table">
              <thead>
                <tr>
                  <th>Quotation / Company</th>
                  <th>Customer / Project</th>
                  <th>Job Description</th>
                  <th>Issue Date / Valid Until</th>
                  <th>Created By</th>
                  <th>Status</th>
                  <th className="quotation-table-number">Total</th>
                  <th />
                </tr>
              </thead>

              <tbody>
                {filteredQuotations.map((quotation) => {
                  const status = quotation.status.toLowerCase()
                  const isUpdating = updatingId === quotation.id
                  // Implement -- Quotation Permissions & Accepted
                  // Immutability, §7: same UX-only gating as
                  // QuotationView's status control -- the backend is what
                  // actually enforces this.
                  const isAccepted = status === 'accepted'
                  const canApprove = hasPermission('sales.approve')
                  const canUpdateStatus = hasPermission('sales.update')
                  const visibleStatusOptions = STATUS_OPTIONS.filter((option) => {
                    if (option.value === 'all') return false
                    if (option.value === status) return true
                    if (option.value === 'accepted') return canApprove
                    return canUpdateStatus
                  })
                  // claude_prompt.txt ("v186"): Revise -- never Edit -- is
                  // the only mutation entry point this list ever shows for
                  // a non-Draft row, and only to callers holding
                  // sales.revise.
                  const canRevise = status !== 'draft' && hasPermission('sales.revise')
                  const isRevising = revisingId === quotation.id
                  // claude_prompt.txt ("Restyle the Quotation List page ...
                  // and make Cost & Profit open the specific quotation"):
                  // this button is new -- there is no pre-existing
                  // visibility rule for it on this page to preserve. Gated
                  // on the same permission (`sales.reports.read`) the
                  // backend's cost-profit report endpoints already require
                  // (ems-backend auth/.../reports/cost-profit.controller.ts),
                  // so it is never shown to a user who would just be denied
                  // on arrival.
                  const canSeeCostProfit = hasPermission('sales.reports.read')

                  return (
                    <tr key={quotation.id}>
                      <td>
                        <button
                          type="button"
                          className="quotation-number"
                          onClick={() => onView(quotation.id)}
                        >
                          {quotation.number}
                        </button>

                        <div className="qt-list-cell-sub-wrap">
                          <span className={`quotation-company-code company-${getCompanyCode(quotation, companies).toLowerCase()}`}>
                            {getCompanyCode(quotation, companies)}
                          </span>
                        </div>
                      </td>

                      <td>
                        <div className="quotation-customer">
                          <strong>{getCustomerName(quotation)}</strong>
                        </div>
                        <span className="quotation-project qt-list-cell-sub">
                          {getProjectName(quotation)}
                        </span>
                      </td>

                      <td>
                        <span
                          className="quotation-job-description"
                          title={getJobDescription(quotation)}
                        >
                          {getJobDescription(quotation)}
                        </span>
                      </td>

                      <td>
                        <div>{formatDate(getIssueDate(quotation))}</div>
                        <div className="qt-list-cell-sub">{formatDate(getValidUntil(quotation))}</div>
                      </td>

                      <td>
                        <span className="quotation-created-by">
                          {getCreatedByName(quotation)}
                        </span>
                      </td>

                      <td>
                        <div className={`quotation-status-control status-${status}`}>
                          <span className="quotation-status-dot" />
                          <span>{getStatusLabel(status)}</span>

                          <svg viewBox="0 0 20 20" aria-hidden="true">
                            <path
                              d="m5 7 5 5 5-5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>

                          <select
                            value={status}
                            disabled={isUpdating || isAccepted}
                            title={isAccepted ? 'Accepted quotations are final and cannot change status' : undefined}
                            onChange={(event) =>
                              void updateStatus(quotation.id, event.target.value)
                            }
                            aria-label={`Change status for ${quotation.number}`}
                          >
                            {visibleStatusOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>

                      <td className="quotation-table-number">
                        <strong>
                          {formatMoney(quotation.total, quotation.currency || 'THB')}
                        </strong>
                      </td>

                      <td className="quotation-view-cell">
                        <button
                          type="button"
                          className="quotation-view-button"
                          onClick={() => onView(quotation.id)}
                        >
                          View
                        </button>

                        {canRevise && (
                          <button
                            type="button"
                            className="quotation-view-button"
                            onClick={() => void handleRevise(quotation.id)}
                            disabled={isRevising}
                            title="Create an editable Draft copy of this quotation -- the original is never changed"
                          >
                            {isRevising ? 'Revising…' : 'Revise'}
                          </button>
                        )}

                        {canSeeCostProfit && (
                          <a
                            className="quotation-view-button quotation-cost-profit-button"
                            href={getCostProfitHref(quotation)}
                          >
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                              <path
                                d="M3 13V8M8 13V3M13 13V6"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                            Cost & Profit
                          </a>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default QuotationList