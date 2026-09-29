const moneyFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Formats a ₪ amount for display: `₪1,234.56`. Non-finite values render as an em dash. */
export function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const sign = value < 0 ? '-' : ''
  return `${sign}₪${moneyFormatter.format(Math.abs(value))}`
}

/** Rounds to 2 decimals (display/testing helper only — never store rounded values). */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function formatNumber(value: number, maxDigits = 3): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: maxDigits }).format(value)
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('he-IL', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

/**
 * Parses a user-entered number. Empty → 0; anything non-numeric → NaN (never silently 0).
 * A single comma is accepted as the decimal separator ("1,5" → 1.5).
 */
export function parseNumber(text: string): number {
  let t = text.trim()
  if (t === '') return 0
  if (/^[+-]?\d*,\d+$/.test(t)) t = t.replace(',', '.')
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
}
