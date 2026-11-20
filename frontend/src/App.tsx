import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  generateQuotationPDF,
  CTL_ITEM_DEFS,
  computeCtlTotal,
  type CtlItemKey,
} from './utils/generateQuotationPDF'
import './index.css'
import StockItemPicker from './components/StockItemPicker'
import type { InventoryItem } from './types/inventory'
import ExternalPartForm, {
  type ExternalGroup,
} from './components/ExternalPartForm'
import { buildQuotationRows, computeQuotationTotals } from './utils/quotationRows'
import { generateQuotationNote } from './utils/quotationNoteTemplate'
import type { Project } from './types/QuoteItem'
import ComboInput from './components/ComboInput'
import {
  customerShippingForQuotation,
  shippingLineLabel,
  shouldShowShippingLine,
  detectShippingRule,
  type ShippingRule,
} from './utils/externalPartsAllocation'
import QuotationView from './pages/QuotationView'
import QuotationList from './pages/QuotationList'
import LoginScreen from './pages/LoginScreen'
import { api, bootstrapSsoAuth, clearSession, EMS_FRONTEND_URL, logoutSso, setUnauthorizedHandler, type Company } from './services/api'
import {
  CTL_CONFIG,
  DEFAULT_LABOUR_STAFF,
  type LabourStaffCounts,
} from './utils/ctlConfig'


const CTL_LOCATIONS = [
  { label: 'Boat Lagoon', value: 'Boat Lagoon', fuelPrice: 0 },
  { label: 'Royal Phuket Marina', value: 'Royal Phuket Marina', fuelPrice: 0 },
  { label: 'Ao Po Grand Marina', value: 'Ao Po Grand Marina', fuelPrice: 500 },
  { label: 'Ao Yon', value: 'Ao Yon', fuelPrice: 400 },
  { label: 'Chalong', value: 'Chalong', fuelPrice: 500 },
  { label: 'Laem Sai Pier', value: 'Laem Sai Pier', fuelPrice: 500 },
  { label: 'Nai Harn', value: 'Nai Harn', fuelPrice: 400 },
  { label: 'Patong', value: 'Patong', fuelPrice: 400 },
  { label: 'Premier Shipyard', value: 'Premier Shipyard', fuelPrice: 600 },
  { label: 'Ratsada', value: 'Ratsada', fuelPrice: 300 },
  { label: 'Rattanachai', value: 'Rattanachai', fuelPrice: 500 },
  { label: 'Yacht Haven', value: 'Yacht Haven', fuelPrice: 600 },
  { label: 'Ocean Marina Pattaya', value: 'Ocean Marina Pattaya', fuelPrice: 7000 },
] as const

const CTL_LABOUR_RATES = [400, 500, 600, 800] as const

type ClientPickerOption = {
  id: string
  name: string
  companyName: string | null
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  country: string | null
}

type StockQuoteItem = {
  id: string
  source: 'stock'
  itemId?: string
  brand: string
  partName: string
  originalPartName: string
  partNo: string
  qty: number
  unit: string
  unitPrice: number
  originalUnitPrice: number
  priceIncludesVat: boolean
}

const DEFAULT_WORKING_HOURS_PER_DAY = 8

type CtlRowState = {
  included: boolean
  price: number
  note: string
  days: number
  technicians: number
  dayDescriptions: string[]
  location: string
  ratePerDay: number
  workingHoursPerDay: number
  staffCounts?: LabourStaffCounts
}

function bangkokToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
  }).format(new Date())
}

function stockLineTotal(item: { qty: number; unitPrice: number }) {
  return Math.round(item.qty * item.unitPrice * 100) / 100
}

function App() {
  const [items, setItems] = useState<StockQuoteItem[]>([])
  const [externalGroups, setExternalGroups] = useState<ExternalGroup[]>([])
  // claude_prompt.txt ("shipping price rule B"): quotation-level, in-memory
  // only -- never persisted, never part of the payload. A brand-new
  // quotation always starts on 'B'; opening a saved one for edit overwrites
  // this exactly once (see loadQuotationForEdit below) via
  // detectShippingRule(), matching the stored header shipping total so an
  // old quotation never silently switches rules even if its shipping
  // inputs are edited afterwards.
  const [shippingRule, setShippingRule] = useState<ShippingRule>('A')
  const [stockPickerOpen, setStockPickerOpen] = useState(false)
  const [externalFormOpen, setExternalFormOpen] = useState(false)
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [focusPartId, setFocusPartId] = useState<string | null>(null)
  const [discountPercent, setDiscountPercent] = useState(0)
  const [noteText, setNoteText] = useState('')
  const [quotationDate, setQuotationDate] = useState(bangkokToday)
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [clients, setClients] = useState<ClientPickerOption[] | null>(null)
  const [quotationNo, setQuotationNo] = useState('')
  const [quotationId, setQuotationId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [actionError, setActionError] = useState('')
  const [actionSuccess, setActionSuccess] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [projectName, setProjectName] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [location, setLocation] = useState('')
  const [clientId, setClientId] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState<'create' | 'list' | 'view'>('create')
  const [viewQuotationId, setViewQuotationId] = useState<string | null>(null)
  const [noteDirty, setNoteDirty] = useState(false)

  // claude_prompt.txt ("v189 -- Unified EMS & Quotation Authentication /
  // Shared Login Session"): in ems mode, EVERY startup case -- a fragment
  // token, an existing stored token, or neither -- now waits on
  // bootstrapSsoAuth() before being treated as logged in, including the
  // existing-token case (previously trusted on sight, with no server
  // round trip at all; see bootstrapSsoAuth()'s own comment in api.ts for
  // why that was a real gap, not just defensive caution). getToken() is
  // no longer read here at all -- which of the three cases applies is
  // decided entirely inside bootstrapSsoAuth() itself now.
  const [loggedIn, setLoggedIn] = useState(() => api.mode !== 'ems')
  // claude_prompt.txt ("SSO: opening a direct link to another app asks for
  // login again"): true for the entire duration of bootstrapSsoAuth() --
  // covers all three cases above uniformly -- keeps both LoginScreen and
  // the main app from flashing before it resolves either way.
  const [checkingSso, setCheckingSso] = useState(() => api.mode === 'ems')
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');

  const [labourStaff, setLabourStaff] =
    useState<LabourStaffCounts>(() => ({ ...DEFAULT_LABOUR_STAFF }))


  useEffect(() => {
    if (api.mode !== 'ems') return

    setUnauthorizedHandler(() => setLoggedIn(false))

    return () => setUnauthorizedHandler(null)
  }, [])

  // claude_prompt.txt ("v185 -- Fix SSO Fragment Authentication & Permission
  // Hydration"): runs once per mount while not yet logged in. Delegates to
  // bootstrapSsoAuth() (api.ts), which itself picks the cookie path
  // (attemptSsoHydrate, unchanged) or the fragment path
  // (hydrateFromSsoFragmentToken, validates against GET /auth/me before
  // trusting the token) and memoizes the choice -- this effect never
  // re-derives which one to call, so React StrictMode's dev-only
  // mount -> cleanup -> mount double-invoke can't race it into picking a
  // different bootstrap the second time.
  useEffect(() => {
    if (api.mode !== 'ems' || loggedIn) return
    let cancelled = false
    bootstrapSsoAuth().then((ok) => {
      if (cancelled) return
      if (ok) setLoggedIn(true)
      setCheckingSso(false)
    })
    return () => {
      cancelled = true
    }
  }, [loggedIn])

  // claude_prompt.txt ("v189 -- Unified EMS & Quotation Authentication /
  // Shared Login Session"): logoutSso() now awaited BEFORE clearing local
  // state and navigating -- it previously ran after clearSession(), by
  // which point the local token it needs to identify the caller to the
  // backend (see api.ts's logoutSso()) was already wiped, and the
  // immediate navigation right after risked the request never completing
  // at all. Matches ems-frontend's own current-user.tsx logout(), which
  // already does it in this order for the same reason.
  const handleLogout = useCallback(() => {
    void logoutSso().finally(() => {
      clearSession()
      setLoggedIn(false)
      window.location.href = EMS_FRONTEND_URL
    })
  }, [])

  useEffect(() => {
    if (api.mode !== 'ems') return

    api.listCompanies()
      .then((data) => setCompanies(data.filter((company) => company.isActive)))
      .catch((error) => console.error('Failed to load companies:', error))
  }, [])

  const [ctlState, setCtlState] = useState<Record<CtlItemKey, CtlRowState>>(() =>
    Object.fromEntries(
      CTL_ITEM_DEFS.map((def) => [
        def.key,
        {
          included: false,
          price: 0,
          note: '',
          days: 1,
          technicians: 1,
          dayDescriptions: [''],
          location: '',
          ratePerDay: def.key === 'labour' ? 600 : 0,
          workingHoursPerDay: DEFAULT_WORKING_HOURS_PER_DAY,
        },
      ])
    ) as Record<CtlItemKey, CtlRowState>
  )

  const updateCtlRow = useCallback(
    (key: CtlItemKey, patch: Partial<CtlRowState>) => {
      setCtlState((current) => ({
        ...current,
        [key]: { ...current[key], ...patch },
      }))
    },
    []
  )

  const setLabourDays = useCallback((days: number) => {
    setCtlState((current) => {
      const labour = current.labour
      const clampedDays = Math.max(0, Math.floor(Number(days) || 0))
      const dayDescriptions = Array.from(
        { length: clampedDays },
        (_, index) => labour.dayDescriptions[index] ?? ''
      )

      return {
        ...current,
        labour: { ...labour, days: clampedDays, dayDescriptions },
      }
    })
  }, [])

  const setLabourDayDescription = useCallback(
    (dayIndex: number, description: string) => {
      setCtlState((current) => {
        const dayDescriptions = [...current.labour.dayDescriptions]
        dayDescriptions[dayIndex] = description

        return {
          ...current,
          labour: {
            ...current.labour,
            dayDescriptions,
          },
        }
      })
    },
    []
  )

  const getCtlBasePrice = (key: CtlItemKey, row: CtlRowState) => {
    const days = ctlState.labour.days
    const staffCounts = labourStaff
    const staffCount = Object.values(staffCounts).reduce((sum, count) => sum + count, 0)
    const labourRateTotal = CTL_CONFIG.labour.rates.reduce(
      (sum, item) => sum + item.rate * (staffCounts[item.key] || 0), 0,
    )

    if (key === 'consumable') return staffCount * CTL_CONFIG.consum.ratePerPersonPerDay * days
    if (key === 'traveling') return labourRateTotal * days
    if (key === 'gasoline') return row.ratePerDay * row.days
    if (key === 'labour') return labourRateTotal * row.workingHoursPerDay * days
    return row.price
  }

  const ctlItemsForPdf = useMemo(
    () =>
      CTL_ITEM_DEFS.filter((def) => ctlState[def.key].included).map((def) => {
        const row = ctlState[def.key]
        const basePrice = getCtlBasePrice(def.key, row)
        let note: string | undefined

        if (def.key === 'traveling') {
          note = [
            location ? `(Project Location: ${location})` : '',
          ].filter(Boolean).join('\n')
        } else if (def.key === 'gasoline') {
          note = ''
        } else if (def.key === 'labour') {
          const technicianCount = Object.values(labourStaff).reduce((sum, count) => sum + count, 0)
          const dailyDescriptions = row.dayDescriptions
            .map((description, index) => description.trim() ? `Day ${index + 1}: ${description.trim()}` : '')
            .filter(Boolean)
            .join('\n')

          note = [
            `${row.days} Day(s) / ${technicianCount} Technician(s)`,
            dailyDescriptions,
          ].filter(Boolean).join('\n')
        } else if (def.hasNote) {
          note = row.note || undefined
        }
        return {
          key: def.key,
          label: def.label,
          included: row.included,
          price: basePrice,
          total: computeCtlTotal(basePrice),
          note,
          days: row.days,
          technicians: row.technicians,
          staffCounts: def.key === 'labour' ? { ...labourStaff } : undefined,
          dayDescriptions: row.dayDescriptions,
          location: def.key === 'gasoline' ? location || row.location : row.location,
          ratePerDay: row.ratePerDay,
        }
      }),
    [ctlState, location, labourStaff]
  )

  const ctlTotal = useMemo(
    () => ctlItemsForPdf.reduce((sum, item) => sum + item.total, 0),
    [ctlItemsForPdf]
  )

  const validUntil = useMemo(() => {
    const [year, month, day] = quotationDate.split('-').map(Number)
    if (!year || !month || !day) return ''

    let targetYear = year
    let targetMonth = month + 1
    if (targetMonth > 12) {
      targetMonth = 1
      targetYear += 1
    }

    const daysInTargetMonth = new Date(targetYear, targetMonth, 0).getDate()
    const targetDay = Math.min(day, daysInTargetMonth)

    return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`
  }, [quotationDate])

  useEffect(() => {
    if (!quotationId) return

    let cancelled = false

    const loadQuotationForEdit = async () => {
      try {
        const data = (await api.getQuotation(quotationId)) as any

        if (cancelled) return

        const quotation = data.quotation
        const customer = data.customer
        const project = data.project

        setCompanyId(quotation.company_id || quotation.companyId || '')
        setQuotationNo(quotation.number || '')
        setQuotationDate(quotation.issue_date || bangkokToday())
        setCustomerName(customer?.name || '')
        setClientId(customer?.id || quotation.client_id || null)
        setProjectName(project?.name || '')
        setSelectedProjectId(project?.id || '')
        setJobDescription(quotation.description || '')
        setLocation(quotation.location || '')
        setDiscountPercent(Number(quotation.discount_value || 0))
        setNoteText(quotation.notes || '')
        setNoteDirty(true)

        const stockItems: StockQuoteItem[] = (data.lines || [])
          .filter((line: any) => line.line_type === 'stock')
          .map((line: any) => ({
            id: line.id || crypto.randomUUID(),
            source: 'stock' as const,
            itemId: line.item_id || undefined,
            brand: line.brand || '',
            partName: line.description || '',
            originalPartName: line.description || '',
            partNo: line.part_no || '',
            qty: Number(line.quantity || 0),
            unit: line.unit || 'pcs',
            unitPrice: Number(line.unit_price || 0),
            originalUnitPrice: Number(line.unit_price || 0),
            priceIncludesVat:
              line.price_includes_vat == null ? true : Boolean(line.price_includes_vat),
          }))

        const loadedGroups: ExternalGroup[] = (data.externalGroups || []).map(
          (group: any) => ({
            id: group.id,
            sourceType: group.source_type,
            sourceName: group.source_name,
            brand: group.brand || '',
            country: group.country || '',
            currency: group.currency || 'THB',
            exchangeRate: Number(group.exchange_rate || 1),
            exchangeRateDate: group.exchange_rate_date ? String(group.exchange_rate_date).slice(0, 10) : null,
            shippingCost: Number(group.shipping_cost || 0),
            importTax: Number(group.import_tax || 0),
            shippingCostFc: group.shipping_cost_fc != null ? Number(group.shipping_cost_fc) : null,
            importTaxPercent: group.import_tax_percent != null ? Number(group.import_tax_percent) : null,
            transferFee: group.transfer_fee != null ? Number(group.transfer_fee) : null,
            estimatedDelivery: group.estimated_delivery || '',
            warranty: group.warranty || '',
            installationIncluded: Boolean(group.installation_included),
            containsStockItems: Boolean(group.contains_stock_items),
            parts: (data.externalParts || [])
              .filter((part: any) => part.group_id === group.id)
              .map((part: any) => ({
                id: part.id,
                partName: part.part_name,
                qty: Number(part.qty || 0),
                unit: part.unit || 'ea',
                unitCost: Number(part.unit_cost || 0),
                unitCostTHB: Number(part.unit_cost_thb || 0),
                markupPercent: Number(part.markup_percent || 0),
                unitPrice: Number(part.unit_price || 0),
                importTaxPercent: part.import_tax_percent != null
                  ? Number(part.import_tax_percent)
                  : 0,
                importTaxAmount: part.import_tax_amount != null
                  ? Number(part.import_tax_amount)
                  : 0,
                hasStockPortion: part.has_stock_portion ?? false,
                stockQty: Number(part.stock_qty || 0),
                unitWeight: Number(part.unit_weight || 0),
              })),
          })
        )

        setItems(stockItems)
        setExternalGroups(loadedGroups)
        // claude_prompt.txt ("shipping price rule B"): a saved quotation opened
        // for edit keeps whichever rule it was actually saved under, detected
        // once here by matching the stored header shipping total -- never
        // re-derived afterwards, so later edits to shipping inputs in this
        // same session never silently flip the rule.
        // setShippingRule(detectShippingRule(loadedGroups, Number(quotation.shipping_total || 0)))
        setShippingRule('A')

        const savedCtlState = data.ctlState ?? {}
        const savedCtlItems = data.ctlItems ?? []

        const savedLabour = Array.isArray(savedCtlItems)
          ? savedCtlItems.find((item: any) => item.key === 'labour')
          : null

        const savedStaffCounts = {
          ...DEFAULT_LABOUR_STAFF,
          ...(savedCtlState.labour?.staffCounts ?? savedLabour?.staffCounts ?? {}),
        }
        setLabourStaff(savedStaffCounts)
        const loadedCtlState = Object.fromEntries(
          CTL_ITEM_DEFS.map((def) => {
            const item = savedCtlState[def.key] ??
              savedCtlItems.find((ctl: any) => ctl.key === def.key)

            const loadedLocation = item?.location || quotation.location || ''
            const defaultFuelPrice =
              CTL_LOCATIONS.find((loc) => loc.value === loadedLocation)?.fuelPrice ?? 0

            return [
              def.key,
              {
                included: Boolean(item?.included),
                price: Number(item?.price ?? 0),
                note: item?.note || '',
                days: Math.max(0, Number(item?.days ?? 1)),
                technicians: Math.max(0, Number(item?.technicians ?? 1)),
                dayDescriptions: Array.isArray(item?.dayDescriptions) && item.dayDescriptions.length
                  ? item.dayDescriptions
                  : [''],
                location: loadedLocation,
                ratePerDay: Number(
                  item?.ratePerDay ?? item?.cost ??
                  (def.key === 'labour' ? 600 : defaultFuelPrice)
                ),
                workingHoursPerDay: Math.max(
                  0,
                  Number(item?.workingHoursPerDay ?? DEFAULT_WORKING_HOURS_PER_DAY)
                ),
              },
            ]
          })
        ) as Record<CtlItemKey, CtlRowState>

        setCtlState(loadedCtlState)
      } catch (error) {
        console.error('Failed to load quotation for edit:', error)
        setActionError(
          error instanceof Error ? error.message : 'Failed to load quotation'
        )
      }
    }

    void loadQuotationForEdit()

    return () => {
      cancelled = true
    }
  }, [quotationId])

  useEffect(() => {
    if (api.mode === 'ems' && !loggedIn) return

    api
      .listProjects()
      .then((data) => setProjects(data as Project[]))
      .catch((error) => {
        console.error('Failed to load projects:', error)
      })
  }, [loggedIn])

  useEffect(() => {
    if (api.mode !== 'ems') return
    if (!loggedIn) return

    let cancelled = false

    api
      .listClients()
      .then((data) => {
        if (cancelled) return
        setClients(data as ClientPickerOption[])
      })
      .catch((error) => {
        if (cancelled) return
        console.error('Failed to load clients:', error)
        const message = error instanceof Error ? error.message : ''
        if (/missing permission/i.test(message)) {
          setActionError(message)
        }
      })

    return () => {
      cancelled = true
    }
  }, [loggedIn])

  const itemsForTotals = useMemo(
    () =>
      items.map((item) => {
        const total = stockLineTotal(item)
        const unitPrice =
          item.qty > 0
            ? Math.round((total / item.qty) * 100) / 100
            : item.unitPrice

        return { ...item, unitPrice }
      }),
    [items]
  )

  const totals = useMemo(
    () =>
      computeQuotationTotals(
        itemsForTotals,
        externalGroups,
        ctlTotal,
        discountPercent,
        shippingRule
      ),
    [itemsForTotals, externalGroups, ctlTotal, discountPercent, shippingRule]
  )

  const {
    partsSubtotal,
    shippingTotal,
    importTaxTotal,
    discountAmount,
    totalDue,
  } = totals

  const totalExcVat = useMemo(
    () => Math.round((totalDue / 1.07) * 100) / 100,
    [totalDue]
  )

  const vat = useMemo(
    () => Math.round((totalDue - totalExcVat) * 100) / 100,
    [totalDue, totalExcVat]
  )

  const editingGroup = useMemo(
    () => externalGroups.find((group) => group.id === editingGroupId) ?? null,
    [externalGroups, editingGroupId]
  )

  const rows = useMemo(
    () => buildQuotationRows(itemsForTotals, externalGroups, shippingRule),
    [itemsForTotals, externalGroups, shippingRule]
  )

  const tableRows = useMemo(
    () => rows.screenRows.filter((row) => row.kind !== 'external-group'),
    [rows.screenRows]
  )

  const externalGroupRows = useMemo(
    () => rows.screenRows.filter((row) => row.kind === 'external-group'),
    [rows.screenRows]
  )

  const projectDerivedCustomerOptions = useMemo(() => {
    const map = new Map<string, { id: string; label: string }>()

    for (const project of projects) {
      if (!project.clientName) continue

      const id = project.clientId || project.clientName

      if (!map.has(id)) {
        map.set(id, {
          id,
          label: project.clientName,
        })
      }
    }

    return Array.from(map.values())
  }, [projects])

  const customerOptions = useMemo(() => {
    if (!clients) return projectDerivedCustomerOptions

    return clients.map((c) => ({
      id: c.id,
      label: c.name,
      sublabel: c.companyName && c.companyName !== c.name ? c.companyName : undefined,
    }))
  }, [clients, projectDerivedCustomerOptions])

  const projectOptions = useMemo(() => {
    const anyProjectHasClientId = projects.some((project) => project.clientId)
    const relevant =
      clientId && anyProjectHasClientId
        ? projects.filter((project) => project.clientId === clientId)
        : projects

    return relevant.map((project) => ({
      id: project.id,
      label: project.name,
    }))
  }, [projects, clientId])

  const handleStockSelect = useCallback((item: InventoryItem) => {
    const rawPrice = Number(item.unitSellPrice)
    const unitPrice =
      api.mode === 'ems' ? rawPrice : Math.round(rawPrice * 1.07 * 100) / 100

    setItems((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        source: 'stock',
        itemId: item.id,
        brand: item.brand || '',
        partName: item.partName,
        originalPartName: item.partName,
        partNo: item.partNo || '',
        qty: 1,
        unit: item.unit?.abbreviation || item.unit?.name || 'ea',
        unitPrice,
        originalUnitPrice: unitPrice,
        priceIncludesVat: api.mode !== 'ems',
      },
    ])

    setStockPickerOpen(false)
  }, [])

  const handleExternalSubmit = useCallback((group: ExternalGroup) => {
    setExternalGroups((current) => {
      const exists = current.some((g) => g.id === group.id)

      return exists
        ? current.map((g) => (g.id === group.id ? group : g))
        : [...current, group]
    })

    setExternalFormOpen(false)
    setEditingGroupId(null)
    setFocusPartId(null)
  }, [])

  const openAddExternalGroup = useCallback(() => {
    setEditingGroupId(null)
    setFocusPartId(null)
    setExternalFormOpen(true)
  }, [])

  const openEditExternalGroup = useCallback(
    (groupId: string, partId?: string) => {
      setEditingGroupId(groupId)
      setFocusPartId(partId ?? null)
      setExternalFormOpen(true)
    },
    []
  )

  const closeExternalForm = useCallback(() => {
    setExternalFormOpen(false)
    setEditingGroupId(null)
    setFocusPartId(null)
  }, [])

  const removeExternalGroup = useCallback((groupId: string) => {
    setExternalGroups((current) =>
      current.filter((group) => group.id !== groupId)
    )
  }, [])

  const removeExternalGroupWithConfirm = useCallback(
    (group: ExternalGroup) => {
      const label = group.country
        ? `${group.sourceName} (${group.country})`
        : group.sourceName

      const confirmed = window.confirm(
        `Remove the entire "${label}" box, including all its parts and shipping? This cannot be undone.`
      )

      if (confirmed) removeExternalGroup(group.id)
    },
    [removeExternalGroup]
  )

  const removeExternalPart = useCallback((groupId: string, partId: string) => {
    setExternalGroups((current) =>
      current
        .map((group) => {
          if (group.id !== groupId) return group

          return {
            ...group,
            parts: group.parts.filter((part) => part.id !== partId),
          }
        })
        .filter((group) => group.parts.length > 0)
    )
  }, [])

  const removeItem = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id))
  }, [])

  const updateItemQty = useCallback((id: string, qty: number) => {
    setItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, qty: Math.max(1, qty) } : item
      )
    )
  }, [])

  const updateItemUnitPrice = useCallback((id: string, unitPrice: number) => {
    setItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, unitPrice: Math.max(0, unitPrice) } : item
      )
    )
  }, [])

  const updateItemPartName = useCallback((id: string, partName: string) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, partName } : item))
    )
  }, [])

  const updateItemUnit = useCallback((id: string, unit: string) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, unit } : item))
    )
  }, [])

  const updateItemPriceIncludesVat = useCallback(
    (id: string, value: boolean) => {
      setItems((current) =>
        current.map((item) => {
          if (item.id !== id || item.priceIncludesVat === value) return item

          const unitPrice = value
            ? Math.round(item.unitPrice * 1.07 * 100) / 100
            : Math.round((item.unitPrice / 1.07) * 100) / 100

          return { ...item, priceIncludesVat: value, unitPrice }
        })
      )
    },
    []
  )

  const resetItemToDatabase = useCallback((id: string) => {
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? {
            ...item,
            partName: item.originalPartName,
            unitPrice: item.originalUnitPrice,
          }
          : item
      )
    )
  }, [])

  const hasLabour = ctlState.labour.included && getCtlBasePrice('labour', ctlState.labour) > 0

  const itemNames = useMemo(
    () =>
      rows.pdfRows.reduce<string[]>((names, row) => {
        if (row.kind === 'stock') return [...names, row.item.partName]
        if (row.kind === 'external-part') {
          return [...names, row.part.partName]
        }
        return names
      }, []),
    [rows.pdfRows]
  )

  const generatedNote = useMemo(
    () =>
      generateQuotationNote({
        jobDescription,
        shippingTotal,
        importTaxTotal,
        hasLabour,
        itemNames,
      }),
    [jobDescription, shippingTotal, importTaxTotal, hasLabour, itemNames]
  )

  useEffect(() => {
    if (!noteDirty) {
      setNoteText(generatedNote)
    }
  }, [generatedNote, noteDirty])

  const noteOutdated = noteDirty && noteText !== generatedNote

  const regenerateNote = useCallback(() => {
    setNoteText(generatedNote)
    setNoteDirty(false)
  }, [generatedNote])

  const hasQuotationLines = useMemo(() => {
    if (items.length > 0) return true

    if (externalGroups.some((g) => g.parts.some((p) => p.qty > 0))) {
      return true
    }

    if (
      CTL_ITEM_DEFS.some(
        (def) =>
          ctlState[def.key].included &&
          getCtlBasePrice(def.key, ctlState[def.key]) > 0
      )
    ) {
      return true
    }

    return false
  }, [items, externalGroups, ctlState])

  const validationErrors = useMemo(() => {
    const errors: string[] = []

    if (!companyId) errors.push('Company')
    if (!quotationDate) errors.push('Quotation Date')
    if (!clientId) errors.push('Customer')
    if (!jobDescription.trim()) errors.push('Job Description')
    if (!hasQuotationLines) errors.push('At least one quotation item')

    return errors
  }, [companyId, quotationDate, clientId, jobDescription, hasQuotationLines])

  const canSave = validationErrors.length === 0

  // UI-only accessibility mechanism (claude_prompt.txt, "UI-Only
  // Implementation" round), item 5: lets the error summary below move
  // keyboard focus to itself after a failed save/export attempt, and lets
  // its per-field entries move focus to the actual invalid control. Doesn't
  // change validationErrors/canSave, when they're computed, or anything
  // about the save/export flow itself -- these refs are read-only targets.
  const companyFieldRef = useRef<HTMLSelectElement>(null)
  const quotationDateFieldRef = useRef<HTMLInputElement>(null)
  const jobDescriptionFieldRef = useRef<HTMLInputElement>(null)
  const errorSummaryRef = useRef<HTMLDivElement>(null)
  const errorSummaryFieldRefs: Record<string, RefObject<HTMLElement | null>> = {
    Company: companyFieldRef,
    'Quotation Date': quotationDateFieldRef,
    'Job Description': jobDescriptionFieldRef,
  }
  const focusErrorSummary = useCallback(() => {
    errorSummaryRef.current?.focus()
  }, [])

  const buildQuotationPayload = useCallback(() => {
    const itemsForPdf = items.map((item) => {
      const lineTotal = stockLineTotal(item)
      const unitPrice = item.qty > 0
        ? Math.round((lineTotal / item.qty) * 100) / 100
        : item.unitPrice

      return {
        ...item,
        unitPriceEntered: item.unitPrice,
        unitPrice,
        lineTotal,
      }
    })

    const ctlStateForSave = Object.fromEntries(
      Object.entries(ctlState).map(([key, row]) => {
        const basePrice = getCtlBasePrice(key as CtlItemKey, row)
        const cost = key === 'gasoline' || key === 'labour'
          ? row.ratePerDay
          : row.price
        return [key,
          {
            ...row,
            cost,
            price: basePrice,
            total: computeCtlTotal(basePrice),
            days: row.days,
            technicians: row.technicians,
            workingHoursPerDay: row.workingHoursPerDay,
            ...(key === 'labour' ? { staffCounts: { ...labourStaff } } : {}),
          },
        ]
      })
    )

    return {
      companyId: companyId || undefined,
      quotationDate,
      quotationNo,
      clientId: clientId || undefined,
      customerName: customerName.trim(),
      projectName: projectName.trim(),
      projectId: selectedProjectId || undefined,
      jobDescription: jobDescription.trim(),
      description: jobDescription.trim(),
      location: location.trim(),
      validUntil,
      // Implement -- Quotation Permissions & Accepted Immutability, §7:
      // `status` removed from this payload entirely. It was previously
      // hardcoded to 'draft' here regardless of whether this object was
      // used to create a new quotation or save an existing one -- the
      // backend now always decides the initial status itself and never
      // reads a client-supplied one (ems-backend CreateQuotationDto no
      // longer even has a `status` field), so this field had no correct
      // value to hold for the update case and is no longer accepted by
      // either case.
      items: itemsForPdf,
      externalGroups,
      ctlItems: ctlItemsForPdf,
      ctlState: {
        ...ctlStateForSave,
        traveling: {
          ...ctlStateForSave.traveling,
          note: location || ctlStateForSave.traveling.note,
        },
        gasoline: {
          ...ctlStateForSave.gasoline,
          location,
        },
      },
      discountPercent,
      note: noteText,
      totals: {
        subtotal: partsSubtotal,
        discountAmount,
        shippingTotal,
        importTaxTotal,
        ctlTotal,
        totalExcVat,
        vat,
        totalDue,
      },
    }
  }, [
    companyId,
    quotationDate,
    quotationNo,
    clientId,
    customerName,
    projectName,
    selectedProjectId,
    jobDescription,
    location,
    validUntil,
    items,
    externalGroups,
    ctlItemsForPdf,
    ctlState,
    labourStaff,
    discountPercent,
    noteText,
    partsSubtotal,
    discountAmount,
    shippingTotal,
    importTaxTotal,
    ctlTotal,
    totalExcVat,
    vat,
    totalDue,
  ])

  const saveQuotation = useCallback(async (): Promise<{
    id: string
    number: string
  } | null> => {
    if (!canSave) {
      setActionSuccess('')
      setActionError(
        'Please fill required fields: ' + validationErrors.join(', ')
      )
      focusErrorSummary()
      return null
    }

    setActionError('')
    setActionSuccess('')
    setSaving(true)

    try {
      const payload = buildQuotationPayload()
      const data =
        api.mode === 'ems' && quotationId
          ? await api.updateQuotation(quotationId, payload)
          : await api.createQuotation(payload)

      setQuotationId(data.id)
      setQuotationNo(data.number)

      setActionSuccess(`Quotation saved (${data.number})`)

      return data
    } catch (error) {
      console.error('Failed to save quotation:', error)
      setActionSuccess('')
      setActionError(
        error instanceof Error ? error.message : 'Failed to save quotation'
      )
      return null
    } finally {
      setSaving(false)
    }
  }, [canSave, validationErrors, buildQuotationPayload, quotationId, focusErrorSummary])


  const exportPDF = useCallback(async () => {
    if (!canSave) {
      setActionSuccess('')
      setActionError(
        'Cannot export until required fields are complete: ' +
        validationErrors.join(', ')
      )
      focusErrorSummary()
      return
    }

    setActionError('')
    setActionSuccess('')
    setExporting(true)

    try {
      let number = quotationNo

      if (!quotationId) {
        const saved = await saveQuotation()
        if (!saved) return
        number = saved.number
      }

      const selectedCompany = companies.find(
        (company) => company.id === companyId
      )
      const companyCode = selectedCompany?.code?.toUpperCase()

      if (!companyCode || !['CA', 'CM', 'CS'].includes(companyCode)) {
        throw new Error(
          'Cannot generate PDF: selected company must have a valid code (CA, CM, or CS).'
        )
      }

      const quotation = {
        ...buildQuotationPayload(),
        companyCode: companyCode as 'CA' | 'CM' | 'CS',
        quotationNo: number,
        // claude_prompt.txt ("shipping price rule B"): PDF-generation input
        // only -- buildQuotationPayload()'s own return value is what's sent
        // as the save payload (see saveQuotation above), and this field is
        // added here, after that spread, so it never reaches it. No schema
        // or payload change.
        shippingRule,
      }

      await generateQuotationPDF(quotation)
    } catch (error) {
      console.error('Failed to generate quotation:', error)
      setActionError(
        error instanceof Error ? error.message : 'Failed to export PDF'
      )
    } finally {
      setExporting(false)
    }
  }, [
    canSave,
    validationErrors,
    saveQuotation,
    buildQuotationPayload,
    quotationId,
    quotationNo,
    companies,
    companyId,
    shippingRule,
    focusErrorSummary,
  ])

  const openQuotationList = useCallback(() => {
    setViewQuotationId(null)
    setCurrentPage('list')
  }, [])

  const openQuotationView = useCallback((id: string) => {
    setViewQuotationId(id)
    setCurrentPage('view')
  }, [])

  // claude_prompt.txt ("v186 -- Quotation Authorization & Editing Workflow
  // Refactor"): Draft editing is no longer gated by sales.update at all --
  // "any authenticated user who has access to the quotation" may edit a
  // Draft, and QuotationView's Edit button (the only caller of this
  // function) now only renders for Draft quotations in the first place.
  // The real enforcement is server-side regardless (replace()/update()
  // unconditionally reject a non-Draft quotation, independent of what this
  // function does), per "do not rely on frontend visibility alone for
  // security" -- so this is now just a plain navigation helper, with
  // nothing left to gate here on the frontend.
  const openQuotationEdit = useCallback((id: string) => {
    setQuotationId(id)
    setViewQuotationId(null)
    setCurrentPage('create')
  }, [])

  // claude_prompt.txt ("v189"): checked BEFORE `!loggedIn` now, not nested
  // inside it -- `loggedIn` initializes `false` for every ems-mode startup
  // case (including an existing stored token, this round), so gating only
  // inside the `!loggedIn` branch would have let the main app render
  // immediately whenever a stored token happened to exist, with its
  // verifyExistingSession() check racing in the background instead of
  // blocking the render. This is what actually makes "stale frontend
  // state cannot grant access" true, not just the check existing.
  if (checkingSso) return null

  if (!loggedIn) {
    return <LoginScreen onLoggedIn={() => setLoggedIn(true)} />
  }

  if (currentPage === 'list') {
    return <QuotationList onView={openQuotationView} onEdit={openQuotationEdit} />
  }

  if (currentPage === 'view' && viewQuotationId) {
    return (
      <QuotationView
        quotationId={viewQuotationId}
        onBack={openQuotationList}
        onEdit={openQuotationEdit}
      />
    )
  }

  return (
    <div className="app qt-create">
      <header className="page-header">
        <div className="page-header-inner">
          <div>
            <h1>{quotationId ? 'Edit Quotation' : 'New Quotation'}</h1>
            <p>Customer, items, CTL, and totals</p>
          </div>

          <div className="page-header-actions">
            <button
              type="button"
              className="btn btn-outline"
              onClick={openQuotationList}
            >
              Quotation List
            </button>

            {quotationId && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => openQuotationView(quotationId)}
              >
                View Quotation
              </button>
            )}

            {api.mode === 'ems' && (
              <>
                <a href={EMS_FRONTEND_URL} className="btn btn-outline qt-back-link">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#334155" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 8H3M7 4L3 8l4 4" /></svg>
                  Back to Cirrus
                </a>

                <span className="qt-logout-separator">
                  <button
                    type="button"
                    className="btn btn-outline qt-logout-btn"
                    onClick={handleLogout}
                  >
                    Log out
                  </button>
                </span>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="quotation-page qt-main">
        <div className="qt-left-col">
        <section className="card">
          <div className="section-header">
            <div>
              <h2>Details</h2>
              <p>Company, customer, project, and dates</p>
            </div>

            <p className="qt-required-legend">
              <span aria-hidden="true">*</span> Required field
            </p>
          </div>

          <div className="form-grid">
            {/* 1. Company + Quotation No. */}
            <div className="form-group form-group-wide">
              <label htmlFor="quotation-company">
                Company <span aria-hidden="true">*</span>
              </label>
              <select
                id="quotation-company"
                ref={companyFieldRef}
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
              >
                <option value="">Select company</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group form-group-wide">
              <label htmlFor="quotation-no">Quotation No.</label>
              <input
                id="quotation-no"
                type="text"
                value={quotationNo}
                placeholder="Generated when saved"
                readOnly
              />
            </div>

            {/* 2. Quotation Date + Valid Until + Project */}
            <div className="form-group">
              <label htmlFor="quotation-date">
                Quotation Date <span aria-hidden="true">*</span>
              </label>
              <input
                id="quotation-date"
                ref={quotationDateFieldRef}
                type="date"
                value={quotationDate}
                onChange={(e) => setQuotationDate(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label htmlFor="quotation-valid-until">Valid Until</label>
              <input id="quotation-valid-until" type="date" value={validUntil} readOnly />
            </div>

            <div className="form-group form-group-wide">
              <label>Project</label>
              <ComboInput
                value={projectName}
                onChange={(text) => {
                  setProjectName(text)
                  const match = projects.find((p) => p.name === text)
                  setSelectedProjectId(match?.id ?? '')
                  if (match?.clientName) {
                    setCustomerName(match.clientName)
                    setClientId(match.clientId || null)
                  } else if (!match) {
                    setCustomerName('')
                    setClientId(null)
                  }
                }}
                placeholder="Type or select project"
                options={projectOptions}
                onSelect={(opt) => {
                  const project = projects.find((p) => p.id === opt.id)
                  setSelectedProjectId(opt.id)
                  setProjectName(opt.label)
                  if (project?.clientName) {
                    setCustomerName(project.clientName)
                    setClientId(project.clientId || null)
                  } else {
                    setCustomerName('')
                    setClientId(null)
                  }
                }}
              />
            </div>

            {/* 3. Customer + Location */}
            <div className="form-group form-group-wide">
              <label>
                Customer <span aria-hidden="true">*</span>
              </label>
              <ComboInput
                value={customerName}
                onChange={(text) => {
                  setCustomerName(text)
                  const match = customerOptions.find(
                    (o) => o.label === text || o.id === text,
                  )
                  setClientId(match?.id ?? null)
                }}
                placeholder="Type or select customer"
                options={customerOptions}
                onSelect={(opt) => {
                  setCustomerName(opt.label)
                  setClientId(opt.id)
                }}
              />
            </div>

            <div className="form-group form-group-wide">
              <label htmlFor="quotation-location-details">Location</label>
              <select
                id="quotation-location-details"
                value={location}
                onChange={(e) => {
                  const selectedLocation = e.target.value
                  const selected = CTL_LOCATIONS.find(
                    (item) => item.value === selectedLocation,
                  )
                  setLocation(selectedLocation)
                  updateCtlRow('gasoline', {
                    location: selectedLocation,
                    ratePerDay: selected?.fuelPrice ?? 0,
                  })
                  updateCtlRow('traveling', {
                    note: selectedLocation,
                  })
                }}
              >
                <option value="">Select location</option>
                {CTL_LOCATIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 4. Job Description */}
            <div className="form-group form-group-wide">
              <label htmlFor="job-description">
                Job Description <span aria-hidden="true">*</span>
              </label>
              <input
                id="job-description"
                ref={jobDescriptionFieldRef}
                type="text"
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
                placeholder="Enter job description"
              />
            </div>
          </div>
        </section>

        <section className="card">
          <div className="section-header">
            <div>
              <h2>Items</h2>
              <p>Stock and external sources</p>
            </div>

            <div className="item-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setStockPickerOpen(true)}
              >
                + Add from Stock
              </button>

              <button
                type="button"
                className="btn btn-outline"
                onClick={openAddExternalGroup}
              >
                + Add External Source
              </button>
            </div>
          </div>

          {tableRows.length > 0 && (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Qty</th>
                    <th>Unit</th>
                    <th>Price / Unit</th>
                    {api.mode !== 'ems' && <th>Incl. VAT 7%</th>}
                    <th>Total</th>
                    <th></th>
                  </tr>
                </thead>

                <tbody>
                  {tableRows.map((row) => {
                    if (row.kind === 'stock') {
                      const item =
                        items.find((i) => i.id === row.item.id) ?? row.item

                      const isEdited =
                        item.partName !== item.originalPartName ||
                        item.unitPrice !== item.originalUnitPrice

                      const lineTotal = stockLineTotal(item)

                      return (
                        <tr key={item.id}>
                          <td>
                            <div className="item-main">
                              <input
                                className="table-input item-name-input"
                                type="text"
                                value={item.partName}
                                onChange={(e) =>
                                  updateItemPartName(item.id, e.target.value)
                                }
                              />

                              {isEdited && (
                                <div className="edited-row">
                                  <span
                                    className="edited-tag"
                                    title="Differs from the database value"
                                  >
                                    Edited
                                  </span>

                                  <button
                                    type="button"
                                    className="reset-link"
                                    title="Reset name and price to the database value"
                                    onClick={() =>
                                      resetItemToDatabase(item.id)
                                    }
                                  >
                                    Reset
                                  </button>
                                </div>
                              )}
                            </div>
                          </td>

                          <td>
                            <input
                              className="table-input small number-input"
                              type="number"
                              min="1"
                              value={item.qty}
                              onChange={(e) =>
                                updateItemQty(item.id, Number(e.target.value))
                              }
                            />
                          </td>

                          <td>
                            <input
                              className="table-input small"
                              type="text"
                              value={item.unit}
                              onChange={(e) =>
                                updateItemUnit(item.id, e.target.value)
                              }
                            />
                          </td>

                          <td>
                            <input
                              className="table-input number-input"
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.unitPrice}
                              onChange={(e) =>
                                updateItemUnitPrice(
                                  item.id,
                                  Number(e.target.value)
                                )
                              }
                            />
                          </td>

                          {api.mode !== 'ems' && (
                            <td>
                              <label
                                className="vat-flag"
                                title="Tick to add 7% VAT on this unit price"
                              >
                                <input
                                  type="checkbox"
                                  checked={item.priceIncludesVat}
                                  onChange={(e) =>
                                    updateItemPriceIncludesVat(
                                      item.id,
                                      e.target.checked
                                    )
                                  }
                                />
                              </label>
                            </td>
                          )}

                          <td className="number">
                            ฿ {lineTotal.toFixed(2)}
                          </td>

                          <td>
                            <div className="row-actions">
                              <button
                                type="button"
                                className="remove-btn"
                                title="Remove item"
                                aria-label="Remove item"
                                onClick={() => removeItem(item.id)}
                              >
                                ×
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    }

                    if (row.kind === 'import-tax') {
                      return (
                        <tr key="import-tax" className="row-auto">
                          <td colSpan={api.mode === 'ems' ? 4 : 5}>Import Tax</td>
                          <td className="number">
                            ฿ {row.amount.toFixed(2)}
                          </td>
                          <td />
                        </tr>
                      )
                    }

                    return null
                  })}
                </tbody>
              </table>
            </div>
          )}

          {items.length === 0 && externalGroups.length === 0 && (
            <div className="quotation-items-empty">No items yet</div>
          )}

          {externalGroupRows.length > 0 && (
            <div className="external-groups">
              {externalGroupRows.map((row) => {
                if (row.kind !== 'external-group') return null

                const { group, parts } = row
                const badgeLabel = `External · ${row.badgeOrigin}${group.brand ? ` · ${group.brand}` : ''}`

                return (
                  <div
                    className="external-group-box"
                    key={`external-group-${group.id}`}
                  >
                    <div className="external-group-header">
                      <div className="external-group-title">
                        <span className="source-badge external">
                          {badgeLabel}
                        </span>

                        {parts.length === 0 && (
                          <span className="auto-tag">
                            All to stock · not in quotation
                          </span>
                        )}
                      </div>

                      <div className="external-group-actions">
                        <button
                          type="button"
                          className="edit-group-btn"
                          onClick={() => openEditExternalGroup(group.id)}
                        >
                          Edit
                        </button>

                        <button
                          type="button"
                          className="remove-group-btn"
                          onClick={() =>
                            removeExternalGroupWithConfirm(group)
                          }
                        >
                          Remove
                        </button>
                      </div>
                    </div>

                    {parts.length > 0 ? (
                      <div className="external-group-list">
                        <div className="external-part-header">
                          <div>Item</div>
                          <div>Qty</div>
                          <div>Unit</div>
                          <div>Price / Unit</div>
                          <div>Total</div>
                          <div></div>
                        </div>

                        {parts.map((part) => (
                          <div className="external-part-row" key={part.id}>
                            <div className="external-part-name">
                              {part.partName}
                            </div>

                            <div className="external-part-qty">
                              {part.quotationQty}
                            </div>

                            <div className="external-part-unit">
                              {part.unit}
                            </div>

                            <div className="external-part-price">
                              ฿ {part.unitPrice.toFixed(2)}
                            </div>

                            <div className="external-part-total">
                              ฿{' '}
                              {(
                                part.quotationQty * part.unitPrice
                              ).toFixed(2)}
                            </div>

                            <div className="external-part-actions">
                              <button
                                type="button"
                                className="remove-btn"
                                title="Remove part"
                                aria-label="Remove part"
                                onClick={() =>
                                  removeExternalPart(group.id, part.id)
                                }
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        ))}

                        {shouldShowShippingLine(group) && (
                          <div className="external-group-shipping">
                            <span>
                              {shippingLineLabel(group)}
                              <span className="auto-tag">Auto</span>
                            </span>

                            <strong>
                              ฿{' '}
                              {customerShippingForQuotation(group, shippingRule).toFixed(2)}
                            </strong>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="external-screen-only">
                        All parts from this source are allocated to stock and
                        are not included in the quotation.
                        <span className="auto-tag">Screen only</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          <div className="items-sticky-totals">
            <span>
              <span className="totals-label">Parts</span>
              <span className="totals-figure">
                ฿ {partsSubtotal.toFixed(2)}
              </span>
            </span>

            <span>
              <span className="totals-label">Shipping</span>
              <span className="totals-figure">
                ฿ {shippingTotal.toFixed(2)}
              </span>
            </span>

            <span>
              <span className="totals-label">Import tax</span>
              <span className="totals-figure">
                ฿ {importTaxTotal.toFixed(2)}
              </span>
            </span>

            <span className="totals-spacer" />

            <span>
              <span className="totals-label">Items total</span>
              <span className="totals-figure grand">
                ฿ {(totalDue - ctlTotal).toFixed(2)}
              </span>
            </span>
          </div>
        </section>

        <section className="card ctl-card">
          <div className="section-header">
            <div>
              <h2>CTL Cost</h2>
              <p>Location, labour, fuel, and other job costs</p>
            </div>
          </div>

          <div className="ctl-form">
            <div className="ctl-form-grid ctl-form-grid-compact">
              <div className="ctl-form-field ctl-field-location">
                <label htmlFor="ctl-location">Job Location</label>
                <select
                  id="ctl-location"
                  className="table-input"
                  value={location}
                  onChange={(e) => {
                    const selectedLocation = e.target.value;
                    const selected = CTL_LOCATIONS.find(
                      (item) => item.value === selectedLocation
                    );

                    setLocation(selectedLocation);
                    updateCtlRow("gasoline", {
                      location: selectedLocation,
                      ratePerDay: selected?.fuelPrice ?? 0,
                    });
                    updateCtlRow("traveling", { note: selectedLocation });
                  }}
                >
                  <option value="">Select location</option>
                  {CTL_LOCATIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="ctl-form-field ctl-field-sm">
                <label htmlFor="ctl-days">Days</label>
                <input
                  id="ctl-days"
                  className="table-input"
                  type="number"
                  min="0"
                  step="1"
                  value={ctlState.labour.days}
                  onChange={(e) => {
                    const days = Math.max(0, Math.floor(Number(e.target.value) || 0));
                    setLabourDays(days);
                    updateCtlRow("gasoline", { days });
                  }}
                />
              </div>

              <div className="ctl-form-field ctl-field-sm">
                <label htmlFor="ctl-hours">Hours / day</label>
                <input
                  id="ctl-hours"
                  className="table-input"
                  type="number"
                  min="0"
                  step="1"
                  value={ctlState.labour.workingHoursPerDay}
                  onChange={(e) =>
                    updateCtlRow("labour", {
                      workingHoursPerDay: Math.max(
                        0,
                        Number(e.target.value) || 0
                      ),
                    })
                  }
                />
              </div>

              <div className="ctl-form-field ctl-field-md">
                <label htmlFor="ctl-fuel">Fuel (฿ / day)</label>
                <input
                  id="ctl-fuel"
                  className="table-input"
                  type="number"
                  min="0"
                  step="1"
                  value={ctlState.gasoline.ratePerDay}
                  onChange={(e) =>
                    updateCtlRow("gasoline", {
                      ratePerDay: Math.max(0, Number(e.target.value) || 0),
                    })
                  }
                />
              </div>
            </div>

            <div className="ctl-staff-section">
              <div className="ctl-staff-heading">Labour Staff</div>
              <div className="ctl-form-grid ctl-staff-grid">
                {CTL_CONFIG.labour.rates.map((item) => (
                  <div className="ctl-form-field" key={item.key}>
                    <label htmlFor={`staff-${item.key}`}>
                      {item.label} (฿{item.rate}/hr)
                    </label>
                    <input
                      id={`staff-${item.key}`}
                      className="table-input"
                      type="number"
                      min="0"
                      step="1"
                      value={labourStaff[item.key]}
                      onChange={(e) =>
                        setLabourStaff((current) => ({
                          ...current,
                          [item.key]: Math.max(
                            0,
                            Math.floor(Number(e.target.value) || 0)
                          ),
                        }))
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Cost Item</th>
                  <th>Calculation Details</th>
                  <th className="number">Before VAT</th>
                  <th className="number">VAT 7%</th>
                  <th className="number">Total incl. VAT</th>
                </tr>
              </thead>
              <tbody>
                {CTL_ITEM_DEFS.map((def) => {
                  const row = ctlState[def.key]
                  const isGasoline = def.key === 'gasoline'
                  const isLabour = def.key === 'labour'
                  const isConsumable = def.key === 'consumable'
                  const isTraveling = def.key === 'traveling'
                  const isAutoCost = isConsumable || isTraveling
                  const basePrice = getCtlBasePrice(def.key, row)
                  const totalPrice = computeCtlTotal(basePrice)
                  const vatAmount = totalPrice - basePrice
                  const formatPrice = (price: number) =>
                    price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

                  return (
                    <Fragment key={def.key}>
                      <tr>
                        <td className="ctl-checkbox-cell">
                          <input
                            type="checkbox"
                            checked={row.included}
                            onChange={(e) => updateCtlRow(def.key, { included: e.target.checked })}
                          />
                        </td>

                        <td className={`ctl-label${row.included ? ' included' : ''}`}>
                          {def.label}
                        </td>

                        <td>
                          {isAutoCost ? (
                            <div className="ctl-calculation">
                              <span>
                                {isTraveling
                                  ? (location || 'No location selected')
                                  : 'Calculated automatically'}
                              </span>
                            </div>
                          ) : isGasoline ? (
                            <div className="ctl-calculation">
                              <span>{location || row.location || 'No location selected'}</span>
                              <span>฿{row.ratePerDay.toLocaleString()} × {row.days} day(s)</span>
                            </div>
                          ) : isLabour ? (
                            <div className="ctl-calculation">
                              <span>
                                {Object.values(labourStaff).reduce((sum, count) => sum + count, 0)} technician(s)
                              </span>
                              <span>
                                {row.days} day(s) × {row.workingHoursPerDay} hr/day
                              </span>
                            </div>
                          ) : (
                            <div className="ctl-other-cost">
                              <input
                                className="table-input small number-input"
                                type="number"
                                min="0"
                                step="0.01"
                                disabled={!row.included}
                                value={row.price}
                                onChange={(e) => updateCtlRow(def.key, {
                                  price: Math.max(0, Number(e.target.value)),
                                })}
                              />

                              {def.hasNote && (
                                <input
                                  value={row.note}
                                  onChange={(e) => updateCtlRow(def.key, { note: e.target.value })}
                                  placeholder={def.notePlaceholder}
                                />
                              )}
                            </div>
                          )}
                        </td>

                        <td className="number">
                          {row.included ? `฿ ${formatPrice(basePrice)}` : '-'}
                        </td>
                        <td className="number">
                          {row.included ? `฿ ${formatPrice(vatAmount)}` : '-'}
                        </td>
                        <td className="number">
                          {row.included ? `฿ ${formatPrice(totalPrice)}` : '-'}
                        </td>
                      </tr>

                      {isLabour && row.included && row.days > 0 && (
                        <tr>
                          <td></td>
                          <td colSpan={5} style={{ padding: 0 }}>
                            <div className="labour-panel">
                              <div className="labour-days">
                                {row.dayDescriptions.map((description, dayIndex) => (
                                  <div className="day-row" key={dayIndex}>
                                    <span className="day-badge">{dayIndex + 1}</span>
                                    <input
                                      className="table-input"
                                      type="text"
                                      placeholder={`Day ${dayIndex + 1}: work description`}
                                      value={description}
                                      onChange={(e) => setLabourDayDescription(dayIndex, e.target.value)}
                                    />
                                  </div>
                                ))}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}

                <tr>
                  <td colSpan={3} className="number" style={{ textAlign: 'right' }}>
                    <strong>CTL Subtotal (Before VAT)</strong>
                  </td>
                  <td className="number">
                    <strong>
                      ฿ {CTL_ITEM_DEFS.reduce((sum, def) => {
                        const row = ctlState[def.key]
                        return sum + (row.included ? getCtlBasePrice(def.key, row) : 0)
                      }, 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </strong>
                  </td>
                  <td className="number">
                    <strong>
                      ฿ {(ctlTotal - CTL_ITEM_DEFS.reduce((sum, def) => {
                        const row = ctlState[def.key]
                        return sum + (row.included ? getCtlBasePrice(def.key, row) : 0)
                      }, 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </strong>
                  </td>
                  <td className="number">
                    <strong>
                      ฿ {ctlTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

          <section className="quotation-notes-preview">
            <div className="section-header">
              <div>
                <h2>Note</h2>
                <p>Shown on the PDF — click the box to edit</p>
              </div>

              <button
                type="button"
                className="btn btn-outline"
                onClick={regenerateNote}
                title="Reset to the template, rebuilt from the quotation's current contents"
              >
                Regenerate
              </button>
            </div>

            {noteOutdated && (
              <p className="quotation-note-outdated">
                Quotation details changed since this note was edited
              </p>
            )}

            <div className="quotation-note-editor">
              <textarea
                className="quotation-note-textarea"
                value={noteText}
                onChange={(e) => {
                  setNoteText(e.target.value)
                  setNoteDirty(true)
                }}
                rows={5}
                placeholder="Type quotation notes here…"
              />
            </div>
          </section>
        </div>

        <aside className="qt-right-col">
          <section className="summary-card">
            <div className="summary-row">
              <span>Subtotal</span>
              <strong>฿ {partsSubtotal.toFixed(2)}</strong>
            </div>

            <div className="summary-row">
              <span>Discount</span>

              <div className="summary-input-group">
                <input
                  className="summary-input"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={discountPercent}
                  onChange={(e) =>
                    setDiscountPercent(
                      Math.min(100, Math.max(0, Number(e.target.value)))
                    )
                  }
                />

                <span>%</span>
              </div>
            </div>

            <div className="summary-row">
              <span>Discount Amount</span>
              <strong className="discount-value">
                -฿ {discountAmount.toFixed(2)}
              </strong>
            </div>

            <div className="summary-row">
              <span>Shipping</span>
              <strong>฿ {shippingTotal.toFixed(2)}</strong>
            </div>

            <div className="summary-row">
              <span>Estimated Import Tax</span>
              <strong>฿ {importTaxTotal.toFixed(2)}</strong>
            </div>

            <div className="summary-row">
              <span>CTL Cost</span>
              <strong>฿ {ctlTotal.toFixed(2)}</strong>
            </div>

            <div className="summary-row">
              <span>Total Exc. VAT</span>
              <strong>฿ {totalExcVat.toFixed(2)}</strong>
            </div>

            <div className="summary-row">
              <span>VAT 7%</span>
              <strong>฿ {vat.toFixed(2)}</strong>
            </div>

            <div className="summary-divider" />

            <div className="summary-row grand-total">
              <span>Total Due</span>
              <strong>฿ {totalDue.toFixed(2)}</strong>
            </div>
          </section>

        <div className="quotation-actions">
          {!canSave && (
            <div
              ref={errorSummaryRef}
              tabIndex={-1}
              role="alert"
              aria-atomic="true"
              className="quotation-actions-hint"
            >
              <p className="qt-error-summary-title">Complete required fields before save/export:</p>
              <ul className="qt-error-summary-list">
                {validationErrors.map((fieldLabel) => {
                  const fieldRef = errorSummaryFieldRefs[fieldLabel]
                  return (
                    <li key={fieldLabel}>
                      {fieldRef ? (
                        <button
                          type="button"
                          className="qt-error-summary-link"
                          onClick={() => fieldRef.current?.focus()}
                        >
                          {fieldLabel}
                        </button>
                      ) : (
                        fieldLabel
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {actionError && (
            <p
              className="quotation-actions-error"
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
            >
              {actionError}
            </p>
          )}

          {actionSuccess && (
            <p
              className="quotation-actions-success"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {actionSuccess}
            </p>
          )}

          <div className="quotation-actions-buttons">
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => void saveQuotation()}
              disabled={!canSave || saving || exporting}
            >
              {saving ? 'Saving…' : 'Save Quotation'}
            </button>

            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void exportPDF()}
              disabled={!canSave || saving || exporting}
            >
              {exporting ? 'Exporting…' : 'Export PDF'}
            </button>
          </div>
        </div>
        </aside>

      </main>

      <StockItemPicker
        open={stockPickerOpen}
        onClose={() => setStockPickerOpen(false)}
        onSelect={handleStockSelect}
      />

      <ExternalPartForm
        open={externalFormOpen}
        onClose={closeExternalForm}
        onSubmit={handleExternalSubmit}
        initialGroup={editingGroup}
        focusPartId={focusPartId}
        shippingRule={shippingRule}
      />
    </div>
  )
}

export default App