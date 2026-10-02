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
 * Parses a user-entered number. Empty → 0; anything malformed → NaN (never silently 0).
 * Dot is the decimal point. A comma is accepted ONLY as a thousands separator in the exact pattern
 * 1–3 digits then groups of ",ddd" ("4,200" → 4200, "1,250.5" → 1250.5). Any other comma ("1,5") → NaN.
 */
export function parseNumber(text: string): number {
  let t = text.trim()
  if (t === '') return 0
  if (t.includes(',')) {
    if (!/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return NaN
    t = t.replace(/,/g, '')
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
}

/** Shared field rule (bid form + settings): a parseable number that is not negative. */
export function isValidAmount(text: string): boolean {
  const n = parseNumber(text)
  return !Number.isNaN(n) && n >= 0
}

/**
 * Left-to-right isolate for an e-mail / file name inside Hebrew TEXT (U+2066 … U+2069 — the plain-text equivalent of
 * `<bdi dir="ltr">`, for messages built as strings). In JSX use `<bdi dir="ltr">` instead.
 */
export function ltrIsolate(text: string): string {
  return `\u2066${text}\u2069`
}
