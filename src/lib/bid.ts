import { DEFAULT_PRICING_SETTINGS, type PriceResult, type PricingInput, type PricingSettings } from './pricing'

/** Data model for bids, settings and the library index (brief §4). */

export type PartSource = '3mf' | 'manual'
export type FileKind = 'image' | 'model' | 'sliced'

export interface Material {
  name: string
  pricePerKg: number
}

export interface BidPart {
  name: string
  qty: number
  grams: number
  hours: number
  source: PartSource
  slicedFileId?: string
}

export interface BidLine {
  name: string
  qty: number
  unitCost: number
}

/** A hardware row (v0.5 D-I): the model keeps its full list; `included` says whether the row counts in the price. */
export interface HardwareLine extends BidLine {
  included: boolean
}

/** bid.json schema written by this version. v1 files (no `included`) are still read (included = true). */
export const BID_SCHEMA_VERSION = 2
export type BidSchemaVersion = 1 | 2

export interface BidFile {
  id: string
  name: string
  kind: FileKind
  mimeType: string
}

export interface Bid {
  schemaVersion: BidSchemaVersion
  id: string
  name: string
  revision: string
  description: string
  createdAt: string
  updatedAt: string
  material: Material
  parts: BidPart[]
  laborMinutes: number
  hardware: HardwareLine[]
  hasShipping: boolean
  packaging: BidLine[]
  shippingCost: number
  settingsSnapshot: PricingSettings
  result: PriceResult
  files: BidFile[]
  coverFileId?: string
}

export type EntryStatus = 'priced' | 'needs-slicing'

/**
 * One library card. `priced` = the folder has a valid bid.json. `needs-slicing` = an existing model folder without
 * bid.json (brief v0.3 N1): no price; `slicedFileId` set when a sliced .gcode.3mf was found in it.
 * Index entries written before v0.3 have no `status` and are priced.
 */
export interface IndexEntry {
  /** Drive folder ID of the model. */
  id: string
  name: string
  status?: EntryStatus
  revision: string
  /** 70% price — priced entries only (a needs-slicing entry has no price). */
  price70?: number
  landed?: number
  coverFileId?: string
  /** needs-slicing only: a sliced .gcode.3mf found in the folder. */
  slicedFileId?: string
  updatedAt: string
}

export function isPriced(e: IndexEntry): boolean {
  return e.status !== 'needs-slicing'
}

/** Index file content (v0.3). Older files are a bare IndexEntry[] (treated as stale → rebuilt). */
export interface IndexFile {
  schemaVersion: 2
  /** When the index was last fully rebuilt from Drive (ISO). */
  builtAt: string
  entries: IndexEntry[]
}

/** The library auto-refreshes once on open when the index is older than this (brief v0.3 N5). */
export const INDEX_MAX_AGE_MS = 10 * 60 * 1000

export interface AppSettings {
  schemaVersion: 1
  pricing: PricingSettings
  materials: Material[]
}

export const DEFAULT_MATERIALS: Material[] = [
  { name: 'PLA', pricePerKg: 85 },
  { name: 'PETG', pricePerKg: 85 },
  { name: 'אחר', pricePerKg: 85 },
]

export function defaultAppSettings(): AppSettings {
  return {
    schemaVersion: 1,
    pricing: { ...DEFAULT_PRICING_SETTINGS },
    materials: DEFAULT_MATERIALS.map((m) => ({ ...m })),
  }
}

export const SETTINGS_FILE_NAME = '_rubedo-settings.json'
export const INDEX_FILE_NAME = '_rubedo-index.json'
export const BID_FILE_NAME = 'bid.json'
export const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** Validates/normalises a settings file loaded from Drive. Missing fields fall back to defaults. */
export function normaliseSettings(raw: unknown): AppSettings {
  const def = defaultAppSettings()
  if (!raw || typeof raw !== 'object') throw new Error('settings file is not an object')
  const obj = raw as Partial<AppSettings>
  const pricing: PricingSettings = { ...def.pricing }
  if (obj.pricing && typeof obj.pricing === 'object') {
    for (const key of Object.keys(def.pricing) as (keyof PricingSettings)[]) {
      const v = (obj.pricing as unknown as Record<string, unknown>)[key]
      if (typeof v === 'number' && Number.isFinite(v)) pricing[key] = v
    }
  }
  const materials = Array.isArray(obj.materials)
    ? obj.materials.filter(
        (m): m is Material =>
          !!m && typeof m.name === 'string' && typeof m.pricePerKg === 'number' && Number.isFinite(m.pricePerKg),
      )
    : def.materials
  return { schemaVersion: 1, pricing, materials }
}

export function isBid(raw: unknown): raw is Bid {
  if (!raw || typeof raw !== 'object') return false
  const b = raw as Partial<Bid>
  return (
    (b.schemaVersion === 1 || b.schemaVersion === 2) &&
    typeof b.id === 'string' &&
    typeof b.name === 'string' &&
    Array.isArray(b.parts) &&
    !!b.result &&
    typeof b.result.price70 === 'number' &&
    !!b.settingsSnapshot
  )
}

/**
 * Validates a bid.json read from Drive and normalises it for the app: hardware rows without `included` (schemaVersion 1)
 * are included. Returns null when the content is not a bid. `schemaVersion` keeps the value of the file.
 */
export function parseBid(raw: unknown): Bid | null {
  if (!isBid(raw)) return null
  const hardware = Array.isArray(raw.hardware) ? raw.hardware : []
  return {
    ...raw,
    hardware: hardware.map((h) => ({ ...h, included: (h as Partial<HardwareLine>).included !== false })),
    packaging: Array.isArray(raw.packaging) ? raw.packaging : [],
  }
}

/**
 * Pricing input of a saved bid. `includedOverride[i]` replaces the saved `included` flag of hardware row i
 * (quote screen, v0.5 Q3). The math itself lives in pricing.ts.
 */
export function bidPricingInput(bid: Bid, includedOverride?: readonly boolean[]): PricingInput {
  return {
    pricePerKg: bid.material.pricePerKg,
    parts: bid.parts.map((p) => ({ qty: p.qty, grams: p.grams, hours: p.hours })),
    laborMinutes: bid.laborMinutes,
    hardware: bid.hardware.map((h, i) => ({
      qty: h.qty,
      unitCost: h.unitCost,
      included: includedOverride?.[i] ?? h.included !== false,
    })),
    hasShipping: bid.hasShipping,
    packaging: bid.packaging.map((l) => ({ qty: l.qty, unitCost: l.unitCost })),
    shippingCost: bid.shippingCost,
  }
}

export function indexEntryFromBid(folderId: string, bid: Bid): IndexEntry {
  return {
    id: folderId,
    name: bid.name,
    status: 'priced',
    revision: bid.revision,
    price70: bid.result.price70,
    landed: bid.result.landed,
    coverFileId: bid.coverFileId,
    updatedAt: bid.updatedAt,
  }
}

/** Newest first by updatedAt. */
export function sortIndex(entries: IndexEntry[]): IndexEntry[] {
  return [...entries].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
}

export function newId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // Fallback (non-secure contexts): RFC4122 v4 from Math.random.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}
