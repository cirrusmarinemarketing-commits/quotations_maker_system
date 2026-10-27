import jsPDF from 'jspdf'
import { SARABUN_REGULAR_BASE64, SARABUN_BOLD_BASE64 } from '../assets/fonts/sarabunBase64'
import { CIRRUS_LOGO_PNG_BASE64 } from '../assets/cirrusLogoBase64'
import { COMPANY, PDF_LAYOUT } from './quotationPdfConfig'
import type { CostProfitQuotation, CostProfitGroup, CostProfitLine } from '../services/api'

type Basis = 'quoted' | 'bank'

const money = (n: number | null | undefined): string =>
  n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const moneyThb = (n: number | null | undefined): string => (n == null ? '—' : `${money(n)}THB`)

// claude_prompt.txt ("Margin display: 3 decimal places..."): unchanged.
function roundHalfUp3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function marginStr(numerator: number | null, denominator: number | null): string {
  return numerator != null && denominator != null && denominator > 0
    ? `${roundHalfUp3((numerator / denominator) * 100).toFixed(3)}%`
    : '—'
}

function formatDateOnly(dateStr: string | null): string | null {
  if (!dateStr) return null
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return null
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
}

function costForBasis(line: CostProfitLine, basis: Basis): number | null {
  if (!line.costKnown) return null
  return basis === 'quoted' ? line.costQuoted : line.costBank
}

// claude_prompt.txt ("the one without ... notes"): same zero-priced-line
// predicate as the report page's own ItemRow() -- unchanged, see PROGRESS_LOG.md.
function isDescriptionLine(line: CostProfitLine): boolean {
  return (line.kind === 'part' || line.kind === 'stock') && line.unitPriceIncVat === 0 && line.costKnown && line.costQuoted === 0
}

function lineFcValue(line: CostProfitLine, currency: string | null): number | null {
  if (!currency) return null
  return currency === 'THB' ? line.unitCostThb : line.unitCostFc
}
function fcText(value: number | null, currency: string | null): string {
  return value != null && currency ? `${currency} ${money(value)}` : '—'
}

type PdfRow =
  | { type: 'part'; line: CostProfitLine; group: CostProfitGroup | null }
  | { type: 'description'; line: CostProfitLine }
  | { type: 'shipping'; line: CostProfitLine; group: CostProfitGroup }

function collectRows(quotation: CostProfitQuotation): PdfRow[] {
  const rows: PdfRow[] = []
  for (const group of quotation.groups) {
    if (group.kind === 'other') continue
    for (const line of group.lines) {
      if (line.kind === 'shipping') {
        rows.push({ type: 'shipping', line, group })
      } else if (line.kind === 'part' || line.kind === 'stock') {
        rows.push(isDescriptionLine(line) ? { type: 'description', line } : { type: 'part', line, group: group.kind === 'stock' ? null : group })
      }
    }
  }
  return rows
}

const COLS = [
  { key: 'qnum', label: 'Quotation #', w: 20.775 },
  { key: 'part', label: 'Part lists', w: 47.09 },
  { key: 'costFc', label: '', w: 23.545 },
  { key: 'costThbUnit', label: 'Cost price THB Per Unit', w: 23.545 },
  { key: 'qty', label: 'Qty.', w: 9.695 },
  { key: 'costThbTotal', label: 'Total Cost Price THB', w: 23.545 },
  { key: 'unit', label: 'Unit', w: 11.08 },
  { key: 'sell', label: 'Selling Price after Markup +VAT 7% +Shipping', w: 27.7 },
  { key: 'tax', label: 'Import Tax', w: 19.39 },
  { key: 'd10', label: 'Selling Price after Discount 10%', w: 23.545 },
  { key: 'd15', label: 'Selling Price after Discount 15%', w: 23.545 },
  { key: 'd20', label: 'Selling Price after Discount 20%', w: 23.545 },
] as const

export function computeColumnEdges(margin: number): number[] {
  const edges = [margin]
  let x = margin
  for (const c of COLS) {
    x += c.w
    edges.push(x)
  }
  return edges // length 13: edges[0]=margin (left), edges[12]=tableRight
}

// --- Colour palette (fix 5) -- this list and no other colour. ---
const BORDER: [number, number, number] = [154, 166, 181] // #9AA6B5
const TITLE_BG: [number, number, number] = [214, 224, 238] // #D6E0EE
const VALUE_BG: [number, number, number] = [243, 246, 250] // #F3F6FA
const HEADER_BG: [number, number, number] = [227, 234, 243] // #E3EAF3
const MARKUP_HEADER_BG: [number, number, number] = [203, 217, 238] // #CBD9EE
const SHIPPING_BG: [number, number, number] = [247, 249, 251] // #F7F9FB
const LABEL_BG: [number, number, number] = [233, 238, 245] // #E9EEF5 (Total row + the discount table's non-highlighted row labels)
const PROFIT_BG: [number, number, number] = [207, 235, 215] // #CFEBD7 (six-value band only, unchanged by this round)
const LOSS_BG: [number, number, number] = [246, 202, 202] // #F6CACA (six-value band only, unchanged by this round)
const BLACK: [number, number, number] = [0, 0, 0]

const DISCOUNT_PROFIT_TEXT: [number, number, number] = [10, 122, 53] // #0A7A35
const DISCOUNT_LOSS_TEXT: [number, number, number] = [192, 38, 27] // #C0261B
const DISCOUNT_HIGHLIGHT_BG: [number, number, number] = [27, 79, 120] // #1B4F78
const DISCOUNT_HIGHLIGHT_TEXT: [number, number, number] = [255, 255, 255] // #FFFFFF
const DISCOUNT_HIGHLIGHT_PROFIT_TEXT: [number, number, number] = [139, 232, 168] // #8BE8A8
const DISCOUNT_HIGHLIGHT_LOSS_TEXT: [number, number, number] = [255, 163, 155] // #FFA39B

const PT_TO_MM = 25.4 / 72
const PAD_V = 3 * PT_TO_MM
const PAD_H = 5 * PT_TO_MM
const LINE_FACTOR = 1.3 // "line-height at least 1.3"
const BORDER_W = 1 * PT_TO_MM
function lineHeightMm(fontSizePt: number): number {
  return fontSizePt * LINE_FACTOR * PT_TO_MM
}

function profitFill(profit: number | null): [number, number, number] | null {
  if (profit == null) return null
  return profit >= 0 ? PROFIT_BG : LOSS_BG
}

export function buildCostProfitPDFDoc(quotation: CostProfitQuotation, basis: Basis, pdfIn?: jsPDF): jsPDF {
  const pdf = pdfIn ?? new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

  pdf.addFileToVFS('Sarabun-Regular.ttf', SARABUN_REGULAR_BASE64)
  pdf.addFont('Sarabun-Regular.ttf', 'Sarabun', 'normal')
  pdf.addFileToVFS('Sarabun-Bold.ttf', SARABUN_BOLD_BASE64)
  pdf.addFont('Sarabun-Bold.ttf', 'Sarabun', 'bold')

  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 8
  const contentBottom = pageHeight - margin

  const setFont = (size: number, bold = false) => {
    pdf.setFont('Sarabun', bold ? 'bold' : 'normal')
    pdf.setFontSize(size)
    pdf.setTextColor(...BLACK)
  }
  const setBorder = () => {
    pdf.setDrawColor(...BORDER)
    pdf.setLineWidth(BORDER_W)
  }

  const colEdges = computeColumnEdges(margin)
  const colX = colEdges.slice(0, 12)
  const tableRight = colEdges[12]
  const tableWidth = tableRight - margin

  const groupCurrencies = new Set(
    quotation.groups.filter((g) => g.kind === 'external' && g.currency).map((g) => g.currency as string),
  )
  const singleCurrency = groupCurrencies.size === 1 ? [...groupCurrencies][0] : null
  const costFcHeader = singleCurrency ? `Cost price ${singleCurrency} with discount` : 'Cost price (FC) with discount'

  const headerLabels: Record<string, string> = {
    qnum: COLS[0].label,
    part: COLS[1].label,
    costFc: costFcHeader,
    costThbUnit: COLS[3].label,
    qty: COLS[4].label,
    costThbTotal: COLS[5].label,
    unit: COLS[6].label,
    sell: COLS[7].label,
    tax: COLS[8].label,
    d10: COLS[9].label,
    d15: COLS[10].label,
    d20: COLS[11].label,
  }

  let y = margin

  const drawTopHeader = () => {
    const logoY = y
    const logoHeight = PDF_LAYOUT.header.logoHeight
    const logoWidth = logoHeight * (824 / 226)
    pdf.addImage(CIRRUS_LOGO_PNG_BASE64, 'PNG', margin, logoY, logoWidth, logoHeight)

    setFont(7, false)
    COMPANY.companies.forEach((company, index) => {
      pdf.text(company, margin + logoWidth + 3, logoY + 2 + index * 4)
    })
    const dateY = logoY + logoHeight
    const qnumY = dateY - 4

    setFont(9, false)
    pdf.text('Quotation #', tableRight - 43, qnumY, { align: 'right' })
    setFont(9, true)
    pdf.text(quotation.number, tableRight, qnumY, { align: 'right' })
    setFont(9, false)
    pdf.text('Date:', tableRight - 43, dateY, { align: 'right' })
    pdf.text(formatDateOnly(quotation.updatedAt) ?? '—', tableRight, dateY, { align: 'right' })

    y = logoY + logoHeight + 3
  }

  // --- 1. Title band + 2. Value band, built on the 12 column edges (fix 1) ---
  const drawTitleBand = () => {
    const bandH = 8
    pdf.setFillColor(...TITLE_BG)
    pdf.rect(margin, y, tableWidth, bandH, 'F')
    setBorder()
    pdf.rect(margin, y, tableWidth, bandH)
    setFont(13, true)
    pdf.text('Cost & Profit', margin + tableWidth / 2, y + 5.5, { align: 'center' })
    y += bandH
  }

  const drawValueBand = () => {
    const cost = basis === 'quoted' ? quotation.twoTotals.costQuoted : quotation.twoTotals.costBank
    const profit = basis === 'quoted' ? quotation.twoTotals.profitQuoted : quotation.twoTotals.profitBank
    const cells: { label: string; value: string; fill?: [number, number, number] | null }[] = [
      { label: 'Quotation total', value: moneyThb(quotation.twoTotals.quotationTotal) },
      { label: 'Discount', value: quotation.discount ? `−${moneyThb(quotation.discount.amountIncVat)}` : '—' },
      { label: 'Net sales', value: moneyThb(quotation.twoTotals.revenue) },
      { label: 'Cost', value: moneyThb(cost) },
      { label: 'Profit', value: moneyThb(profit), fill: profitFill(profit) },
      { label: 'Margin', value: marginStr(profit, quotation.twoTotals.revenue), fill: profitFill(profit) },
    ]
    const bandH = 12
    for (let i = 0; i < 6; i++) {
      const x0 = colEdges[2 * i]
      const x1 = colEdges[2 * i + 2]
      const w = x1 - x0
      const c = cells[i]
      pdf.setFillColor(...(c.fill ?? VALUE_BG))
      pdf.rect(x0, y, w, bandH, 'F')
      setBorder()
      pdf.rect(x0, y, w, bandH)
      const cx = x0 + w / 2
      setFont(7, false)
      pdf.text(c.label, cx, y + 4.5, { align: 'center' })
      setFont(9.5, true)
      pdf.text(c.value, cx, y + 9, { align: 'center' })
    }
    y += bandH
  }

  // --- 3. Main table ---
  type Cell = { col: number; text: string; align: 'left' | 'center' | 'right'; bold?: boolean; size?: number; noWrap?: boolean }

  const wrapCell = (text: string, w: number, fontSize: number, bold: boolean, noWrap?: boolean): string[] => {
    if (noWrap) return [text]
    setFont(fontSize, bold)
    return pdf.splitTextToSize(text, Math.max(w - 2 * PAD_H, 2))
  }

  const measureRow = (cells: Cell[], defaultSize: number): { lines: string[][]; rowH: number } => {
    const lines = cells.map((c) => wrapCell(c.text, COLS[c.col].w, c.size ?? defaultSize, !!c.bold, c.noWrap))
    const rowH = Math.max(
      ...cells.map((c, i) => Math.max(1, lines[i].length) * lineHeightMm(c.size ?? defaultSize) + 2 * PAD_V),
    )
    return { lines, rowH }
  }

  const drawTextBlock = (lines: string[], x: number, rowY: number, rowH: number, fontSize: number, align: 'left' | 'center' | 'right') => {
    const lh = lineHeightMm(fontSize)
    const blockH = lines.length * lh
    const top = rowY + rowH / 2 - blockH / 2
    lines.forEach((line, i) => {
      pdf.text(line, x, top + lh * (i + 0.5), { align, baseline: 'middle' })
    })
  }

  const drawRowCells = (cells: Cell[], lines: string[][], rowH: number, defaultSize: number, fromCol = 1) => {
    for (let i = fromCol; i < COLS.length; i++) {
      setBorder()
      pdf.rect(colX[i], y, COLS[i].w, rowH)
    }
    cells.forEach((c, i) => {
      if (c.col < fromCol) return
      setFont(c.size ?? defaultSize, !!c.bold)
      const w = COLS[c.col].w
      const x = c.align === 'left' ? colX[c.col] + PAD_H : c.align === 'right' ? colX[c.col] + w - PAD_H : colX[c.col] + w / 2
      drawTextBlock(lines[i], x, y, rowH, c.size ?? defaultSize, c.align)
    })
  }

  const HEADER_SIZE = 6.5
  const drawTableHeader = () => {
    const cells: Cell[] = COLS.map((c, i) => ({ col: i, text: headerLabels[c.key], align: 'center' as const }))
    const { lines, rowH } = measureRow(cells, HEADER_SIZE)
    for (let i = 0; i < COLS.length; i++) {
      const c = COLS[i]
      pdf.setFillColor(...(c.key === 'sell' ? MARKUP_HEADER_BG : HEADER_BG))
      pdf.rect(colX[i], y, c.w, rowH, 'F')
      setBorder()
      pdf.rect(colX[i], y, c.w, rowH)
    }
    cells.forEach((c, i) => {
      setFont(HEADER_SIZE, true)
      drawTextBlock(lines[i], colX[c.col] + COLS[c.col].w / 2, y, rowH, HEADER_SIZE, 'center')
    })
    y += rowH
  }

  let tablePageBroke = false
  const ensureSpace = (needed: number) => {
    if (y + needed > contentBottom) {
      pdf.addPage()
      tablePageBroke = true
      y = margin
      drawTableHeader()
    }
  }

  const ROW_SIZE = 6.5
  const DESC_SIZE = 6.3

  const drawPartRow = (row: Extract<PdfRow, { type: 'part' }>) => {
    const { line, group } = row
    const currency = group?.currency ?? null
    const totalCostThb = line.unitCostThb != null ? line.unitCostThb * line.qty : costForBasis(line, basis)
    const discountedCell = (d: number) =>
      line.unitPriceIncVat != null ? moneyThb(line.unitPriceIncVat * line.qty * (1 - d / 100)) : moneyThb(null)
    const cells: Cell[] = [
      { col: 1, text: line.name, align: 'left' },
      { col: 2, text: fcText(lineFcValue(line, currency), currency), align: 'right', noWrap: true },
      { col: 3, text: moneyThb(line.unitCostThb), align: 'right', noWrap: true },
      { col: 4, text: String(line.qty), align: 'center', noWrap: true },
      { col: 5, text: moneyThb(totalCostThb), align: 'right', noWrap: true },
      { col: 6, text: line.unit ?? '—', align: 'center', noWrap: true },
      { col: 7, text: line.unitPriceIncVat != null ? moneyThb(line.unitPriceIncVat * line.qty) : moneyThb(null), align: 'right', noWrap: true, },
      { col: 8, text: line.importTaxAmount != null ? moneyThb(line.importTaxAmount) : '—', align: 'right', noWrap: true },
      { col: 9, text: discountedCell(10), align: 'right', noWrap: true },
      { col: 10, text: discountedCell(15), align: 'right', noWrap: true },
      { col: 11, text: discountedCell(20), align: 'right', noWrap: true },
    ]
    const { lines, rowH } = measureRow(cells, ROW_SIZE)
    ensureSpace(rowH)
    drawRowCells(cells, lines, rowH, ROW_SIZE)
    y += rowH
  }

  const drawDescriptionRow = (row: Extract<PdfRow, { type: 'description' }>) => {
    const cells: Cell[] = [{ col: 1, text: row.line.name, align: 'left', size: DESC_SIZE }]
    const { lines, rowH } = measureRow(cells, DESC_SIZE)
    ensureSpace(rowH)
    drawRowCells(cells, lines, rowH, DESC_SIZE)
    y += rowH
  }

  const drawShippingRow = (row: Extract<PdfRow, { type: 'shipping' }>) => {
    const { line, group } = row
    const costWithFee = costForBasis(line, basis)
    const cost = costWithFee != null ? costWithFee - (group.transferFee ?? 0) : null
    const currency = group.currency
    const fcValue = currency && currency !== 'THB' && line.unitCostFc != null ? line.unitCostFc : cost
    const charged = moneyThb(line.unitPriceIncVat)
    const cells: Cell[] = [
      { col: 1, text: line.name, align: 'left' },
      { col: 2, text: fcText(fcValue, currency), align: 'right', noWrap: true },
      { col: 3, text: moneyThb(cost), align: 'right', noWrap: true },
      { col: 4, text: '1', align: 'center', noWrap: true },
      { col: 5, text: moneyThb(cost), align: 'right', noWrap: true },
      { col: 6, text: 'LOT', align: 'center', noWrap: true },
      { col: 7, text: charged, align: 'right', noWrap: true },
      { col: 8, text: ' - ', align: 'right', noWrap: true },
      { col: 9, text: charged, align: 'right', noWrap: true },
      { col: 10, text: charged, align: 'right', noWrap: true },
      { col: 11, text: charged, align: 'right', noWrap: true },
    ]
    const { lines, rowH } = measureRow(cells, ROW_SIZE)
    ensureSpace(rowH)
    // claude_prompt.txt, fix 5: "Shipping rows: #F7F9FB (no green)".
    pdf.setFillColor(...SHIPPING_BG)
    pdf.rect(colX[1], y, tableRight - colX[1], rowH, 'F')
    drawRowCells(cells, lines, rowH, ROW_SIZE)
    y += rowH
  }

  const drawTotalRow = (quotation: CostProfitQuotation, partRows: Extract<PdfRow, { type: 'part' }>[]) => {
    const fcSum = singleCurrency != null
      ? partRows
        .filter((r) => (r.group?.currency ?? null) === singleCurrency)
        .reduce((s, r) => s + (lineFcValue(r.line, singleCurrency) ?? 0) * r.line.qty, 0)
      : null
    const costTotal = basis === 'quoted' ? quotation.twoTotals.costQuoted : quotation.twoTotals.costBank
    const d0 = quotation.discountScenarios.find((s) => s.discountPercent === 0)
    // const sellTotal = d0?.revenue ?? null
    const shippingSellTotal = quotation.groups
      .filter((g) => g.kind !== 'other')
      .flatMap((g) => g.lines)
      .filter((l) => l.kind === 'shipping')
      .reduce((sum, l) => sum + (l.unitPriceIncVat ?? 0), 0)
    const sellTotal = d0?.revenue != null ? d0.revenue + shippingSellTotal : null

    const cells: Cell[] = [
      { col: 1, text: 'Total', align: 'left', bold: true },
      { col: 2, text: fcText(fcSum, singleCurrency), align: 'right', bold: true, noWrap: true },
      // { col: 3, text: moneyThb(costTotal), align: 'right', bold: true, noWrap: true },
      { col: 3, text: '', align: 'right', bold: true, noWrap: true },
      { col: 5, text: moneyThb(costTotal), align: 'right', bold: true, noWrap: true },
      { col: 7, text: moneyThb(sellTotal), align: 'right', bold: true, noWrap: true },
      { col: 8, text: moneyThb(quotation.totals.passThroughImportTax), align: 'right', bold: true, noWrap: true },
    ]
    for (const [idx, d] of [[9, 10], [10, 15], [11, 20]] as const) {
      const scenario = quotation.discountScenarios.find((s) => s.discountPercent === d)
      cells.push({ col: idx, text: moneyThb(scenario?.revenue != null ? scenario.revenue + shippingSellTotal : null), align: 'right', bold: true, noWrap: true })
    }
    const { lines, rowH } = measureRow(cells, ROW_SIZE)
    ensureSpace(rowH)
    // claude_prompt.txt, fix 5: "Total row ... #E9EEF5, bold".
    pdf.setFillColor(...LABEL_BG)
    pdf.rect(colX[1], y, tableRight - colX[1], rowH, 'F')
    drawRowCells(cells, lines, rowH, ROW_SIZE)
    y += rowH
  }

  // --- 4. Info box + summary table ---
  const drawInfoAndSummary = (quotation: CostProfitQuotation) => {
    const boxTop = y + 3
    const infoX = margin
    const infoW = 95

    const externalGroups = quotation.groups.filter((g) => g.kind === 'external')
    const multiGroup = externalGroups.length > 1
    const groupsForInfo = externalGroups.length ? externalGroups : [null]

    const infoRows: { label: string; value: string }[] = []
    for (const g of groupsForInfo) {
      const codeSuffix = multiGroup && g ? ` (${g.currency}THB)` : ''
      const isForeign = g != null && g.currency && g.currency !== 'THB'
      const isThbGroup = g != null && g.currency === 'THB'
      const cur = g?.currency ?? null

      if (!isThbGroup) {
        infoRows.push({
          label: `Currency in QT Maker with Buffer${codeSuffix}`,
          value: isForeign && g?.exchangeRate != null ? `${cur}THB ( ${cur} : ฿${g.exchangeRate})` : '—',
        })
      }

      infoRows.push({
        label: `Currency in SCB Web Site${codeSuffix}`,
        value: isThbGroup
          ? (g.actualExchangeRate != null ? `${cur}THB ( ${cur} : ฿${g.actualExchangeRate})` : '—')
          : (isForeign && g?.actualExchangeRate != null ? `${cur}THB (${cur}:฿${g.actualExchangeRate})` : '—'),
      })
      const dateText = g ? formatDateOnly(g.exchangeRateDate) : null
      infoRows.push({ label: `Date${codeSuffix}`, value: dateText ?? '—' })
      infoRows.push({
        label: `Trans Fee${codeSuffix}`,
        value: g?.transferFee != null ? `${money(g.transferFee)} THB` : '—',
      })
      const groupMarkup = g?.lines.find((l) => (l.kind === 'part' || l.kind === 'stock') && l.markupPercent != null)?.markupPercent
      infoRows.push({ label: `Mark up (%)${codeSuffix}`, value: groupMarkup != null ? `${groupMarkup}%` : '—' })
      infoRows.push({ label: `Discount from supplier (%)${codeSuffix}`, value: '—' })
    }

    const sumX = margin + 130
    const sumW = tableRight - sumX // claude_prompt.txt, fix 1: summary table's right edge = main table's right edge.
    const headH = 5.5
    const summaryRowHNatural = 5.5
    const summaryNaturalH = headH + 4 * summaryRowHNatural

    const infoRowHNatural = 4.6
    const infoNaturalH = infoRows.length * infoRowHNatural

    const boxH = Math.max(infoNaturalH, summaryNaturalH)
    const infoRowH = boxH / infoRows.length
    const summaryRowH = (boxH - headH) / 4

    const infoLabelW = infoW * 0.58
    const infoValueW = infoW * 0.42
    let infoY = boxTop
    for (const row of infoRows) {
      pdf.setFillColor(...LABEL_BG)
      pdf.rect(infoX, infoY, infoLabelW, infoRowH, 'F')
      setBorder()
      pdf.rect(infoX, infoY, infoLabelW, infoRowH)
      pdf.rect(infoX + infoLabelW, infoY, infoValueW, infoRowH)
      setFont(6.8, true)
      pdf.text(row.label, infoX + 2, infoY + infoRowH / 2, { align: 'left', baseline: 'middle' })
      setFont(6.8, false)
      pdf.text(row.value, infoX + infoW - 2, infoY + infoRowH / 2, { align: 'right', baseline: 'middle' })
      infoY += infoRowH
    }

    // Right: summary table.
    const sCols = [
      { label: '', w: sumW * 0.22 },
      { label: 'Quotation total', w: sumW * 0.2 },
      { label: 'Cost', w: sumW * 0.16 },
      { label: 'Net sales', w: sumW * 0.16 },
      { label: 'Profit', w: sumW * 0.16 },
      { label: 'Margin (%)', w: sumW * 0.1 },
    ]
    let sx = sumX
    const sColX: number[] = []
    for (const c of sCols) { sColX.push(sx); sx += c.w }

    let sy = boxTop
    pdf.setFillColor(...HEADER_BG)
    pdf.rect(sumX, sy, sumW, headH, 'F')
    setFont(6.5, true)
    sCols.forEach((c, i) => {
      setBorder()
      pdf.rect(sColX[i], sy, c.w, headH)
      if (c.label) pdf.text(c.label, sColX[i] + c.w / 2, sy + headH / 2, { align: 'center', baseline: 'middle' })
    })
    sy += headH

    const rowDefs: { label: string; d: number }[] = [
      { label: 'Cost & Profit', d: 0 },
      { label: 'With Discount 10%', d: 10 },
      { label: 'With Discount 15%', d: 15 },
      { label: 'With Discount 20%', d: 20 },
    ]
    const actualDiscount = quotation.discountPercent != null ? Math.round(quotation.discountPercent) : 0
    for (const rd of rowDefs) {
      const s = quotation.discountScenarios.find((sc) => sc.discountPercent === rd.d)
      const cost = s ? (basis === 'quoted' ? s.costQuoted : s.costBank) : null
      const profit = s ? (basis === 'quoted' ? s.profitQuoted : s.profitBank) : null
      const revenue = s?.revenue ?? null
      const isHighlighted = rd.d === actualDiscount
      const isLoss = profit != null && profit < 0

      if (isHighlighted) {
        pdf.setFillColor(...DISCOUNT_HIGHLIGHT_BG)
        pdf.rect(sColX[0], sy, sumW, summaryRowH, 'F')
      } else {
        pdf.setFillColor(...LABEL_BG)
        pdf.rect(sColX[0], sy, sCols[0].w, summaryRowH, 'F')
      }

      sCols.forEach((c, i) => {
        setBorder()
        pdf.rect(sColX[i], sy, c.w, summaryRowH)
      })

      const plainColor = isHighlighted ? DISCOUNT_HIGHLIGHT_TEXT : BLACK
      const profitColor = isHighlighted
        ? (isLoss ? DISCOUNT_HIGHLIGHT_LOSS_TEXT : DISCOUNT_HIGHLIGHT_PROFIT_TEXT)
        : (isLoss ? DISCOUNT_LOSS_TEXT : DISCOUNT_PROFIT_TEXT)

      setFont(6.3, true)
      pdf.setTextColor(...plainColor)
      pdf.text(rd.label, sColX[0] + sCols[0].w / 2, sy + summaryRowH / 2, { align: 'center', baseline: 'middle' })
      setFont(6.3, isHighlighted)
      pdf.setTextColor(...plainColor)
      pdf.text(moneyThb(s?.quotationTotal ?? null), sColX[1] + sCols[1].w - 1, sy + summaryRowH / 2, { align: 'right', baseline: 'middle' })
      pdf.text(moneyThb(cost), sColX[2] + sCols[2].w - 1, sy + summaryRowH / 2, { align: 'right', baseline: 'middle' })
      pdf.text(moneyThb(revenue), sColX[3] + sCols[3].w - 1, sy + summaryRowH / 2, { align: 'right', baseline: 'middle' })
      setFont(6.3, true)
      pdf.setTextColor(...(profit == null ? plainColor : profitColor))
      pdf.text(moneyThb(profit), sColX[4] + sCols[4].w - 1, sy + summaryRowH / 2, { align: 'right', baseline: 'middle' })
      pdf.text(marginStr(profit, revenue), sColX[5] + sCols[5].w / 2, sy + summaryRowH / 2, { align: 'center', baseline: 'middle' })
      sy += summaryRowH
    }

    y = boxTop + boxH + 2
  }

  drawTopHeader()
  drawTitleBand()
  drawTableHeader()
  const qnumSpanTop = y

  const rows = collectRows(quotation)
  const partRows = rows.filter((r): r is Extract<PdfRow, { type: 'part' }> => r.type === 'part')
  for (const row of rows) {
    if (row.type === 'part') drawPartRow(row)
    else if (row.type === 'description') drawDescriptionRow(row)
    else drawShippingRow(row)
  }
  drawTotalRow(quotation, partRows)

  if (!tablePageBroke) {
    setBorder()
    pdf.rect(colX[0], qnumSpanTop, COLS[0].w, y - qnumSpanTop)
    setFont(7, true)
    const qLines = pdf.splitTextToSize(quotation.number, COLS[0].w - 2)
    const descLines = quotation.description ? pdf.splitTextToSize(quotation.description, COLS[0].w - 2) : []
    setFont(6.3, false)
    const descBlock = descLines.length ? [...qLines, ...descLines] : qLines
    const blockH = descBlock.length * 3
    const startY = qnumSpanTop + (y - qnumSpanTop) / 2 - blockH / 2 + 2.2
    setFont(7, true)
    pdf.text(qLines, colX[0] + COLS[0].w / 2, startY, { align: 'center', lineHeightFactor: 1.2 })
    if (descLines.length) {
      setFont(6, false)
      pdf.text(descLines, colX[0] + COLS[0].w / 2, startY + qLines.length * 3 + 1, { align: 'center', lineHeightFactor: 1.15 })
    }
  }

  y += 3
  ensureSpace(12 + 3 + 45)
  drawValueBand()
  y += 3
  drawInfoAndSummary(quotation)

  return pdf
}

export function generateCostProfitPDF(quotation: CostProfitQuotation, basis: Basis): void {
  buildCostProfitPDFDoc(quotation, basis).save(`Cost & Profit - ${quotation.number}.pdf`)
}
