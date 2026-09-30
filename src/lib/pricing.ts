/**
 * RUBEDO.3D pricing method (Founder-approved). This is the ONLY place the formula lives.
 * Pure functions, no I/O. Values are computed in full precision; round only for display.
 */

export interface PricingSettings {
  /** Filament waste factor (1.1 = +10%). */
  efficiency: number
  /** Labor rate, ₪ per hour. */
  laborRate: number
  printerCost: number
  upgrades: number
  maintenancePerYear: number
  lifeYears: number
  /** Fraction of the year the printer is actually printing (0..1). */
  uptime: number
  powerW: number
  kwhPrice: number
  buffer: number
}

export const DEFAULT_PRICING_SETTINGS: Readonly<PricingSettings> = Object.freeze({
  efficiency: 1.1,
  laborRate: 80,
  printerCost: 4200,
  upgrades: 0,
  maintenancePerYear: 420,
  lifeYears: 3,
  uptime: 0.5,
  powerW: 150,
  kwhPrice: 0.64,
  buffer: 1.3,
})

export interface PricedPart {
  qty: number
  grams: number
  hours: number
}

export interface PricedLine {
  qty: number
  unitCost: number
}

/**
 * A hardware line (v0.5 D-I). `included: false` = optional hardware left out of this price.
 * Missing `included` (bids saved before v0.5) counts as included, so old bids price exactly as before.
 */
export interface PricedHardwareLine extends PricedLine {
  included?: boolean
}

export interface PricingInput {
  /** Material price, ₪ per kg. */
  pricePerKg: number
  parts: PricedPart[]
  laborMinutes: number
  hardware: PricedHardwareLine[]
  hasShipping: boolean
  packaging: PricedLine[]
  shippingCost: number
}

export interface PriceResult {
  printerRate: number
  filament: number
  hardware: number
  labor: number
  packaging: number
  machine: number
  landed: number
  price50: number
  price60: number
  price70: number
}

export const MARGINS = [0.5, 0.6, 0.7] as const

/** Printer cost per printing hour, ₪/h (≈ 0.66498 with defaults). */
export function computePrinterRate(s: PricingSettings): number {
  const depreciation =
    (s.printerCost + s.upgrades + s.maintenancePerYear * s.lifeYears) / (s.lifeYears * 8760 * s.uptime)
  const power = (s.powerW / 1000) * s.kwhPrice
  return (depreciation + power) * s.buffer
}

/** Sale price for a given margin m (0 ≤ m < 1). */
export function priceAtMargin(landed: number, margin: number): number {
  return landed / (1 - margin)
}

function sumLines(lines: PricedLine[]): number {
  return lines.reduce((acc, l) => acc + l.qty * l.unitCost, 0)
}

/** True unless the line was explicitly left out (`included: false`). */
export function isIncluded(line: { included?: boolean }): boolean {
  return line.included !== false
}

export function computePrice(input: PricingInput, s: PricingSettings): PriceResult {
  const printerRate = computePrinterRate(s)
  const totalGrams = input.parts.reduce((acc, p) => acc + p.grams * p.qty, 0)
  const totalHours = input.parts.reduce((acc, p) => acc + p.hours * p.qty, 0)

  const filament = (totalGrams / 1000) * input.pricePerKg * s.efficiency
  // v0.5 Q2: only included hardware rows count.
  const hardware = sumLines(input.hardware.filter(isIncluded))
  const labor = (input.laborMinutes / 60) * s.laborRate
  const packaging = input.hasShipping ? sumLines(input.packaging) + input.shippingCost : 0
  const machine = totalHours * printerRate
  const landed = filament + hardware + labor + packaging + machine

  return {
    printerRate,
    filament,
    hardware,
    labor,
    packaging,
    machine,
    landed,
    price50: priceAtMargin(landed, 0.5),
    price60: priceAtMargin(landed, 0.6),
    price70: priceAtMargin(landed, 0.7),
  }
}

/** True when every number in the result is finite (i.e. all inputs were valid). */
export function isValidResult(r: PriceResult): boolean {
  return Object.values(r).every((v) => Number.isFinite(v))
}
