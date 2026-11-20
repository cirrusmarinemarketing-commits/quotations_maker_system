import { useState, useEffect, useMemo, useCallback, useRef, type FormEvent } from 'react'
import {
  createId,
  createEmptyExternalPart,
  calculateSellingPrice,
  computeShippingAllocation,
  customerShippingForQuotation,
  validateExternalGroup,
  clearStockAllocation,
  CURRENCY_CONFIG,
  lotShipping,
  VAT_RATE,
  type SourceType,
  type ExternalPart,
  type ExternalGroup,
  type ValidationError,
  type DeliveryUnit,
  type CurrencyCode,
} from '../utils/externalPartsAllocation'
import { api } from '../services/api'
import {
  bangkokToday,
  fetchExchangeRates,
  resolveRate,
  normalizeCurrencyCode,
  DEFAULT_CURRENCY_BUFFER,
  type ExchangeRateEntry,
} from '../services/exchangeRate'
export type { ExternalPart, ExternalGroup }
type Unit = {
  id: string
  name: string
  abbreviation: string
  isActive: boolean
  createdAt: string
}
type Props = {
  open: boolean
  onClose: () => void
  onSubmit: (group: ExternalGroup) => void
  initialGroup?: ExternalGroup | null
  focusPartId?: string | null
}
const DEFAULT_MARKUP = 54
const DEFAULT_WARRANTY: Record<SourceType, string> = {
  import: "Manufacturer's Terms",
  local_supplier: "Supplier's Terms",
  local_purchase: '',
}
const CURRENCY_OPTIONS: { code: CurrencyCode; label: string }[] = [
  { code: 'THB', label: 'THB : Thai Baht' },
  { code: 'EUR', label: 'EUR : Euro' },
  { code: 'USD', label: 'USD : US Dollar' },
  { code: 'SGD', label: 'SGD : Singapore Dollar' },
  { code: 'AUD', label: 'AUD : Australian Dollar' },
  { code: 'GBP', label: 'GBP : British Pound' },
]
const RATE_TYPE_LABELS: Record<string, string> = {
  sellNotes: 'Notes sell',
}
const IMPORT_TAX_OPTIONS = [0, 10, 15, 20, 30, 35]
function roundDecimal(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round((Number(value) || 0) * factor + Number.EPSILON) / factor
}
function moneyToCents(value: number): number {
  return Math.round((Number(value) || 0) * 100)
}
function centsToMoney(cents: number): number {
  return cents / 100
}
function toTHB(amount: number, rate: number): number {
  return (Number(amount) || 0) * (Number(rate) || 0)
}
// Reverse of the buffer: raw rate such that raw * (1 + buffer/100) = appliedRate
function actualFromApplied(appliedRate: number, bufferPercent: number): number {
  const multiplier = 1 + (Number(bufferPercent) || 0) / 100
  return multiplier > 0 ? appliedRate / multiplier : appliedRate
}
const RATE_DECIMALS = 6
function applyBuffer(rawRate: number, bufferPercent: number): number {
  return roundDecimal(rawRate * (1 + (Number(bufferPercent) || 0) / 100), RATE_DECIMALS)
}
function calculateShippingVat(shippingCost: number): number {
  const shippingCents = moneyToCents(roundDecimal(shippingCost, 6))
  return centsToMoney(Math.round(shippingCents * 7 / 100))
}
function calculateShippingTotal(shippingCost: number): number {
  const shippingCents = moneyToCents(roundDecimal(shippingCost, 6))
  const vatCents = Math.round(shippingCents * 7 / 100)
  return centsToMoney(shippingCents + vatCents)
}
function createEmptyPart(rate = 1, currency: CurrencyCode = 'THB'): ExternalPart {
  const unitCost = 0
  const unitCostTHB = toTHB(unitCost, rate)
  return createEmptyExternalPart({
    markupPercent: DEFAULT_MARKUP,
    unitCost,
    unitCostTHB,
    unitPrice: calculateSellingPrice(unitCostTHB, DEFAULT_MARKUP, currency),
    unit: 'EA'
  })
}
export default function ExternalPartForm({
  open,
  onClose,
  onSubmit,
  initialGroup,
  focusPartId,
}: Props) {
  const [sourceType, setSourceType] = useState<SourceType>('import')
  const [sourceName, setSourceName] = useState('')
  const [country, setCountry] = useState('')
  const [parts, setParts] = useState<ExternalPart[]>([])
  const [shippingCost, setShippingCost] = useState(0) // THB, before VAT
  const [shippingCostFc, setShippingCostFc] = useState(0) // Original currency, before VAT
  // const [importTax, setImportTax] = useState(0)
  const [estimatedDeliveryValue, setEstimatedDeliveryValue] = useState(0)
  const [estimatedDeliveryUnit, setEstimatedDeliveryUnit] = useState<DeliveryUnit>('weeks')
  const [warranty, setWarranty] = useState(DEFAULT_WARRANTY.import)
  const [installationIncluded, setInstallationIncluded] = useState(false)
  const [units, setUnits] = useState<Unit[]>([])
  const [unitsLoading, setUnitsLoading] = useState(false)
  const [containsStockItems, setContainsStockItems] = useState(false)
  const [pendingFocusPartId, setPendingFocusPartId] = useState<string | null>(null)
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set())
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [brand, setBrand] = useState('')
  const [currency, setCurrency] = useState<CurrencyCode>('THB')
  // Applied exchange rate (raw + buffer). Used for every calculation and stored as exchange_rate.
  const [exchangeRate, setExchangeRate] = useState<number | null>(1)
  // Raw exchange rate before buffer. Not displayed; stored as actual_exchange_rate and
  // used as the base when the buffer is changed (including when editing an existing record).
  const [actualExchangeRate, setActualExchangeRate] = useState<number | null>(1)
  const [rateDate, setRateDate] = useState<string>(bangkokToday)
  const [rateSource, setRateSource] = useState<'unset' | 'bank' | 'manual' | 'loaded'>('unset')
  const [rateLoading, setRateLoading] = useState(false)
  const [rateError, setRateError] = useState('')
  const [rateEntry, setRateEntry] = useState<ExchangeRateEntry | null>(null)
  const [rateNotFoundFor, setRateNotFoundFor] = useState<{ currency: string; date: string } | null>(null)
  const [bufferPercent, setBufferPercent] = useState(DEFAULT_CURRENCY_BUFFER)

  const rateRequestRef = useRef(0)
  const showForeignCost = currency !== 'THB'
  useEffect(() => {
    if (!open) return
    const loadUnits = async () => {
      try {
        setUnitsLoading(true)
        const data = await api.listUnits()
        const activeUnits = Array.isArray(data)
          ? (data as Unit[]).filter((unit) => unit.isActive)
          : []
        setUnits(activeUnits)
        if (activeUnits.length > 0) {
          setParts((prev) =>
            prev.map((part) =>
              part.unit ? part : { ...part, unit: activeUnits[0].abbreviation }
            )
          )
        }
      } catch (error) {
        console.error('Failed to load units:', error)
        setUnits([])
      } finally {
        setUnitsLoading(false)
      }
    }
    loadUnits()
  }, [open])
  useEffect(() => {
    if (!open) return
    setTouchedFields(new Set())
    setSubmitAttempted(false)
    setRateDate(bangkokToday())
    setRateError('')
    setRateEntry(null)
    setRateNotFoundFor(null)
    if (initialGroup) {
      const loadedBuffer = initialGroup.bufferPercent ?? DEFAULT_CURRENCY_BUFFER
      setBufferPercent(loadedBuffer)
      setSourceType(initialGroup.sourceType)
      setSourceName(initialGroup.sourceName)
      setBrand(initialGroup.brand ?? '')
      setCountry(initialGroup.country)
      setParts(initialGroup.parts)
      const loadedCurrency = initialGroup.currency ?? 'THB'
      const loadedRate = initialGroup.exchangeRate ?? 1
      setCurrency(loadedCurrency)
      setExchangeRate(loadedRate)
      // Base for recalculation: the stored raw rate. Records saved before
      // actual_exchange_rate existed fall back to un-buffering the stored rate.
      setActualExchangeRate(
        loadedCurrency === 'THB'
          ? 1
          : initialGroup.actualExchangeRate != null && initialGroup.actualExchangeRate > 0
            ? initialGroup.actualExchangeRate
            : actualFromApplied(loadedRate, loadedBuffer)
      )
      setShippingCost(initialGroup.shippingCost)
      setShippingCostFc(
        initialGroup.shippingCostFc ??
        (loadedCurrency === 'THB'
          ? initialGroup.shippingCost
          : loadedRate > 0
            ? initialGroup.shippingCost / loadedRate
            : 0)
      )
      setRateSource(initialGroup.currency && initialGroup.currency !== 'THB' ? 'loaded' : 'unset')
      setRateDate(initialGroup.exchangeRateDate || bangkokToday())
      const deliveryMatch = initialGroup.estimatedDelivery.match(/^(\d+)\s+(\w+)$/)
      setEstimatedDeliveryValue(deliveryMatch ? Number(deliveryMatch[1]) : 0)
      setEstimatedDeliveryUnit(
        deliveryMatch ? (deliveryMatch[2] as DeliveryUnit) : 'weeks'
      )
      setWarranty(initialGroup.warranty)
      setInstallationIncluded(initialGroup.installationIncluded)
      setContainsStockItems(initialGroup.containsStockItems)
      setPendingFocusPartId(focusPartId ?? null)
    } else {
      setBufferPercent(DEFAULT_CURRENCY_BUFFER)
      setSourceType('import')
      setSourceName('')
      setBrand('')
      setCountry('')
      setParts([])
      setShippingCost(0)
      setShippingCostFc(0)
      setCurrency('THB')
      setExchangeRate(1)
      setActualExchangeRate(1)
      setRateSource('unset')
      setEstimatedDeliveryValue(0)
      setEstimatedDeliveryUnit('weeks')
      setWarranty(DEFAULT_WARRANTY.import)
      setInstallationIncluded(false)
      setContainsStockItems(false)
      setPendingFocusPartId(null)
    }
  }, [open, initialGroup, focusPartId])
  useEffect(() => {
    setParts((prev) =>
      prev.map((part) => {
        const unitCostTHB = toTHB(part.unitCost, exchangeRate ?? 0)
        return {
          ...part,
          unitCostTHB,
          unitPrice: calculateSellingPrice(unitCostTHB, part.markupPercent, currency),
        }
      })
    )
  }, [exchangeRate, currency])
  useEffect(() => {
    const rate = currency === 'THB' ? 1 : exchangeRate ?? 0
    setShippingCost(roundDecimal(toTHB(shippingCostFc, rate), 3))
  }, [shippingCostFc, exchangeRate, currency])
  useEffect(() => {
    if (!pendingFocusPartId) return
    if (!parts.some((part) => part.id === pendingFocusPartId)) return
    const rowEl = document.getElementById(`external-part-row-${pendingFocusPartId}`)
    const inputEl = document.getElementById(`external-part-name-${pendingFocusPartId}`)
    rowEl?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      ; (inputEl as HTMLInputElement | null)?.focus()
    setPendingFocusPartId(null)
  }, [parts, pendingFocusPartId])
  const partsSubtotal = useMemo(
    () =>
      parts.reduce((sum, part) => {
        const quotationQty = part.hasStockPortion
          ? Math.max(0, part.qty - part.stockQty)
          : part.qty
        const lineTotalCents = moneyToCents(part.unitPrice) * quotationQty
        return sum + centsToMoney(lineTotalCents)
      }, 0),
    [parts]
  )
  const calculatedImportTax = useMemo(() => {
    if (sourceType !== 'import') return 0
    return roundDecimal(
      parts.reduce((sum, part) => {
        const quotationQty = part.hasStockPortion
          ? Math.max(0, part.qty - part.stockQty)
          : part.qty
        const lineTotal = centsToMoney(moneyToCents(part.unitPrice) * quotationQty)
        return sum + roundDecimal(lineTotal * (part.importTaxPercent ?? 0) / 100, 3)
      }, 0),
      3
    )
  }, [parts, sourceType])
  const shippingVat = useMemo(
    () => calculateShippingVat(shippingCost),
    [shippingCost]
  )
  const shippingTotal = useMemo(
    () => calculateShippingTotal(shippingCost),
    [shippingCost]
  )
  // const groupTotal = useMemo(
  //   () => roundDecimal(partsSubtotal + shippingTotal + importTax, 6),
  //   [partsSubtotal, shippingTotal, importTax]
  // )
  // claude_prompt.txt, fix 2: "A group opened for editing keeps its stored
  // initialGroup.transferFee when it is re-saved ... A stored null still
  // falls back to the currency default, a new group still uses the currency
  // default, and if the user changes the currency of an existing group the
  // new currency's default applies." `initialGroup` only carries the
  // ORIGINAL currency's fee -- once the user picks a different currency,
  // that stored THB/SGD/etc. figure is no longer meaningful, so this reverts
  // to null (which lotShipping() below already resolves to the new
  // currency's own default) the moment `currency` no longer matches
  // `initialGroup.currency`. A brand-new group (`initialGroup` unset) is
  // null from the start, same as before.
  const storedTransferFee =
    initialGroup && currency === initialGroup.currency ? initialGroup.transferFee ?? null : null
  const onQuotationShipping = useMemo(
    () =>
      customerShippingForQuotation(
        {
          parts,
          shippingCost,
          containsStockItems,
          currency,
          exchangeRate: exchangeRate ?? 0,
          shippingCostFc,
          transferFee: storedTransferFee,
        },
        'A'
      ),
    [parts, shippingCost, shippingCostFc, containsStockItems, currency, exchangeRate, storedTransferFee]
  )
  const onQuotationImportTax = calculatedImportTax
  const groupTotal = useMemo(
    () => roundDecimal(partsSubtotal + onQuotationShipping + calculatedImportTax, 3),
    [partsSubtotal, onQuotationShipping, calculatedImportTax]
  )
  const shippingAllocation = useMemo(
    () => computeShippingAllocation({ parts, shippingCost, containsStockItems }),
    [parts, shippingCost, containsStockItems]
  )
  const boxWeight = shippingAllocation.totalWeight
  const stockWeight = shippingAllocation.stockWeight
  const shippingBreakdown = useMemo(
    () =>
      lotShipping({
        shippingCostFc,
        rate: currency === 'THB' ? 1 : exchangeRate ?? 0,
        currency,
        transferFee: storedTransferFee,
        rule: 'A',
      }),
    [shippingCostFc, exchangeRate, currency, storedTransferFee]
  )
  const shippingBeforeRounding = roundDecimal(shippingBreakdown.shippingThb * (1 + VAT_RATE) + (shippingBreakdown.transferFeeApplied ?? 0), 3)
  const shippingRoundingAdjustment = roundDecimal(shippingBreakdown.customerShipping - shippingBeforeRounding, 3)
  const validationErrors = useMemo<ValidationError[]>(
    () =>
      validateExternalGroup({
        id: '',
        sourceType,
        sourceName,
        brand,
        country,
        parts,
        shippingCost,
        importTax: calculatedImportTax,
        estimatedDelivery: '',
        warranty,
        installationIncluded,
        containsStockItems,
        currency,
        exchangeRate: exchangeRate ?? 0,
        actualExchangeRate: actualExchangeRate ?? 0,
        // claude_prompt.txt, fix 4: "pass the selected date state (rateDate;
        // null when the group is THB or has no date) instead of null."
        exchangeRateDate: currency === 'THB' ? null : rateDate || null,
        shippingCostFc,
        importTaxPercent: initialGroup?.importTaxPercent ?? null,
        transferFee: initialGroup?.transferFee ?? null,
      }),
    [
      sourceType,
      sourceName,
      brand,
      country,
      parts,
      shippingCost,
      calculatedImportTax,
      warranty,
      installationIncluded,
      containsStockItems,
      currency,
      exchangeRate,
      actualExchangeRate,
      initialGroup,
      shippingCostFc,
      rateDate,
    ]
  )
  const errorsByPart = useMemo(() => {
    const map = new Map<string, ValidationError[]>()
    for (const err of validationErrors) {
      if (!err.partId) continue
      map.set(err.partId, [...(map.get(err.partId) ?? []), err])
    }
    return map
  }, [validationErrors])
  const addPart = useCallback(() => {
    const newPart: ExternalPart = {
      ...createEmptyPart(exchangeRate ?? 0, currency),
      unit: 'EA',
    }

    setParts((prev) => [...prev, newPart])
    setPendingFocusPartId(newPart.id)
  }, [exchangeRate, currency])
  const updatePart = useCallback(
    (id: string, patch: Partial<ExternalPart>) => {
      setParts((prev) =>
        prev.map((part) => {
          if (part.id !== id) return part
          const updated = { ...part, ...patch }
          const unitCostTHB = toTHB(updated.unitCost, exchangeRate ?? 0)
          return {
            ...updated,
            unitCostTHB,
            unitPrice: calculateSellingPrice(
              unitCostTHB,
              updated.markupPercent,
              currency
            ),
          }
        })
      )
    },
    [exchangeRate, currency]
  )
  const removePart = useCallback((id: string) => {
    setParts((prev) => prev.filter((part) => part.id !== id))
  }, [])
  const markTouched = useCallback((partId: string, field: string) => {
    const key = `${partId}:${field}`
    setTouchedFields((prev) =>
      prev.has(key) ? prev : new Set(prev).add(key)
    )
  }, [])
  const handleSourceTypeChange = useCallback((value: SourceType) => {
    setSourceType(value)
    setWarranty(DEFAULT_WARRANTY[value])
    if (value === 'local_purchase') setShippingCost(0)
  }, [])

  // claude_prompt.txt ("Fix: ExternalPartForm exchange rate, buffer, transfer
  // fee, rate date in validation"), fix 3: "when actualExchangeRate is null,
  // exchangeRate stays as it is ... never 0" and "When rateSource is
  // 'manual', a buffer change changes only bufferPercent; exchangeRate and
  // actualExchangeRate are not touched." Previously the `rateSource ===
  // 'manual' || actualExchangeRate == null` branch called
  // `applyBuffer(actualExchangeRate, nextBuffer)` even when
  // `actualExchangeRate` was null -- `null * (1 + buffer/100)` coerces to
  // `0` in JS, silently setting exchangeRate to 0 (the audit's finding).
  // Both cases below now simply leave exchangeRate untouched.
  const handleBufferChange = useCallback((value: number) => {
    const nextBuffer = Number.isFinite(value)
      ? Math.min(100, Math.max(0, value))
      : DEFAULT_CURRENCY_BUFFER
    setBufferPercent(nextBuffer)
    if (currency === 'THB') return
    if (rateSource === 'manual') return
    if (actualExchangeRate == null) return

    if (actualExchangeRate > 0) {
      setExchangeRate(applyBuffer(actualExchangeRate, nextBuffer))
    }
  }, [currency, rateSource, actualExchangeRate])
  const loadBankRate = useCallback(async (code: CurrencyCode, date: string) => {
    if (api.mode !== 'ems') return
    if (code === 'THB') return
    const ticket = ++rateRequestRef.current
    setRateLoading(true)
    setRateError('')
    try {
      const entries = await fetchExchangeRates(date)
      if (rateRequestRef.current !== ticket) return
      const resolved = resolveRate(entries, code, bufferPercent)
      if (resolved) {
        setExchangeRate(applyBuffer(Number(resolved.entry.rateToTHB), bufferPercent))
        setActualExchangeRate(Number(resolved.entry.rateToTHB))
        setRateEntry(resolved.entry)
        setRateNotFoundFor(null)
        setRateSource('bank')
      } else {
        setExchangeRate(null)
        setActualExchangeRate(null)
        setRateEntry(null)
        setRateNotFoundFor({ currency: normalizeCurrencyCode(code), date })
        setRateSource('unset')
      }
    } catch (error) {
      if (rateRequestRef.current !== ticket) return
      setRateError(error instanceof Error ? error.message : 'Failed to load exchange rates')
      setRateEntry(null)
      setRateNotFoundFor(null)
    } finally {
      if (rateRequestRef.current === ticket) setRateLoading(false)
    }
  }, [bufferPercent])
  const handleCurrencyChange = useCallback((code: CurrencyCode) => {
    setCurrency(code)
    if (code === 'THB') {
      setExchangeRate(1)
      setActualExchangeRate(1)
      setRateSource('unset')
      setRateError('')
      setRateEntry(null)
      setRateNotFoundFor(null)
      return
    }
    if (api.mode !== 'ems') return
    setRateSource('unset')
    setRateError('')
    setRateEntry(null)
    setRateNotFoundFor(null)
    setExchangeRate(null)
    setActualExchangeRate(null)
    void loadBankRate(code, rateDate)
  }, [loadBankRate, rateDate])
  // claude_prompt.txt, fix 1: "Changing the date always fetches the SCB rate
  // for the new date, whatever rateSource is." The previous `rateSource ===
  // 'manual'` early return (the audit's root cause) is gone -- a date change
  // always calls loadBankRate(), which on success sets actualExchangeRate to
  // the fetched rate, exchangeRate via applyBuffer(), and rateSource back to
  // 'bank' (discarding any earlier typed rate), or keeps the existing
  // error/blocked-submission behaviour on failure -- both already
  // loadBankRate()'s own unchanged behaviour.
  const handleDateChange = useCallback((date: string) => {
    setRateDate(date)
    if (currency === 'THB') return
    void loadBankRate(currency, date)
  }, [currency, loadBankRate])
  // claude_prompt.txt, fix 1: "Typing in the Exchange Rate field ... changes
  // only exchangeRate (and sets rateSource to 'manual'). It must not compute
  // or change actualExchangeRate: remove the use of actualFromApplied
  // there." actualExchangeRate now keeps whatever it already was (the SCB
  // rate of the selected date, a loaded group's stored value, or null).
  const handleManualRateChange = useCallback((value: number | null) => {
    setExchangeRate(value)
    setRateSource('manual')
    setRateError('')
    setRateNotFoundFor(null)
    rateRequestRef.current += 1
  }, [])
  const useBankRate = useCallback(() => {
    void loadBankRate(currency, rateDate)
  }, [currency, rateDate, loadBankRate])
  const resetForm = useCallback(() => {
    setSourceType('import')
    setSourceName('')
    setBrand('')
    setCountry('')
    setParts([])
    setShippingCost(0)
    setCurrency('THB')
    setExchangeRate(1)
    setActualExchangeRate(1)
    setRateSource('unset')
    setRateDate(bangkokToday())
    setRateError('')
    setRateEntry(null)
    setRateNotFoundFor(null)
    setEstimatedDeliveryValue(0)
    setEstimatedDeliveryUnit('weeks')
    setWarranty(DEFAULT_WARRANTY.import)
    setInstallationIncluded(false)
    setContainsStockItems(false)
    setTouchedFields(new Set())
    setSubmitAttempted(false)
    setBufferPercent(DEFAULT_CURRENCY_BUFFER)
  }, [])
  const sourceNameValid = sourceName.trim().length > 0
  const hasParts = parts.length > 0
  const rateValid = currency === 'THB' || (exchangeRate !== null && exchangeRate > 0)
  const partsValid = parts.every(
    (part) =>
      part.partName.trim().length > 0 &&
      part.qty > 0 &&
      part.unitCost >= 0 &&
      part.unit.trim().length > 0
  )
  const canSubmit =
    sourceNameValid &&
    hasParts &&
    partsValid &&
    rateValid &&
    validationErrors.length === 0
  const missingSummary = useMemo(() => {
    if (canSubmit) return null
    const issues: string[] = []
    if (!sourceNameValid) issues.push('Supplier / Source')
    if (!hasParts) {
      issues.push('at least one part')
    } else if (!partsValid) {
      issues.push('part name, qty, and unit on every part')
    }
    if (!rateValid) issues.push('exchange rate > 0')
    if (validationErrors.length > 0) {
      issues.push(
        `${validationErrors.length} stock allocation ${validationErrors.length === 1 ? 'issue' : 'issues'
        }`
      )
    }
    return issues.length > 0 ? `Missing: ${issues.join(', ')}` : null
  }, [
    canSubmit,
    sourceNameValid,
    hasParts,
    partsValid,
    rateValid,
    validationErrors,
  ])
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) {
      setSubmitAttempted(true)
      return
    }
    const estimatedDelivery =
      estimatedDeliveryValue > 0
        ? `${estimatedDeliveryValue} ${estimatedDeliveryUnit}`
        : ''

    const normalizedParts = parts.map((part) => {
      const unitCostTHB = toTHB(part.unitCost, exchangeRate ?? 0)
      const unitPrice = calculateSellingPrice(unitCostTHB, part.markupPercent, currency)
      const quotationQty = part.hasStockPortion
        ? Math.max(0, part.qty - part.stockQty)
        : part.qty
      const lineTotal = centsToMoney(moneyToCents(unitPrice) * quotationQty)
      const importTaxPercent = sourceType === 'import' ? (part.importTaxPercent ?? 0) : 0
      const importTaxAmount = roundDecimal(lineTotal * importTaxPercent / 100, 3)

      return {
        ...part,
        unitCost: roundDecimal(part.unitCost, 6),
        unitCostTHB,
        markupPercent: roundDecimal(part.markupPercent, 6),
        unitPrice,
        importTaxPercent,
        importTaxAmount,
      }
    })

    const group: ExternalGroup = {
      id: initialGroup?.id ?? createId(),
      sourceType,
      sourceName: sourceName.trim(),
      brand: brand.trim(),
      country: country.trim(),
      parts: normalizedParts,
      shippingCost: roundDecimal(shippingCost, 6),
      importTax: roundDecimal(calculatedImportTax, 6),
      estimatedDelivery,
      warranty,
      installationIncluded,
      containsStockItems,
      currency,
      exchangeRate: roundDecimal(exchangeRate ?? 0, 6),
      actualExchangeRate: currency === 'THB' ? 1 : roundDecimal(actualExchangeRate ?? 0, 6),
      exchangeRateDate:
        currency === 'THB' ? null : rateSource === 'bank' && rateEntry ? rateEntry.effectiveDate : rateDate,
      shippingCostFc: roundDecimal(shippingCostFc, 6),
      importTaxPercent: initialGroup?.importTaxPercent ?? null,
      transferFee: shippingBreakdown.transferFeeApplied,
      bufferPercent: roundDecimal(bufferPercent, 3),
    }
    onSubmit(group)
    resetForm()
  }
  const handleContainsStockItemsChange = useCallback((checked: boolean) => {
    setContainsStockItems(checked)
    if (!checked) {
      setParts((prev) => clearStockAllocation(prev))
    }
  }, [])
  const toggleHasStockPortion = useCallback(
    (id: string, checked: boolean) => {
      setParts((prev) =>
        prev.map((part) =>
          part.id === id
            ? {
              ...part,
              hasStockPortion: checked,
              stockQty: checked ? part.stockQty : 0,
            }
            : part
        )
      )
    },
    []
  )
  if (!open) return null
  const chevronBg =
    "url(\"data:image/svg+xml,%3Csvg width='16' height='16' viewBox='0 0 16 16' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M4 6l4 4 4-4' stroke='%23475569' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")"
  const inputStyle: React.CSSProperties = {
    width: '100%',
    height: '44px',
    minHeight: '44px',
    boxSizing: 'border-box',
    padding: '0 12px',
    border: '1px solid #CBD5E1',
    borderRadius: '8px',
    background: '#FFFFFF',
    fontSize: '15px',
    lineHeight: '20px',
    display: 'block',
    flexShrink: 0,
    color: '#0F172A',
  }
  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    appearance: 'none',
    WebkitAppearance: 'none',
    MozAppearance: 'none',
    paddingRight: '40px',
    backgroundImage: chevronBg,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 12px top 14px',
    backgroundSize: '16px 16px',
  }
  // Parts-table selects sit in a narrower cell: spec gives them their own
  // chevron offset/padding (right 8, padding-right 32) instead of the
  // modal-wide field values above.
  const tableSelectStyle: React.CSSProperties = {
    ...selectStyle,
    paddingRight: '32px',
    backgroundPosition: 'right 8px top 14px',
  }
  const numberInputStyle: React.CSSProperties = {
    ...inputStyle,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  }
  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: '6px',
    fontSize: '13px',
    lineHeight: '16px',
    fontWeight: 600,
    color: '#334155',
  }
  const fieldStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    minWidth: 0,
  }

  // Named columns use the spec's exact pixel widths. The two conditional
  // extra columns (Cost (THB) when showForeignCost, and the stock-allocation
  // columns when containsStockItems) have no counterpart in the spec's
  // column list, so their pre-existing widths are kept unchanged (100px/
  // 110px and 88px/120px/72px respectively) rather than invented.
  // A stray, unused extra width token (110px, left over with no header or
  // cell after an earlier removed column) previously sat between Total and
  // Import Tax % / Amount in both branches below -- removed; it rendered as
  // an unlabelled ~110px gap between those two columns.
  const baseColumnWidths = showForeignCost
    ? 'minmax(608px, 1fr) 80px 100px 100px 110px 100px 124px 124px'
    : 'minmax(608px, 1fr) 80px 100px 124px 100px 124px 124px'

  const stockColumnWidths = '88px 120px 72px'
  const taxColumnWidth = '136px'
  const actionColumnWidth = '76px'

  const partsGridColumns = containsStockItems
    ? `${baseColumnWidths} ${taxColumnWidth} ${stockColumnWidths} ${actionColumnWidth}`
    : `${baseColumnWidths} ${taxColumnWidth} ${actionColumnWidth}`

  // Spec states "min-width 1472" for the named columns only (Part Name 608
  // minimum + Qty 80 + Unit 100 + Unit Cost 124 + Markup% 100 + Selling 124
  // + Total 124 + Import Tax 136 + action 76 = 1472). The two conditional
  // extra columns add their own existing widths on top.
  const partsTableMinWidth =
    1472 + (showForeignCost ? 86 : 0) + (containsStockItems ? 280 : 0)

  const partsHeaders = showForeignCost
    ? containsStockItems
      ? ['Part Name *', 'Qty', 'Unit', `Cost (${currency})`, 'Cost (THB)', 'Markup %', 'Selling', 'Total', 'Import Tax % / Amount', 'Keep stock', 'Quote Qty', '']
      : ['Part Name *', 'Qty', 'Unit', `Cost (${currency})`, 'Cost (THB)', 'Markup %', 'Selling', 'Total', 'Import Tax % / Amount', '']
    : containsStockItems
      ? ['Part Name *', 'Qty', 'Unit', 'Unit Cost', 'Markup %', 'Selling', 'Total', 'Import Tax % / Amount', 'Keep stock', 'Quote Qty', '']
      : ['Part Name *', 'Qty', 'Unit', 'Unit Cost', 'Markup %', 'Selling', 'Total', 'Import Tax % / Amount', '']

  // Header cells left-align "Part Name *"/"Unit" and right-align everything
  // else; "Part Name *" gets padding-left 24, the trailing empty (action)
  // header gets padding 12px 24px 12px 8px, all others 12px 8px.
  const headerCellStyleFor = (header: string, isLast: boolean): React.CSSProperties => {
    const isLeftAligned = header === 'Part Name *' || header === 'Unit'
    return {
      display: 'flex',
      alignItems: 'center',
      justifyContent: isLeftAligned ? 'flex-start' : 'flex-end',
      boxSizing: 'border-box',
      padding: header === 'Part Name *' ? '12px 8px 12px 24px' : isLast ? '12px 24px 12px 8px' : '12px 8px',
      fontSize: '11px',
      lineHeight: '16px',
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      color: '#475569',
      whiteSpace: 'normal',
    }
  }
  // Body cells: vertical-align top, padding 12px 8px; first (Part Name)
  // cell padding-left 24, last (action) cell padding-right 24.
  const bodyCellStyleFor = (isFirst: boolean, isLast: boolean): React.CSSProperties => ({
    boxSizing: 'border-box',
    alignSelf: 'start',
    padding: isFirst ? '12px 8px 12px 24px' : isLast ? '12px 24px 12px 8px' : '12px 8px',
    minWidth: 0,
  })

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    background: 'rgba(11, 31, 58, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px 24px',
    overflowY: 'auto',
  }
  const modalStyle: React.CSSProperties = {
    width: '100%',
    maxWidth: '1522px',
    maxHeight: '94vh',
    background: '#FFFFFF',
    borderRadius: '12px',
    boxShadow: '0 24px 64px rgba(11,31,58,0.35)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  }
  const sectionHeadingStyle: React.CSSProperties = {
    fontSize: '16px',
    lineHeight: '24px',
    fontWeight: 600,
    color: '#0F172A',
  }
  const sectionSubtextStyle: React.CSSProperties = {
    marginTop: '2px',
    fontSize: '13px',
    lineHeight: '18px',
    color: '#64748B',
  }
  const cardStyle: React.CSSProperties = {
    border: '1px solid #E2E8F0',
    borderRadius: '12px',
    background: '#FFFFFF',
    flexShrink: 0,
  }
  const readOnlyBoxStyle: React.CSSProperties = {
    height: '44px',
    minHeight: '44px',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: '0 12px',
    border: '1px solid #E2E8F0',
    borderRadius: '8px',
    background: '#F1F5F9',
    fontSize: '15px',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    color: '#475569',
  }
  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="epf-dialog" style={modalStyle} role="dialog" aria-modal="true">
        {/* Inline styles can't target ::placeholder; this scoped rule
            (ancestor-classed to this dialog only) is the one exception. */}
        <style>{'.epf-dialog input::placeholder { color: #64748B; }'}</style>
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid #E2E8F0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: '16px',
            flexShrink: 0,
            background: '#FFFFFF',
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: '18px', lineHeight: '24px', fontWeight: 600, color: '#0F172A' }}>
              {initialGroup ? 'Edit External Source' : 'Add External Source'}
            </h2>
            <div style={{ marginTop: '2px', fontSize: '13px', lineHeight: '18px', color: '#64748B' }}>
              {initialGroup ? 'Edit supplier, parts, and costs' : 'Supplier, parts, and costs'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: '44px',
              height: '44px',
              border: '1px solid #CBD5E1',
              borderRadius: '8px',
              background: '#FFFFFF',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#475569" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <form
          onSubmit={handleSubmit}
          style={{
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '24px', background: '#F8FAFC', overflowY: 'auto', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={cardStyle}>
              <div style={{ padding: '20px 24px 0' }}>
                <div style={sectionHeadingStyle}>Source</div>
                <div style={sectionSubtextStyle}>
                  Where these parts come from
                </div>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                  gap: '20px 16px',
                  padding: '20px 24px 24px',
                  alignItems: 'start',
                }}
              >
                <div style={fieldStyle}>
                  <label style={labelStyle}>Source Type *</label>
                  <select
                    value={sourceType}
                    onChange={(e) =>
                      handleSourceTypeChange(e.target.value as SourceType)
                    }
                    style={selectStyle}
                  >
                    <option value="import">Import</option>
                    <option value="local_supplier">Local Supplier</option>
                    <option value="local_purchase">Local Purchase</option>
                  </select>
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>Supplier / Source *</label>
                  <input
                    type="text"
                    value={sourceName}
                    onChange={(e) => setSourceName(e.target.value)}
                    placeholder="Supplier or source name"
                    style={inputStyle}
                  />
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>Country</label>
                  <input
                    type="text"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    placeholder="e.g. USA"
                    style={inputStyle}
                  />
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>Brand</label>
                  <input
                    type="text"
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    placeholder="e.g. Webasto"
                    style={inputStyle}
                  />
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>Currency</label>
                  <select
                    data-testid="external-currency-select"
                    value={currency}
                    onChange={(e) =>
                      handleCurrencyChange(e.target.value as CurrencyCode)
                    }
                    style={selectStyle}
                  >
                    {CURRENCY_OPTIONS.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>
                    Exchange Rate (1 {currency} → THB)
                    {rateSource === 'manual' && (
                      <span
                        data-testid="external-rate-edited-label"
                        style={{
                          marginLeft: '6px',
                          fontSize: '11px',
                          fontWeight: 400,
                          color: '#b6473f',
                        }}
                      >
                        edited
                      </span>
                    )}
                  </label>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', minWidth: 0 }}>
                    <input
                      data-testid="external-rate-input"
                      type="number"
                      min="0"
                      step="0.000001"
                      value={exchangeRate ?? ''}
                      disabled={currency === 'THB'}
                      placeholder={api.mode === 'ems' && currency !== 'THB' && exchangeRate === null ? '0.000000' : undefined}
                      onChange={(e) => {
                        const raw = e.target.value
                        if (api.mode !== 'ems') {
                          // claude_prompt.txt, fix 1: "Nothing else in the
                          // file may write actualExchangeRate from a typed
                          // or derived value" -- this is the non-'ems'-mode
                          // twin of handleManualRateChange's own onChange
                          // branch below; it typed into the same field, so
                          // it must not touch actualExchangeRate either.
                          const next = raw === '' ? 0 : Number(raw) || 0
                          setExchangeRate(next)
                          return
                        }
                        handleManualRateChange(raw === '' ? null : Number(raw) || 0)
                      }}
                      style={{
                        ...numberInputStyle,
                        background: currency === 'THB' ? '#F1F5F9' : '#FFFFFF',
                        color: currency === 'THB' ? '#475569' : '#0F172A',
                        width: 'auto',
                        flex: '1 1 auto',
                        minWidth: 0,
                      }}
                    />
                    {api.mode === 'ems' && currency !== 'THB' && (
                      <button
                        data-testid="external-use-bank-rate"
                        type="button"
                        onClick={useBankRate}
                        disabled={rateLoading}
                        title="Refetch today's bank rate and drop any manual edit"
                        style={{
                          height: '32px',
                          padding: '0 10px',
                          fontSize: '11px',
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                          border: '1px solid #CBD5E1',
                          borderRadius: '6px',
                          background: '#FFFFFF',
                          color: '#0F172A',
                          cursor: rateLoading ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {rateLoading ? 'Loading…' : 'Use bank rate'}
                      </button>
                    )}
                  </div>
                  {api.mode === 'ems' && currency !== 'THB' && (
                    <div style={{ marginTop: '5px' }}>
                      <input
                        data-testid="external-rate-date-input"
                        type="date"
                        value={rateDate}
                        onChange={(e) => handleDateChange(e.target.value)}
                        style={{ ...inputStyle, fontSize: '12px', padding: '4px 6px', height: '26px' }}
                      />
                    </div>
                  )}
                  {api.mode === 'ems' && currency !== 'THB' && rateSource === 'bank' && rateEntry && (
                    <div data-testid="external-rate-info" style={{ marginTop: '5px', fontSize: '12px', color: '#2563eb' }}>
                      Bank {Number(rateEntry.rateToTHB)} + {bufferPercent}% buffer = {exchangeRate ?? '—'} · rate of {rateEntry.effectiveDate}
                      {' · '}{RATE_TYPE_LABELS[rateEntry.rateType] ?? rateEntry.rateType} · {rateEntry.source}
                      {rateEntry.effectiveDate !== rateDate && (
                        <> — rate of {rateEntry.effectiveDate} used</>
                      )}
                    </div>
                  )}
                  {api.mode === 'ems' && currency !== 'THB' && rateSource === 'loaded' && initialGroup?.exchangeRateDate && (
                    <div data-testid="external-rate-loaded" style={{ marginTop: '5px', fontSize: '12px', color: '#64748B' }}>
                      Rate of {initialGroup.exchangeRateDate} · stored
                    </div>
                  )}
                  {api.mode === 'ems' && currency !== 'THB' && rateSource === 'loaded' && !initialGroup?.exchangeRateDate && (
                    <div data-testid="external-rate-loaded" style={{ marginTop: '5px', fontSize: '12px', color: '#64748B' }}>
                      Stored rate from when this was saved.
                    </div>
                  )}
                  {api.mode === 'ems' && currency !== 'THB' && rateNotFoundFor && (
                    <div data-testid="external-rate-not-found" style={{ marginTop: '5px', fontSize: '12px', color: '#b6473f' }}>
                      No rate for {rateNotFoundFor.currency} on {rateNotFoundFor.date}
                    </div>
                  )}
                  {api.mode === 'ems' && currency !== 'THB' && rateError && (
                    <div data-testid="external-rate-error" style={{ marginTop: '5px', fontSize: '12px', color: '#b6473f' }}>
                      Could not load exchange rates: {rateError}
                    </div>
                  )}
                  {currency !== 'THB' && rateSource !== 'bank' && !rateError && !rateNotFoundFor && (
                    <div
                      style={{
                        marginTop: '5px',
                        fontSize: '12px',
                        color: '#64748B',
                      }}
                    >
                      e.g. 1 {currency} = 35.5000 THB → enter 35.5000
                    </div>
                  )}
                </div>
                <div style={fieldStyle}>
                  <label htmlFor="currency-buffer" style={labelStyle}>
                    Buffer (%)
                  </label>
                  <input
                    id="currency-buffer"
                    data-testid="currency-buffer-input"
                    type="number"
                    min={0}
                    max={500}
                    step="any"
                    value={bufferPercent}
                    onChange={(e) => {
                      const value = e.target.value === '' ? 0 : Number(e.target.value)
                      handleBufferChange(value)
                    }}
                    style={numberInputStyle}
                  />
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>Estimated Delivery</label>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '8px',
                    }}
                  >
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={
                        estimatedDeliveryValue === 0
                          ? ''
                          : estimatedDeliveryValue
                      }
                      onChange={(e) => {
                        const value = Number(e.target.value)
                        setEstimatedDeliveryValue(
                          Number.isInteger(value) && value > 0 ? value : 0
                        )
                      }}
                      placeholder="Number"
                      style={numberInputStyle}
                    />
                    <select
                      value={estimatedDeliveryUnit}
                      onChange={(e) =>
                        setEstimatedDeliveryUnit(e.target.value as DeliveryUnit)
                      }
                      style={selectStyle}
                    >
                      <option value="days">Days</option>
                      <option value="weeks">Weeks</option>
                      <option value="months">Months</option>
                      <option value="years">Years</option>
                    </select>
                  </div>
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>Shipping Cost Before VAT ({currency})</label>
                  <input
                    type="number"
                    min="0"
                    step="0.00000001"
                    value={shippingCostFc}
                    disabled={sourceType === 'local_purchase'}
                    onChange={(e) =>
                      setShippingCostFc(roundDecimal(Number(e.target.value) || 0, 6))
                    }
                    style={{
                      ...numberInputStyle,
                      background: sourceType === 'local_purchase' ? '#F1F5F9' : '#FFFFFF',
                      color: sourceType === 'local_purchase' ? '#475569' : '#0F172A',
                    }}
                  />
                  <div style={{ marginTop: '5px', fontSize: '12px', lineHeight: '16px', color: '#64748B', fontVariantNumeric: 'tabular-nums' }}>
                    Shipping Cost Before VAT (THB): ฿
                    {shippingCost.toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </div>
                  <div style={{ marginTop: '3px', fontSize: '12px', lineHeight: '16px', color: '#64748B', fontVariantNumeric: 'tabular-nums' }}>
                    + VAT 7% = ฿
                    {shippingVat.toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </div>
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>Total Import Duty / Tax (THB)</label>
                  <div style={readOnlyBoxStyle}>
                    ฿{calculatedImportTax.toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </div>
                  <div style={{ marginTop: '5px', fontSize: '12px', lineHeight: '16px', color: '#64748B' }}>
                    Calculated from each part's Import Tax rate.
                  </div>
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>Warranty</label>
                  <input
                    type="text"
                    value={warranty}
                    onChange={(e) => setWarranty(e.target.value)}
                    placeholder="Warranty terms"
                    style={inputStyle}
                  />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '10px',
                      fontSize: '14px',
                      color: '#0F172A',
                      cursor: 'pointer',
                      minHeight: '44px',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={installationIncluded}
                      onChange={(e) =>
                        setInstallationIncluded(e.target.checked)
                      }
                      style={{
                        width: '18px',
                        height: '18px',
                        minWidth: '18px',
                        minHeight: '18px',
                        margin: 0,
                        accentColor: '#0284C7',
                      }}
                    />
                    Installation Included
                  </label>
                </div>
              </div>
            </div>
            <div style={{ ...cardStyle, overflow: 'hidden' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '20px 24px 16px',
                }}
              >
                <div>
                  <div style={sectionHeadingStyle}>Parts</div>
                  <div style={sectionSubtextStyle}>
                    Add one or more parts from this source.
                    {showForeignCost && (
                      <>
                        {' '}
                        Unit cost is in <strong>{currency}</strong>, converted at
                        rate <strong>{exchangeRate ?? '(not set)'}</strong>.
                      </>
                    )}
                  </div>
                </div>
              </div>
              {/* <div
              style={{
                marginTop: 12,
                padding: '12px 14px',
                border: '1px solid #e5e7eb',
                borderRadius: 8,
                background: '#f9fafb',
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                <input
                  type="checkbox"
                  checked={containsStockItems}
                  onChange={(e) =>
                    handleContainsStockItemsChange(e.target.checked)
                  }
                />
                Contains stock items
              </label>
            </div> */}
            {parts.length === 0 ? (
              <div
                style={{
                  width: '100%',
                  minHeight: '112px',
                  border: '1px dashed #CBD5E1',
                  borderRadius: '10px',
                  background: '#F8FAFC',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexDirection: 'column',
                  gap: '10px',
                  margin: '0 24px 20px',
                  boxSizing: 'border-box',
                }}
              >
                <div style={{ fontSize: '14px', color: '#64748B' }}>
                  No parts added yet.
                </div>
                <button
                  type="button"
                  onClick={addPart}
                  style={{
                    height: '44px',
                    padding: '0 16px',
                    fontSize: '14px',
                    fontWeight: 500,
                    border: '1px solid #BAE6FD',
                    borderRadius: '8px',
                    background: '#FFFFFF',
                    color: '#0369A1',
                    cursor: 'pointer',
                  }}
                >
                  + Add First Part
                </button>
              </div>
            ) : (
              <div
                style={{
                  width: '100%',
                  overflowX: 'auto',
                  borderTop: '1px solid #E2E8F0',
                }}
              >
                <div style={{ minWidth: `${partsTableMinWidth}px`, fontSize: '14px', fontVariantNumeric: 'tabular-nums' }}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: partsGridColumns,
                      minHeight: '40px',
                      borderBottom: '1px solid #E2E8F0',
                      background: '#F8FAFC',
                    }}
                  >
                    {partsHeaders.map((header, idx) => (
                      <div
                        key={`${header}-${idx}`}
                        style={headerCellStyleFor(header, idx === partsHeaders.length - 1)}
                      >
                        {header}
                      </div>
                    ))}
                  </div>
                  {parts.map((part) => {
                    const partErrors = errorsByPart.get(part.id) ?? []
                    const weightError = partErrors.find(
                      (e) => e.field === 'unitWeight'
                    )
                    const stockQtyError = partErrors.find(
                      (e) => e.field === 'stockQty'
                    )
                    const unitMissing = !part.unit
                    const excludedFromQuotation =
                      part.hasStockPortion &&
                      part.stockQty >= part.qty &&
                      part.qty > 0
                    const quotationQtyValue = part.hasStockPortion
                      ? part.qty - part.stockQty
                      : part.qty
                    const lineTotal = centsToMoney(
                      moneyToCents(part.unitPrice) * quotationQtyValue
                    )
                    const importTaxPercent = part.importTaxPercent ?? 0
                    const importTaxAmount = roundDecimal(lineTotal * importTaxPercent / 100, 3)
                    const costTHB =
                      part.unitCostTHB ??
                      toTHB(part.unitCost, exchangeRate ?? 0)
                    const showWeightError =
                      weightError &&
                      (submitAttempted ||
                        touchedFields.has(`${part.id}:unitWeight`))
                    const showStockQtyError =
                      stockQtyError &&
                      (submitAttempted ||
                        touchedFields.has(`${part.id}:stockQty`))
                    const showUnitError =
                      unitMissing &&
                      (submitAttempted ||
                        touchedFields.has(`${part.id}:unit`))
                    return (
                      <div
                        key={part.id}
                        id={`external-part-row-${part.id}`}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: partsGridColumns,
                          minHeight: '48px',
                          borderBottom: '1px solid #F1F5F9',
                          boxSizing: 'border-box',
                          background:
                            pendingFocusPartId === part.id
                              ? '#fff7e0'
                              : '#fff',
                        }}
                      >
                        <div style={bodyCellStyleFor(true, false)}>
                          <input
                            id={`external-part-name-${part.id}`}
                            type="text"
                            value={part.partName}
                            onChange={(e) =>
                              updatePart(part.id, {
                                partName: e.target.value,
                              })
                            }
                            placeholder="Part name"
                            style={inputStyle}
                          />
                        </div>
                        <div style={bodyCellStyleFor(false, false)}>
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={part.qty}
                            onChange={(e) =>
                              updatePart(part.id, {
                                qty: Math.max(
                                  1,
                                  Number(e.target.value) || 1
                                ),
                              })
                            }
                            style={numberInputStyle}
                          />
                        </div>
                        <div style={bodyCellStyleFor(false, false)}>
                          <select
                            value={part.unit}
                            onChange={(e) =>
                              updatePart(part.id, {
                                unit: e.target.value,
                              })
                            }
                            onBlur={() =>
                              markTouched(part.id, 'unit')
                            }
                            disabled={unitsLoading}
                            style={{
                              ...tableSelectStyle,
                              color: unitMissing ? '#64748B' : '#0F172A',
                              borderColor: showUnitError
                                ? '#d32f2f'
                                : '#CBD5E1',
                            }}
                          >
                            <option value="">
                              {unitsLoading
                                ? 'Loading...'
                                : units.length === 0
                                  ? 'No units'
                                  : 'Select unit'}
                            </option>
                            {units.map((unit) => (
                              <option
                                key={unit.id}
                                value={unit.abbreviation}
                              >
                                {unit.abbreviation}
                              </option>
                            ))}
                          </select>
                          {showUnitError && (
                            <div
                              style={{
                                marginTop: '3px',
                                fontSize: '10px',
                                color: '#d32f2f',
                              }}
                            >
                              Required
                            </div>
                          )}
                        </div>
                        <div style={bodyCellStyleFor(false, false)}>
                          <input
                            type="number"
                            min="0"
                            step="0.0001"
                            value={part.unitCost}
                            onChange={(e) =>
                              updatePart(part.id, {
                                unitCost: roundDecimal(
                                  Number(e.target.value) || 0,
                                  6
                                ),
                              })
                            }
                            placeholder={
                              showForeignCost ? currency : '0.0000'
                            }
                            style={numberInputStyle}
                          />
                        </div>
                        {showForeignCost && (
                          <div style={bodyCellStyleFor(false, false)}>
                            <div style={readOnlyBoxStyle}>
                              ฿
                              {costTHB.toLocaleString('en-US', {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </div>
                          </div>
                        )}
                        <div style={bodyCellStyleFor(false, false)}>
                          <input
                            type="number"
                            min="0"
                            step="0.0001"
                            value={part.markupPercent}
                            onChange={(e) =>
                              updatePart(part.id, {
                                markupPercent: roundDecimal(
                                  Number(e.target.value) || 0,
                                  6
                                ),
                              })
                            }
                            style={numberInputStyle}
                          />
                        </div>
                        <div style={bodyCellStyleFor(false, false)}>
                          <div style={readOnlyBoxStyle}>
                            ฿
                            {part.unitPrice.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </div>
                        </div>
                        <div style={bodyCellStyleFor(false, false)}>
                          <div style={readOnlyBoxStyle}>
                            ฿
                            {lineTotal.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </div>
                        </div>
                        <div style={bodyCellStyleFor(false, false)}>
                          <select
                            value={importTaxPercent}
                            disabled={sourceType !== 'import'}
                            onChange={(e) => updatePart(part.id, { importTaxPercent: Number(e.target.value) })}
                            style={{ ...tableSelectStyle, fontSize: '12px' }}
                          >
                            {IMPORT_TAX_OPTIONS.map((rate) => (
                              <option key={rate} value={rate}>{rate}%</option>
                            ))}
                          </select>
                          <div style={{ marginTop: '4px', fontSize: '11px', color: '#64748B', textAlign: 'right' }}>
                            ฿{importTaxAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>

                        {containsStockItems && (
                          <>
                            <div style={{ padding: '0 6px' }}>
                              <input
                                type="number"
                                min="0"
                                step="0.0001"
                                value={
                                  part.unitWeight === 0
                                    ? ''
                                    : part.unitWeight
                                }
                                placeholder="0.0000"
                                onBlur={() =>
                                  markTouched(
                                    part.id,
                                    'unitWeight'
                                  )
                                }
                                onChange={(e) =>
                                  updatePart(part.id, {
                                    unitWeight: roundDecimal(
                                      Number(e.target.value) || 0,
                                      6
                                    ),
                                  })
                                }
                                style={{
                                  ...numberInputStyle,
                                  borderColor: showWeightError
                                    ? '#d32f2f'
                                    : '#ccc',
                                }}
                              />
                              {showWeightError && (
                                <div
                                  style={{
                                    marginTop: '3px',
                                    fontSize: '10px',
                                    color: '#d32f2f',
                                  }}
                                >
                                  Required, &gt; 0
                                </div>
                              )}
                            </div>
                            <div
                              style={{
                                padding: '0 6px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '4px',
                                minWidth: 0,
                              }}
                            >
                              <label
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '5px',
                                  fontSize: '11px',
                                  color: '#555',
                                  cursor: 'pointer',
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={part.hasStockPortion}
                                  onChange={(e) =>
                                    toggleHasStockPortion(
                                      part.id,
                                      e.target.checked
                                    )
                                  }
                                />
                                Keep for inventory
                              </label>
                              {part.hasStockPortion && (
                                <>
                                  <input
                                    type="number"
                                    min="1"
                                    step="1"
                                    max={part.qty}
                                    placeholder="Qty"
                                    value={
                                      part.stockQty === 0
                                        ? ''
                                        : part.stockQty
                                    }
                                    onBlur={() =>
                                      markTouched(
                                        part.id,
                                        'stockQty'
                                      )
                                    }
                                    onChange={(e) =>
                                      updatePart(part.id, {
                                        stockQty:
                                          Number(e.target.value) || 0,
                                      })
                                    }
                                    style={{
                                      ...numberInputStyle,
                                      height: '30px',
                                      minHeight: '30px',
                                      borderColor:
                                        showStockQtyError
                                          ? '#d32f2f'
                                          : '#ccc',
                                    }}
                                  />
                                  {showStockQtyError && (
                                    <div
                                      style={{
                                        fontSize: '10px',
                                        color: '#d32f2f',
                                      }}
                                    >
                                      0 &lt; Qty ≤ {part.qty}
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                            <div
                              style={{
                                padding: '0 6px',
                                fontSize: '12px',
                              }}
                            >
                              {excludedFromQuotation ? (
                                <span style={{ color: '#d32f2f' }}>
                                  0 (to stock)
                                </span>
                              ) : (
                                <span>{quotationQtyValue}</span>
                              )}
                            </div>
                          </>
                        )}
                        <div style={{ ...bodyCellStyleFor(false, true), display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            onClick={() => removePart(part.id)}
                            title="Remove part"
                            aria-label="Remove part"
                            style={{
                              width: '44px',
                              height: '44px',
                              minWidth: '44px',
                              minHeight: '44px',
                              padding: 0,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              border: '1px solid #CBD5E1',
                              borderRadius: '8px',
                              background: '#FFFFFF',
                              cursor: 'pointer',
                            }}
                          >
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#B91C1C" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                              <path d="M4 4l8 8M12 4l-8 8" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    )
                  })}
                  <div
                    style={{
                      padding: '16px 24px 20px',
                      borderTop: '1px solid #F1F5F9',
                      display: 'flex',
                    }}
                  >
                    <button
                      type="button"
                      onClick={addPart}
                      style={{
                        height: '44px',
                        padding: '0 16px',
                        fontSize: '14px',
                        fontWeight: 500,
                        border: '1px solid #BAE6FD',
                        borderRadius: '8px',
                        background: '#FFFFFF',
                        color: '#0369A1',
                        cursor: 'pointer',
                      }}
                    >
                      + Add Part
                    </button>
                  </div>
                </div>
              </div>
            )}
            </div>

            {parts.length > 0 && (
              <div style={cardStyle}>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '8px 16px',
                    padding: '20px 24px 0',
                  }}
                >
                  <div>
                    <div style={sectionHeadingStyle}>Summary</div>
                    <div style={sectionSubtextStyle}>Amounts that go on the quotation</div>
                  </div>
                  <div
                    style={{
                      fontSize: '24px',
                      lineHeight: '32px',
                      fontWeight: 600,
                      color: '#0369A1',
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    ฿ {groupTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                </div>

                <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                    gap: '12px',
                  }}
                >
                  {[
                    ['Parts', partsSubtotal],
                    ['Customer shipping', onQuotationShipping],
                    ['Import tax', calculatedImportTax],
                  ].map(([label, amount]) => (
                    <div
                      key={String(label)}
                      style={{
                        padding: '12px 16px',
                        borderRadius: '10px',
                        background: '#F8FAFC',
                        border: '1px solid #E2E8F0',
                      }}
                    >
                      <div style={{ fontSize: '12px', lineHeight: '16px', color: '#475569', marginBottom: '4px' }}>
                        {label}
                      </div>
                      <div
                        style={{
                          fontSize: '18px',
                          lineHeight: '24px',
                          fontWeight: 600,
                          color: '#0F172A',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        ฿ {Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Shipping calculation details */}
                <div
                  style={{
                    padding: '16px 20px',
                    borderRadius: '10px',
                    border: '1px solid #BAE6FD',
                    background: '#F0F9FF',
                    fontSize: '13px',
                    lineHeight: '20px',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <div style={{ fontSize: '14px', lineHeight: '20px', fontWeight: 600, color: '#0369A1', marginBottom: '8px' }}>
                    Shipping Breakdown
                  </div>

                  {[
                    [
                      `Shipping Cost (${currency})`,
                      `${currency} ${Number(shippingCostFc).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    ],
                    [
                      'Shipping Cost (THB)',
                      `฿ ${Number(shippingBreakdown.shippingThb).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    ],
                    [
                      `Exchange Rate`,
                      currency === 'THB' ? '1.0000' : Number(exchangeRate ?? 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }),
                    ],
                    [
                      `Shipping VAT (${(VAT_RATE * 100).toFixed(0)}%)`,
                      `฿ ${(shippingBreakdown.shippingThb * VAT_RATE).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    ],
                    [
                      'Trans Fee',
                      `฿ ${Number(shippingBreakdown.transferFeeApplied ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    ],
                    [
                      'Rounding Adjustment',
                      `฿ ${Number(shippingRoundingAdjustment).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    ],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '12px',
                        padding: '6px 0',
                      }}
                    >
                      <span style={{ color: '#475569' }}>{label}</span>
                      <strong style={{ color: '#0F172A', fontWeight: 400, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                        {value}
                      </strong>
                    </div>
                  ))}

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: '12px',
                      marginTop: '8px',
                      paddingTop: '12px',
                      borderTop: '1px solid #BAE6FD',
                    }}
                  >
                    <strong style={{ color: '#0369A1', fontWeight: 600 }}>Customer Shipping Total</strong>
                    <strong style={{ color: '#0369A1', fontSize: '16px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      ฿ {Number(onQuotationShipping).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </strong>
                  </div>
                </div>

                {containsStockItems && (
                  <div
                    style={{
                      paddingTop: '10px',
                      borderTop: '1px solid #f1f5f9',
                      fontSize: '12px',
                      color: '#6b7280',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '8px 16px',
                    }}
                  >
                    <span>
                      Box weight <strong style={{ color: '#374151' }}>{boxWeight.toFixed(2)} kg</strong>
                    </span>
                    <span>
                      Stock <strong style={{ color: '#374151' }}>{stockWeight.toFixed(2)} kg</strong>{' '}
                      ({(shippingAllocation.ratio * 100).toFixed(1)}%)
                    </span>
                    <span style={{ color: '#9ca3af' }}>
                      Internal split only — not shown to customer
                    </span>
                  </div>
                )}
                </div>
              </div>
            )}

          </div>
          <div
            style={{
              padding: '16px 24px',
              borderTop: '1px solid #E2E8F0',
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px 16px',
              background: '#FFFFFF',
              flexShrink: 0,
            }}
          >
            <div style={{ fontSize: '13px', lineHeight: '20px', color: '#B45309' }}>
              {missingSummary}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  height: '44px',
                  padding: '0 16px',
                  fontSize: '14px',
                  fontWeight: 500,
                  border: '1px solid #CBD5E1',
                  borderRadius: '8px',
                  background: '#FFFFFF',
                  color: '#0F172A',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                style={{
                  height: '44px',
                  padding: '0 16px',
                  border: canSubmit ? 'none' : '1px solid #7FB4D6',
                  borderRadius: '8px',
                  background: canSubmit ? '#0369A1' : '#7FB4D6',
                  color: '#FFFFFF',
                  fontWeight: 600,
                  fontSize: '14px',
                  cursor: canSubmit ? 'pointer' : 'not-allowed',
                }}
                onMouseEnter={(e) => {
                  if (canSubmit) e.currentTarget.style.background = '#075985'
                }}
                onMouseLeave={(e) => {
                  if (canSubmit) e.currentTarget.style.background = '#0369A1'
                }}
              >
                {initialGroup ? 'Save Changes' : 'Add External Source'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}