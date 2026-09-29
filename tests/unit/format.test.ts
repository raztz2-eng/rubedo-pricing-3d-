import { describe, expect, it } from 'vitest'
import { formatMoney, parseNumber } from '../../src/lib/format'

describe('formatMoney', () => {
  it('formats like ₪1,234.56', () => {
    expect(formatMoney(83.369)).toBe('₪83.37')
    expect(formatMoney(1234.5)).toBe('₪1,234.50')
    expect(formatMoney(0)).toBe('₪0.00')
  })
  it('shows a dash for invalid values', () => {
    expect(formatMoney(NaN)).toBe('—')
  })
})

describe('parseNumber', () => {
  it('empty → 0, number → number, junk → NaN', () => {
    expect(parseNumber('')).toBe(0)
    expect(parseNumber(' 12.5 ')).toBe(12.5)
    expect(Number.isNaN(parseNumber('abc'))).toBe(true)
  })
})

describe('parseNumber — Israeli input', () => {
  it('accepts a comma as the decimal separator', () => {
    expect(parseNumber('1,5')).toBe(1.5)
    expect(parseNumber(',5')).toBe(0.5)
    expect(parseNumber('12.75')).toBe(12.75)
  })
  it('rejects malformed numbers (never 0)', () => {
    for (const bad of ['1,5,2', '1.2.3', '1,000.5', '12abc', '--1', '1 5']) expect(Number.isNaN(parseNumber(bad)), bad).toBe(true)
  })
})
