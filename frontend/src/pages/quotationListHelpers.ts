// claude_prompt.txt ("v182 -- Quotation List: Display Creator Name"): split
// out of QuotationList.tsx so it can be exported and unit-tested --
// react-refresh/only-export-components forbids exporting a plain function
// from a file whose default export is a component.

export function getCreatedByName(quotation: { created_by_name?: string | null }): string {
  return quotation.created_by_name || '—'
}
