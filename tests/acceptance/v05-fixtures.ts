/**
 * Fixtures for the Addendum v0.5 acceptance tests (Test Verifier). bid.json files are written as literal JSON in the
 * brief §4 schema (not with the app's builders), and the reference numbers come from the Founder's formula in
 * CLAUDE.md / brief §7 (T0/T1), recomputed here independently of src/lib/pricing.ts.
 */
import { SessionAuth } from '../../src/lib/auth/sessionAuth'
import { GoogleDriveStore } from '../../src/lib/drive/googleDrive'
import { GmailMailStore } from '../../src/lib/mail/gmail'
import { localFolderPointer, type AppServices } from '../../src/state/services'
import type { MemServices } from './helpers'
import { APP_MARK, type Browser, type GoogleWorld } from './google-world'

export const DEFAULTS = {
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
}
export type Snapshot = typeof DEFAULTS

export interface HwRow {
  name: string
  qty: number
  unitCost: number
  /** Omitted → a schemaVersion-1 row (no `included` key at all). */
  included?: boolean
}

/** The Founder's method (CLAUDE.md "Pricing method"), v0.5 hardware rule: rows with included === false are skipped. */
export function refPrice(p: { grams: number; hours: number; laborMinutes: number; hardware: HwRow[]; s: Snapshot; pricePerKg?: number }) {
  const s = p.s
  const printerRate =
    ((s.printerCost + s.upgrades + s.maintenancePerYear * s.lifeYears) / (s.lifeYears * 8760 * s.uptime) + (s.powerW / 1000) * s.kwhPrice) *
    s.buffer
  const filament = (p.grams / 1000) * (p.pricePerKg ?? 85) * s.efficiency
  const hardware = p.hardware.filter((h) => h.included !== false).reduce((a, h) => a + h.qty * h.unitCost, 0)
  const labor = (p.laborMinutes / 60) * s.laborRate
  const machine = p.hours * printerRate
  const landed = filament + hardware + labor + machine
  return {
    printerRate,
    filament,
    hardware,
    labor,
    packaging: 0,
    machine,
    landed,
    price50: landed / 0.5,
    price60: landed / 0.4,
    price70: landed / (1 - 0.7),
  }
}

export interface BidSpec {
  schemaVersion: 1 | 2
  name: string
  description?: string
  grams: number
  hours: number
  laborMinutes: number
  hardware: HwRow[]
  snapshot?: Snapshot
  coverFileId?: string
  files?: { id: string; name: string; kind: 'image' | 'model' | 'sliced'; mimeType: string }[]
}

/** A bid.json object exactly as brief §4 describes it (v1: hardware rows without `included`). */
export function bidJson(spec: BidSpec, id = `bid-${spec.name.replace(/\W+/g, '-')}`) {
  const s = spec.snapshot ?? DEFAULTS
  const result = refPrice({ grams: spec.grams, hours: spec.hours, laborMinutes: spec.laborMinutes, hardware: spec.hardware, s })
  return {
    schemaVersion: spec.schemaVersion,
    id,
    name: spec.name,
    revision: 'V1',
    description: spec.description ?? '',
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    material: { name: 'PLA', pricePerKg: 85 },
    parts: [{ name: 'body', qty: 1, grams: spec.grams, hours: spec.hours, source: 'manual' }],
    laborMinutes: spec.laborMinutes,
    hardware: spec.hardware.map((h) => (h.included === undefined ? { name: h.name, qty: h.qty, unitCost: h.unitCost } : { ...h })),
    hasShipping: false,
    packaging: [],
    shippingCost: 0,
    settingsSnapshot: { ...s },
    result,
    files: spec.files ?? [],
    ...(spec.coverFileId ? { coverFileId: spec.coverFileId } : {}),
  }
}

export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 7, 7])
export const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xa5, 0x5a, 0xff, 0xd9])
export const HEIC_BYTES = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0])

/** The model used across the quote tests: RootLab propagation station, sold with or without a plant (brief D-I). */
export const MODEL_NAME = 'RootLab — 5-Tube Plant Propagation Station'
export const MODEL_DESCRIPTION = 'תחנת ריבוי צמחים עם 5 מבחנות'
/** T0 inputs (brief §7: laborRate 20 in the snapshot) + optional hardware. */
export const T0_SNAPSHOT: Snapshot = { ...DEFAULTS, laborRate: 20 }
export const PLANT: HwRow = { name: 'Plant cutting', qty: 2, unitCost: 7.5, included: true }
export const POT: HwRow = { name: 'Ceramic pot', qty: 1, unitCost: 4, included: false }

/** Memory drive: a priced model folder (app-created) with two photos and a v2 bid.json. */
export async function memoryQuoteModel(services: MemServices, root: string, o: { hardware?: HwRow[] } = {}) {
  const drive = services.drive
  const folder = await drive.createFolder(root, MODEL_NAME)
  const cover = await drive.uploadFile(folder.id, 'cover.png', new Blob([PNG_BYTES], { type: 'image/png' }), 'image/png')
  const side = await drive.uploadFile(folder.id, 'side.png', new Blob([PNG_BYTES.slice().reverse()], { type: 'image/png' }), 'image/png')
  const bid = bidJson({
    schemaVersion: 2,
    name: MODEL_NAME,
    description: MODEL_DESCRIPTION,
    grams: 100,
    hours: 3.5,
    laborMinutes: 10,
    hardware: o.hardware ?? [PLANT, POT],
    snapshot: T0_SNAPSHOT,
    coverFileId: cover.id,
    files: [
      { id: cover.id, name: 'cover.png', kind: 'image', mimeType: 'image/png' },
      { id: side.id, name: 'side.png', kind: 'image', mimeType: 'image/png' },
    ],
  })
  const bidFile = await drive.uploadFile(folder.id, 'bid.json', new Blob([JSON.stringify(bid)], { type: 'application/json' }), 'application/json')
  return { folderId: folder.id, coverId: cover.id, sideId: side.id, bidFileId: bidFile.id, bid }
}

/** Google world: a priced model folder (app-created, marked) with a HEIC cover (JPEG thumbnail) and a JPG photo. */
export function worldQuoteModel(world: GoogleWorld, root: string, o: { sideThumb?: Uint8Array } = {}) {
  const folder = world.addFolder(root, MODEL_NAME, { id: 'folder_rootlab_model', appProperties: APP_MARK })
  const heicThumb = { bytes: JPG_BYTES, type: 'image/jpeg' }
  const cover = world.addFile(folder, 'IMG_0042.HEIC', HEIC_BYTES, 'image/heic', { id: 'photo_heic_0042', thumbnail: heicThumb })
  const sideBytes = o.sideThumb ?? JPG_BYTES.slice().reverse()
  const side = world.addFile(folder, 'side.jpg', sideBytes, 'image/jpeg', { id: 'photo_side_jpg1', thumbnail: { bytes: sideBytes, type: 'image/jpeg' } })
  const bid = bidJson({
    schemaVersion: 2,
    name: MODEL_NAME,
    description: MODEL_DESCRIPTION,
    grams: 100,
    hours: 3.5,
    laborMinutes: 10,
    hardware: [PLANT, POT],
    snapshot: T0_SNAPSHOT,
    coverFileId: cover,
    files: [{ id: side, name: 'side.jpg', kind: 'image', mimeType: 'image/jpeg' }],
  })
  const enc = new TextEncoder()
  world.addFile(folder, 'bid.json', enc.encode(JSON.stringify(bid)), 'application/json', { id: 'bid_json_rootlab', appProperties: APP_MARK })
  return { folderId: folder, coverId: cover, sideId: side, bid }
}

export interface GoogleQuoteServices extends AppServices {
  auth: SessionAuth
  drive: GoogleDriveStore
  mail: GmailMailStore
  popups: string[]
  navigations: string[]
}

/** Production objects (SessionAuth + GoogleDriveStore + GmailMailStore) talking through the fake browser. */
export function googleQuoteServices(browser: Browser): GoogleQuoteServices {
  const navigations: string[] = []
  const popups: string[] = []
  const auth = new SessionAuth({
    fetchImpl: browser.spaFetch,
    navigate: (u) => navigations.push(u),
    openWindow: (u) => {
      popups.push(u)
      return {}
    },
    log: () => {},
  })
  void auth.init()
  const drive = new GoogleDriveStore(auth, browser.spaFetch)
  const mail = new GmailMailStore(auth, browser.spaFetch)
  return { mode: 'google', drive, mail, auth, folderPointer: localFolderPointer, pickFolder: async () => null, popups, navigations }
}

/** All numbers anywhere in a JSON value. */
export function numbersIn(v: unknown): number[] {
  if (typeof v === 'number') return [v]
  if (Array.isArray(v)) return v.flatMap(numbersIn)
  if (v && typeof v === 'object') return Object.values(v).flatMap(numbersIn)
  return []
}

/** All strings anywhere in a JSON value. */
export function stringsIn(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.flatMap(stringsIn)
  if (v && typeof v === 'object') return Object.values(v).flatMap(stringsIn)
  return []
}
