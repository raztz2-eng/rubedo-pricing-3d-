import { describe, expect, it } from 'vitest'
import type { Bid } from '../../src/lib/bid'
import { formatMoney } from '../../src/lib/format'
import { computePrice, DEFAULT_PRICING_SETTINGS, type PricingSettings } from '../../src/lib/pricing'
import {
  bodyHasPrice,
  buildQuoteRecord,
  PRICE_PLACEHOLDER,
  defaultCustomerPrice,
  formatCustomerPrice,
  isValidEmail,
  QUOTE_SIGNATURE,
  quoteBodyText,
  quoteFileName,
  quotePrice,
  quoteSubject,
  savedSelection,
  textToHtml,
} from '../../src/lib/quote'

/** Distinctive numbers everywhere so any leak into the e-mail is detectable. */
const SNAPSHOT: PricingSettings = {
  efficiency: 1.137,
  laborRate: 83,
  printerCost: 4321,
  upgrades: 111,
  maintenancePerYear: 432,
  lifeYears: 3.3,
  uptime: 0.47,
  powerW: 157,
  kwhPrice: 0.617,
  buffer: 1.29,
}

function makeBid(over: Partial<Bid> = {}): Bid {
  const base: Omit<Bid, 'result'> = {
    schemaVersion: 2,
    id: 'bid-1',
    name: 'RootLab — 5-Tube Plant Propagation Station',
    revision: 'V1',
    description: 'תחנת ריבוי צמחים עם חמש מבחנות.',
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    material: { name: 'PLA', pricePerKg: 91.3 },
    parts: [{ name: 'Base', qty: 1, grams: 123.45, hours: 7.891, source: 'manual' }],
    laborMinutes: 37,
    hardware: [
      { name: 'מבחנות זכוכית', qty: 5, unitCost: 2.73, included: true },
      { name: 'צמח פוטוס', qty: 1, unitCost: 19.61, included: false },
    ],
    hasShipping: false,
    packaging: [],
    shippingCost: 0,
    settingsSnapshot: SNAPSHOT,
    files: [],
    ...over,
  }
  const result = computePrice(
    {
      pricePerKg: base.material.pricePerKg,
      parts: base.parts,
      laborMinutes: base.laborMinutes,
      hardware: base.hardware,
      hasShipping: base.hasShipping,
      packaging: base.packaging,
      shippingCost: base.shippingCost,
    },
    base.settingsSnapshot,
  )
  return { ...base, result }
}

describe('quotePrice (AC27): live repricing with the bid snapshot', () => {
  it('toggling a hardware row changes landed by exactly qty × unitCost; uses the snapshot, not defaults', () => {
    const bid = makeBid()
    const saved = quotePrice(bid, savedSelection(bid))
    expect(saved.landed).toBeCloseTo(bid.result.landed, 10)
    const withPlant = quotePrice(bid, [true, true])
    expect(withPlant.landed - saved.landed).toBeCloseTo(19.61, 10)
    const none = quotePrice(bid, [false, false])
    expect(saved.landed - none.landed).toBeCloseTo(5 * 2.73, 10)
    expect(saved.printerRate).not.toBeCloseTo(computePrice({ ...bidInputZero() }, DEFAULT_PRICING_SETTINGS).printerRate, 5)
  })

  it('savedSelection pre-ticks from the bid', () => {
    expect(savedSelection(makeBid())).toEqual([true, false])
  })
})

function bidInputZero() {
  return { pricePerKg: 0, parts: [], laborMinutes: 0, hardware: [], hasShipping: false, packaging: [], shippingCost: 0 }
}

describe('defaultCustomerPrice (AC27): 70% price rounded UP to a whole shekel', () => {
  it.each([
    [83.36666, 84],
    [50, 50],
    [50.01, 51],
    [50.000000000001, 50],
    [0.2, 1],
  ])('%s → %s', (p70, expected) => {
    expect(defaultCustomerPrice(p70)).toBe(expected)
  })

  it('NaN in → NaN out (never a silent 0)', () => {
    expect(defaultCustomerPrice(NaN)).toBeNaN()
  })
})

describe('e-mail copy (Q3)', () => {
  const fields = {
    modelName: 'עמדת השרשה',
    description: 'מעמד מודפס לשורשים.',
    customerName: 'דנה',
    includedHardware: ['מבחנות זכוכית'],
    price: 84,
    deliveryTime: '5 ימי עסקים',
    note: 'צבע לבחירה.',
    founderEmail: 'raztz2@gmail.com',
  }

  it('subject is exactly "הצעת מחיר — {model} | RUBEDO.3D"', () => {
    expect(quoteSubject(' עמדת השרשה ')).toBe('הצעת מחיר — עמדת השרשה | RUBEDO.3D')
  })

  it('body: greeting with name, description, "מה כלול", price line, delivery, note, signature + founder e-mail', () => {
    const t = quoteBodyText(fields)
    expect(t.startsWith('שלום דנה,')).toBe(true)
    expect(t).toContain('מעמד מודפס לשורשים.')
    expect(t).toContain('מה כלול:\n• מבחנות זכוכית')
    expect(t).toContain('מחיר: ₪84')
    expect(t).toContain('זמן אספקה: 5 ימי עסקים')
    expect(t).toContain('צבע לבחירה.')
    expect(t).toContain(`${QUOTE_SIGNATURE}\nraztz2@gmail.com`)
    expect(QUOTE_SIGNATURE).toBe('RUBEDO.3D — הדפסות תלת-ממד בהתאמה אישית')
  })

  it('omits "מה כלול" without included hardware, and delivery/note when empty', () => {
    const t = quoteBodyText({ ...fields, includedHardware: [], deliveryTime: ' ', note: '' })
    expect(t).not.toContain('מה כלול')
    expect(t).not.toContain('זמן אספקה')
    expect(t).not.toContain('צבע לבחירה')
  })

  it('price line: whole shekels without decimals, otherwise 2 decimals', () => {
    expect(formatCustomerPrice(1234)).toBe('₪1,234')
    expect(formatCustomerPrice(84.5)).toBe('₪84.50')
  })

  it('HTML alternative is RTL, escapes the text, keeps paragraphs and line breaks', () => {
    const html = textToHtml('שלום <b>דנה</b> & "חברים",\n\nשורה 1\nשורה 2')
    expect(html).toContain('<html lang="he" dir="rtl">')
    expect(html).toContain('<body dir="rtl"')
    expect(html).toContain('&lt;b&gt;דנה&lt;/b&gt; &amp; &quot;חברים&quot;')
    expect(html).not.toContain('<b>')
    expect(html).toContain('שורה 1<br>שורה 2')
    expect((html.match(/<p /g) ?? []).length).toBe(2)
  })

  it('validates customer e-mail addresses', () => {
    expect(isValidEmail('dana@example.co.il')).toBe(true)
    expect(isValidEmail(' dana@example.com ')).toBe(true)
    for (const bad of ['', 'dana', 'dana@', 'dana@example', 'a b@example.com', 'x@y.z\r\nBcc: q@r.s']) expect(isValidEmail(bad)).toBe(false)
  })
})

describe('AC29: the e-mail never contains internal costs, margins, grams, hours or settings', () => {
  it('rendered subject + text + HTML contain none of the bid internals', () => {
    const bid = makeBid()
    const r = quotePrice(bid, [true, true])
    const price = defaultCustomerPrice(r.price70)
    const text = quoteBodyText({
      modelName: bid.name,
      description: bid.description,
      customerName: 'דנה',
      includedHardware: bid.hardware.map((h) => h.name),
      price,
      deliveryTime: 'שבוע',
      note: '',
      founderEmail: 'raztz2@gmail.com',
    })
    const email = [quoteSubject(bid.name), text, textToHtml(text)].join('\n')
    expect(email).toContain(`מחיר: ₪${price}`)

    const numbers: number[] = [
      r.landed,
      r.price50,
      r.price60,
      r.price70,
      r.filament,
      r.labor,
      r.machine,
      r.hardware,
      r.printerRate,
      bid.result.landed,
      bid.result.price70,
      bid.parts[0].grams,
      bid.parts[0].hours,
      bid.laborMinutes,
      bid.material.pricePerKg,
      ...bid.hardware.map((h) => h.unitCost),
      ...Object.values(bid.settingsSnapshot),
    ]
    const leaks: string[] = []
    for (const n of numbers) {
      const forms = new Set([String(n), n.toFixed(2), formatMoney(n), formatMoney(n).replace('₪', '')])
      for (const f of forms) {
        const re = new RegExp(`(?<![\\d.,])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d])`)
        if (re.test(email)) leaks.push(`${n} as "${f}"`)
      }
    }
    expect(leaks).toEqual([])
    // Words: checked on what the customer reads (HTML tags/styles stripped).
    const visible = [quoteSubject(bid.name), text, textToHtml(text).replace(/<[^>]*>/g, ' ')].join('\n')
    for (const word of ['landed', 'עלות', 'רווח', '50%', '60%', '70%', 'גרם', 'שעות', 'margin']) expect(visible).not.toContain(word)
  })
})

describe('quote log record (Q4)', () => {
  it('holds date, customer, included hardware, price shown, landed & 70% (selection and saved bid), draft id', () => {
    const bid = makeBid()
    const result = quotePrice(bid, [true, true])
    const now = new Date(2026, 9, 1, 9, 5)
    const rec = buildQuoteRecord({
      bid,
      included: [true, true],
      result,
      customer: { name: ' דנה ', email: ' dana@example.com ' },
      priceShown: 120,
      deliveryTime: '',
      draftId: 'r-123',
      attachments: ['a.jpg'],
      now,
    })
    expect(rec).toMatchObject({
      schemaVersion: 1,
      date: now.toISOString(),
      draftId: 'r-123',
      customer: { name: 'דנה', email: 'dana@example.com' },
      priceShown: 120,
      landed: result.landed,
      price70: result.price70,
      savedBid: { landed: bid.result.landed, price70: bid.result.price70 },
      attachments: ['a.jpg'],
    })
    expect(rec.includedHardware.map((h) => h.name)).toEqual(['מבחנות זכוכית', 'צמח פוטוס'])
    expect(rec).not.toHaveProperty('deliveryTime')
  })

  it('file name quote-YYYYMMDD-HHmm.json (local time)', () => {
    expect(quoteFileName(new Date(2026, 9, 1, 9, 5))).toBe('quote-20261001-0905.json')
    expect(quoteFileName(new Date(2026, 0, 31, 23, 59))).toBe('quote-20260131-2359.json')
  })
})

describe('v0.5 fix round', () => {
  it('M2: only printable-ASCII e-mail addresses', () => {
    for (const bad of ['דנה@example.com', 'dana@דוגמה.co.il', 'dаna@example.com' /* Cyrillic а */, 'dana@example.com‏', 'da\tna@example.com'])
      expect(isValidEmail(bad)).toBe(false)
    expect(isValidEmail('first.last+tag@sub.example.co.il')).toBe(true)
  })

  it('I1: the price line shows a placeholder (never ₪0) when the price is invalid', () => {
    const base = { modelName: 'M', description: '', customerName: 'דנה', includedHardware: [], deliveryTime: '', note: '', founderEmail: 'raztz2@gmail.com' }
    for (const price of [null, 0, NaN, -5]) {
      const t = quoteBodyText({ ...base, price })
      expect(t).toContain(`מחיר: ${PRICE_PLACEHOLDER}`)
      expect(t).not.toContain('₪0')
    }
  })

  it('I1: bodyHasPrice matches the exact formatted amount only', () => {
    expect(bodyHasPrice('מחיר: ₪84', 84)).toBe(true)
    expect(bodyHasPrice('מחיר: ₪84.', 84)).toBe(true)
    expect(bodyHasPrice('מחיר: ₪84, כולל מע״מ', 84)).toBe(true)
    expect(bodyHasPrice('מחיר: ₪840', 84)).toBe(false)
    expect(bodyHasPrice('מחיר: ₪84.50', 84)).toBe(false)
    expect(bodyHasPrice('מחיר: ₪84,000', 84)).toBe(false)
    expect(bodyHasPrice('מחיר: 84', 84)).toBe(false)
    expect(bodyHasPrice('מחיר: ₪1,500', 1500)).toBe(true)
    expect(bodyHasPrice('מחיר: ₪1500', 1500)).toBe(false)
    expect(bodyHasPrice('מחיר: ₪84.50', 84.5)).toBe(true)
    expect(bodyHasPrice('מחיר: ₪0', 0)).toBe(false)
  })
})
