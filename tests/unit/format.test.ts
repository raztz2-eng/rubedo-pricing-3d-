import { describe, expect, it } from 'vitest'
import { formatMoney, isValidAmount, parseNumber } from '../../src/lib/format'

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

describe('parseNumber — commas are thousands separators only', () => {
  it('accepts "4,200" and "1,250.5"; dot is the decimal point', () => {
    expect(parseNumber('4,200')).toBe(4200)
    expect(parseNumber('1,250.5')).toBe(1250.5)
    expect(parseNumber('1,234,567')).toBe(1234567)
    expect(parseNumber('12.75')).toBe(12.75)
    expect(parseNumber('-4,200')).toBe(-4200)
  })
  it('any other comma is invalid (never 0, never 1.5)', () => {
    for (const bad of ['1,5', '12,34', ',5', '1,5,2', '1,2345', '12,345,67', '4,200,', '1,000.5.1']) {
      expect(Number.isNaN(parseNumber(bad)), bad).toBe(true)
    }
  })
  it('rejects other malformed numbers', () => {
    for (const bad of ['1.2.3', '12abc', '--1', '1 5']) expect(Number.isNaN(parseNumber(bad)), bad).toBe(true)
  })
})

describe('isValidAmount', () => {
  it('numbers ≥ 0 only', () => {
    expect(isValidAmount('4,200')).toBe(true)
    expect(isValidAmount('')).toBe(true)
    expect(isValidAmount('0')).toBe(true)
    expect(isValidAmount('-1')).toBe(false)
    expect(isValidAmount('1,5')).toBe(false)
  })
})
