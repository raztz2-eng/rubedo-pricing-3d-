import { DEFAULT_PRICING_SETTINGS, type PriceResult, type PricingSettings } from './pricing'

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

export interface BidFile {
  id: string
  name: string
  kind: FileKind
  mimeType: string
}

export interface Bid {
  schemaVersion: 1
  id: string
  name: string
  revision: string
  description: string
  createdAt: string
  updatedAt: string
  material: Material
  parts: BidPart[]
  laborMinutes: number
  hardware: BidLine[]
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
    b.schemaVersion === 1 &&
    typeof b.id === 'string' &&
    typeof b.name === 'string' &&
    Array.isArray(b.parts) &&
    !!b.result &&
    typeof b.result.price70 === 'number' &&
    !!b.settingsSnapshot
  )
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
