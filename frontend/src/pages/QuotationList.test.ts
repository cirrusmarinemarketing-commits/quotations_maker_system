import { describe, it, expect } from 'vitest'
import { getCreatedByName } from './quotationListHelpers'

// claude_prompt.txt ("v182 -- Quotation List: Display Creator Name"): the
// backend already guarantees created_by_name is either a trimmed, single-
// space-joined name or NULL (NULLIF/CONCAT_WS -- see progress_log_v2.md
// v181/v182), but this helper is the frontend's own, independent fallback
// decision, so it gets its own direct test rather than relying on that
// backend guarantee alone.

describe('getCreatedByName', () => {
  it('returns the name as-is when present', () => {
    expect(getCreatedByName({ created_by_name: 'Jirawat Janjobtam' })).toBe('Jirawat Janjobtam')
  })

  it('falls back to an em dash when null', () => {
    expect(getCreatedByName({ created_by_name: null })).toBe('—')
  })

  it('falls back to an em dash when undefined', () => {
    expect(getCreatedByName({})).toBe('—')
  })

  it('falls back to an em dash when empty string', () => {
    expect(getCreatedByName({ created_by_name: '' })).toBe('—')
  })

  // Documents actual behaviour, not an assumption: '||' only checks
  // falsiness, and a non-empty whitespace string is truthy in JS, so this
  // helper does NOT independently trim/blank-check -- it relies entirely on
  // the backend's own NULLIF(TRIM(...)) guarantee never to send one. Not a
  // live bug (the backend contract makes this unreachable today), but
  // worth having pinned down rather than assumed either way.
  it('a whitespace-only value is NOT converted to the em dash (relies on the backend never sending one)', () => {
    expect(getCreatedByName({ created_by_name: '   ' })).toBe('   ')
  })
})
