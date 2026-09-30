import { bidPricingInput, type Bid } from './bid'
import { formatMoney } from './format'
import { computePrice, type PriceResult } from './pricing'

/**
 * Quote e-mail logic (brief v0.5 Q3/Q4). Pure — no I/O.
 * The customer sees ONLY: greeting, model name + description, included hardware NAMES, the price shown, delivery
 * time, note and signature. Never costs, margins, grams, hours or settings (AC29).
 */

export const QUOTE_SIGNATURE = 'RUBEDO.3D — הדפסות תלת-ממד בהתאמה אישית'

/** Fallback when the session did not report the account e-mail (demo mode). */
export const FOUNDER_EMAIL_FALLBACK = 'raztz2@gmail.com'

/** Price of the bid with the given hardware selection, using the bid's OWN settings snapshot (never current Settings). */
export function quotePrice(bid: Bid, included: readonly boolean[]): PriceResult {
  return computePrice(bidPricingInput(bid, included), bid.settingsSnapshot)
}

/** The saved `included` flags of the bid (pre-ticks the quote checklist). */
export function savedSelection(bid: Bid): boolean[] {
  return bid.hardware.map((h) => h.included !== false)
}

/**
 * Default price shown to the customer: the 70% price rounded UP to a whole shekel (AC27).
 * A tiny tolerance keeps floating-point noise (e.g. 50.000000000001) from adding a shekel.
 */
export function defaultCustomerPrice(price70: number): number {
  if (!Number.isFinite(price70)) return NaN
  return Math.ceil(price70 - 1e-9)
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/.test(email.trim())
}

/** ₪1,234 for whole shekels, otherwise ₪1,234.50. */
export function formatCustomerPrice(price: number): string {
  if (Number.isInteger(price)) return `₪${new Intl.NumberFormat('en-US').format(price)}`
  return formatMoney(price)
}

export function quoteSubject(modelName: string): string {
  return `הצעת מחיר — ${modelName.trim()} | RUBEDO.3D`
}

export interface QuoteEmailFields {
  modelName: string
  description: string
  customerName: string
  /** Names of the included hardware rows (empty → the "מה כלול" section is left out). */
  includedHardware: string[]
  price: number
  deliveryTime: string
  note: string
  founderEmail: string
}

/** Plain-text body (the editable source; the HTML alternative is derived from it). */
export function quoteBodyText(f: QuoteEmailFields): string {
  const name = f.customerName.trim()
  const blocks: string[] = []
  blocks.push(name ? `שלום ${name},` : 'שלום,')
  blocks.push(`תודה על הפנייה! להלן הצעת המחיר עבור ${f.modelName.trim()}.`)
  if (f.description.trim()) blocks.push(f.description.trim())
  const hardware = f.includedHardware.map((h) => h.trim()).filter((h) => h !== '')
  if (hardware.length > 0) blocks.push(['מה כלול:', ...hardware.map((h) => `• ${h}`)].join('\n'))
  const priceLines = [`מחיר: ${formatCustomerPrice(f.price)}`]
  if (f.deliveryTime.trim()) priceLines.push(`זמן אספקה: ${f.deliveryTime.trim()}`)
  blocks.push(priceLines.join('\n'))
  if (f.note.trim()) blocks.push(f.note.trim())
  blocks.push('אשמח לענות על כל שאלה.')
  blocks.push(['בברכה,', QUOTE_SIGNATURE, f.founderEmail.trim()].filter((l) => l !== '').join('\n'))
  return blocks.join('\n\n')
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** RTL HTML version of the plain-text body: blank lines → paragraphs, single line breaks → <br>. */
export function textToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n|\r/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => `<p style="margin:0 0 12px">${p.split('\n').map(escapeHtml).join('<br>')}</p>`)
  return [
    '<!DOCTYPE html>',
    '<html lang="he" dir="rtl">',
    '<head><meta charset="UTF-8"></head>',
    '<body dir="rtl" style="direction:rtl;text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#222">',
    `<div dir="rtl">${paragraphs.join('')}</div>`,
    '</body>',
    '</html>',
  ].join('\n')
}

// ---------- Quote log (Q4) ----------

export interface QuoteRecord {
  schemaVersion: 1
  /** When the draft was created (ISO). */
  date: string
  draftId: string
  model: { bidId: string; name: string; revision: string }
  customer: { name: string; email: string }
  /** Hardware rows included in THIS quote. */
  includedHardware: { name: string; qty: number; unitCost: number }[]
  /** The price written in the e-mail. */
  priceShown: number
  /** Landed cost and 70% price of this quote's hardware selection (bid's settings snapshot). */
  landed: number
  price70: number
  /** The same two values as saved in bid.json (its own hardware selection). */
  savedBid: { landed: number; price70: number }
  deliveryTime?: string
  /** File names of the attached photos. */
  attachments: string[]
}

export function buildQuoteRecord(p: {
  bid: Bid
  included: readonly boolean[]
  result: PriceResult
  customer: { name: string; email: string }
  priceShown: number
  deliveryTime: string
  draftId: string
  attachments: string[]
  now: Date
}): QuoteRecord {
  const record: QuoteRecord = {
    schemaVersion: 1,
    date: p.now.toISOString(),
    draftId: p.draftId,
    model: { bidId: p.bid.id, name: p.bid.name, revision: p.bid.revision },
    customer: { name: p.customer.name.trim(), email: p.customer.email.trim() },
    includedHardware: p.bid.hardware
      .filter((_, i) => p.included[i] ?? true)
      .map((h) => ({ name: h.name, qty: h.qty, unitCost: h.unitCost })),
    priceShown: p.priceShown,
    landed: p.result.landed,
    price70: p.result.price70,
    savedBid: { landed: p.bid.result.landed, price70: p.bid.result.price70 },
    attachments: p.attachments,
  }
  if (p.deliveryTime.trim()) record.deliveryTime = p.deliveryTime.trim()
  return record
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** "quote-YYYYMMDD-HHmm.json" in local time. */
export function quoteFileName(now: Date): string {
  return `quote-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`
}
