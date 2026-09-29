import { describe, expect, it } from 'vitest'
import { round2 } from '../../src/lib/format'
import { computePrice, computePrinterRate, DEFAULT_PRICING_SETTINGS, type PricingInput } from '../../src/lib/pricing'

const base: PricingInput = {
  pricePerKg: 85,
  parts: [],
  laborMinutes: 0,
  hardware: [],
  hasShipping: false,
  packaging: [],
  shippingCost: 0,
}

function input(grams: number, hours: number, laborMinutes: number): PricingInput {
  return { ...base, parts: [{ qty: 1, grams, hours }], laborMinutes }
}

function display(r: ReturnType<typeof computePrice>) {
  return {
    filament: round2(r.filament),
    labor: round2(r.labor),
    machine: round2(r.machine),
    landed: round2(r.landed),
    price50: round2(r.price50),
    price60: round2(r.price60),
    price70: round2(r.price70),
  }
}

describe('printer rate', () => {
  it('is ₪0.66498/h with default settings', () => {
    expect(computePrinterRate(DEFAULT_PRICING_SETTINGS)).toBeCloseTo(0.66498, 5)
  })
})

describe('brief §7 test cases', () => {
  it('T0 (labor rate 20) matches the spreadsheet', () => {
    const r = computePrice(input(100, 3.5, 10), { ...DEFAULT_PRICING_SETTINGS, laborRate: 20 })
    expect(display(r)).toEqual({ filament: 9.35, labor: 3.33, machine: 2.33, landed: 15.01, price50: 30.02, price60: 37.53, price70: 50.04 })
  })

  it('T1 with default settings', () => {
    const r = computePrice(input(100, 3.5, 10), DEFAULT_PRICING_SETTINGS)
    expect(display(r)).toEqual({ filament: 9.35, labor: 13.33, machine: 2.33, landed: 25.01, price50: 50.02, price60: 62.53, price70: 83.37 })
  })

  it('T2 rooting-stand (55.94 g, 9312 s)', () => {
    const r = computePrice(input(55.94, 9312 / 3600, 0), DEFAULT_PRICING_SETTINGS)
    expect(display(r)).toEqual({ filament: 5.23, labor: 0, machine: 1.72, landed: 6.95, price50: 13.9, price60: 17.38, price70: 23.17 })
  })

  it('T3 untitled (123.22 g, 19282 s)', () => {
    const r = computePrice(input(123.22, 19282 / 3600, 0), DEFAULT_PRICING_SETTINGS)
    expect(display(r)).toEqual({ filament: 11.52, labor: 0, machine: 3.56, landed: 15.08, price50: 30.17, price60: 37.71, price70: 50.28 })
  })

  it('no hardware and no packaging contribute ₪0', () => {
    const r = computePrice(input(100, 3.5, 10), DEFAULT_PRICING_SETTINGS)
    expect(r.hardware).toBe(0)
    expect(r.packaging).toBe(0)
  })
})

describe('multi-part sums (AC3)', () => {
  it('totals = sum of parts × quantities', () => {
    const multi = computePrice(
      {
        ...base,
        parts: [
          { qty: 2, grams: 50, hours: 1 },
          { qty: 3, grams: 10, hours: 0.5 },
        ],
      },
      DEFAULT_PRICING_SETTINGS,
    )
    const single = computePrice(input(2 * 50 + 3 * 10, 2 * 1 + 3 * 0.5, 0), DEFAULT_PRICING_SETTINGS)
    expect(multi.filament).toBeCloseTo(single.filament, 10)
    expect(multi.machine).toBeCloseTo(single.machine, 10)
    expect(multi.landed).toBeCloseTo(single.landed, 10)
    expect(multi.filament).toBeCloseTo((130 / 1000) * 85 * 1.1, 10)
  })

  it('sums hardware lines as qty × unit cost', () => {
    const r = computePrice(
      { ...base, hardware: [{ qty: 4, unitCost: 0.5 }, { qty: 1, unitCost: 3 }] },
      DEFAULT_PRICING_SETTINGS,
    )
    expect(r.hardware).toBeCloseTo(5, 10)
    expect(r.landed).toBeCloseTo(5, 10)
  })
})

describe('shipping toggle (AC6)', () => {
  const withPackaging: PricingInput = {
    ...input(100, 3.5, 10),
    packaging: [{ qty: 2, unitCost: 1.5 }],
    shippingCost: 20,
  }

  it('off → packaging ₪0 even if rows exist', () => {
    const r = computePrice({ ...withPackaging, hasShipping: false }, DEFAULT_PRICING_SETTINGS)
    expect(r.packaging).toBe(0)
  })

  it('on → packaging rows + shipping cost are counted', () => {
    const off = computePrice({ ...withPackaging, hasShipping: false }, DEFAULT_PRICING_SETTINGS)
    const on = computePrice({ ...withPackaging, hasShipping: true }, DEFAULT_PRICING_SETTINGS)
    expect(on.packaging).toBeCloseTo(23, 10)
    expect(on.landed - off.landed).toBeCloseTo(23, 10)
    expect(on.price70).toBeCloseTo(on.landed / 0.3, 10)
  })
})

describe('invalid input', () => {
  it('propagates NaN instead of silently using 0', () => {
    const r = computePrice(input(NaN, 1, 0), DEFAULT_PRICING_SETTINGS)
    expect(Number.isNaN(r.landed)).toBe(true)
  })
})
