import type { Bid, BidFile, Material, PartSource } from './bid'
import type { BidContent, LocalFile } from './drive/bidRepository'
import { formatNumber, parseNumber } from './format'
import type { PricingInput, PricingSettings } from './pricing'
import type { SlicedFileInfo } from './threemf'

/**
 * Form state for New/Edit model and its conversion to pricing input / bid content.
 * Parsing only — the pricing math lives in pricing.ts.
 */

export interface PartDraft {
  key: string
  name: string
  qty: string
  grams: string
  hours: string
  /** Exact hours from the sliced file (prediction / 3600); cleared when the user edits hours. */
  hoursExact?: number
  source: PartSource
  /** Local key of the sliced file (new upload) this part came from. */
  slicedLocalKey?: string
  /** Drive ID of the sliced file (existing bid). */
  slicedFileId?: string
}

export interface LineDraft {
  key: string
  name: string
  qty: string
  unitCost: string
}

export type FileOrigin = 'user' | 'plate' | 'sliced'

export interface FileDraft extends LocalFile {
  origin: FileOrigin
  /** Plate pictures can be un-ticked; user files are always included. */
  include: boolean
  /** Plate index for plate pictures (file name is derived from the model name at save time). */
  plateIndex?: number
}

export interface BidDraft {
  name: string
  description: string
  revision: string
  materialName: string
  pricePerKg: string
  parts: PartDraft[]
  laborMinutes: string
  hardware: LineDraft[]
  hasShipping: boolean
  packaging: LineDraft[]
  shippingCost: string
  /** Newly added files (not yet in Drive). */
  files: FileDraft[]
  /** Files already stored with the bid (edit mode). */
  existingFiles: BidFile[]
}

let keySeq = 0
export function newKey(prefix = 'k'): string {
  keySeq += 1
  return `${prefix}-${Date.now().toString(36)}-${keySeq}`
}

export function emptyDraft(materials: Material[]): BidDraft {
  const m = materials[0]
  return {
    name: '',
    description: '',
    revision: 'V1',
    materialName: m?.name ?? '',
    pricePerKg: m ? String(m.pricePerKg) : '',
    parts: [],
    laborMinutes: '',
    hardware: [],
    hasShipping: false,
    packaging: [],
    shippingCost: '',
    files: [],
    existingFiles: [],
  }
}

export function emptyPart(): PartDraft {
  return { key: newKey('part'), name: '', qty: '1', grams: '', hours: '', source: 'manual' }
}

export function emptyLine(): LineDraft {
  return { key: newKey('line'), name: '', qty: '1', unitCost: '' }
}

export function partHours(p: PartDraft): number {
  return p.hoursExact ?? parseNumber(p.hours)
}

function lineNumbers(l: LineDraft) {
  return { qty: parseNumber(l.qty), unitCost: parseNumber(l.unitCost) }
}

export function draftToPricingInput(d: BidDraft): PricingInput {
  return {
    pricePerKg: parseNumber(d.pricePerKg),
    parts: d.parts.map((p) => ({ qty: parseNumber(p.qty), grams: parseNumber(p.grams), hours: partHours(p) })),
    laborMinutes: parseNumber(d.laborMinutes),
    hardware: d.hardware.map(lineNumbers),
    hasShipping: d.hasShipping,
    packaging: d.packaging.map(lineNumbers),
    shippingCost: parseNumber(d.shippingCost),
  }
}

/** Names of fields that are not a valid non-negative number (shown to the user; save is blocked). */
export function invalidFields(d: BidDraft): string[] {
  const bad: string[] = []
  const check = (label: string, v: string) => {
    const n = parseNumber(v)
    if (Number.isNaN(n) || n < 0) bad.push(label)
  }
  check('מחיר חומר', d.pricePerKg)
  check('דקות עבודה', d.laborMinutes)
  d.parts.forEach((p, i) => {
    check(`חלק ${i + 1} — כמות`, p.qty)
    check(`חלק ${i + 1} — גרמים`, p.grams)
    if (p.hoursExact === undefined) check(`חלק ${i + 1} — שעות`, p.hours)
  })
  d.hardware.forEach((l, i) => {
    check(`חומרה ${i + 1} — כמות`, l.qty)
    check(`חומרה ${i + 1} — מחיר`, l.unitCost)
  })
  if (d.hasShipping) {
    d.packaging.forEach((l, i) => {
      check(`אריזה ${i + 1} — כמות`, l.qty)
      check(`אריזה ${i + 1} — מחיר`, l.unitCost)
    })
    check('עלות משלוח', d.shippingCost)
  }
  return bad
}

/** Save is allowed when there is a name and at least one part with grams > 0 or hours > 0. */
export function canSave(d: BidDraft): boolean {
  if (d.name.trim() === '') return false
  const hasPart = d.parts.some((p) => parseNumber(p.grams) > 0 || partHours(p) > 0)
  return hasPart && invalidFields(d).length === 0
}

function linesToBid(lines: LineDraft[]) {
  return lines
    .map((l) => ({ name: l.name.trim(), ...lineNumbers(l) }))
    .filter((l) => l.name !== '' || l.unitCost !== 0)
}

/** Final file list to upload (plate pictures that were un-ticked are dropped; names resolved). */
export function filesToUpload(d: BidDraft): LocalFile[] {
  const base = d.name.trim() || 'model'
  const included = d.files.filter((f) => f.include)
  // Order: user pictures first, then plate pictures, then model files, then sliced files.
  const rank = (f: FileDraft) => (f.kind === 'image' ? (f.origin === 'user' ? 0 : 1) : f.kind === 'model' ? 2 : 3)
  return [...included]
    .sort((a, b) => rank(a) - rank(b))
    .map((f) => ({
      key: f.key,
      name: f.origin === 'plate' ? `${base}-plate-${f.plateIndex ?? 1}.png` : f.name,
      kind: f.kind,
      mimeType: f.mimeType,
      blob: f.blob,
    }))
}

export function draftToContent(d: BidDraft, settingsSnapshot: PricingSettings, result: BidContent['result']): BidContent {
  const pi = draftToPricingInput(d)
  return {
    name: d.name.trim(),
    revision: d.revision.trim() || 'V1',
    description: d.description.trim(),
    material: { name: d.materialName, pricePerKg: pi.pricePerKg },
    parts: d.parts.map((p, i) => {
      const part: BidContent['parts'][number] = {
        name: p.name.trim(),
        qty: pi.parts[i].qty,
        grams: pi.parts[i].grams,
        hours: pi.parts[i].hours,
        source: p.source,
      }
      if (p.slicedLocalKey) part.slicedLocalKey = p.slicedLocalKey
      if (p.slicedFileId) part.slicedFileId = p.slicedFileId
      return part
    }),
    laborMinutes: pi.laborMinutes,
    hardware: linesToBid(d.hardware),
    hasShipping: d.hasShipping,
    packaging: d.hasShipping ? linesToBid(d.packaging) : [],
    shippingCost: d.hasShipping ? pi.shippingCost : 0,
    settingsSnapshot: { ...settingsSnapshot },
    result,
  }
}

function toLineDraft(l: { name: string; qty: number; unitCost: number }): LineDraft {
  return { key: newKey('line'), name: l.name, qty: String(l.qty), unitCost: String(l.unitCost) }
}

export function bidToDraft(bid: Bid): BidDraft {
  return {
    name: bid.name,
    description: bid.description,
    revision: bid.revision,
    materialName: bid.material.name,
    pricePerKg: String(bid.material.pricePerKg),
    parts: bid.parts.map((p) => ({
      key: newKey('part'),
      name: p.name,
      qty: String(p.qty),
      grams: String(p.grams),
      hours: formatHours(p.hours),
      hoursExact: p.hours,
      source: p.source,
      slicedFileId: p.slicedFileId,
    })),
    laborMinutes: String(bid.laborMinutes),
    hardware: bid.hardware.map(toLineDraft),
    hasShipping: bid.hasShipping,
    packaging: bid.packaging.map(toLineDraft),
    shippingCost: String(bid.shippingCost),
    files: [],
    existingFiles: bid.files,
  }
}

export function formatHours(h: number): string {
  return Number.isFinite(h) ? formatNumber(h, 3).replace(/,/g, '') : ''
}

export const SLICED_MIME = 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'

/**
 * Applies a parsed sliced file to the draft: one part per plate, the sliced file attached,
 * plate pictures offered (included by default), material pre-selected if it exists in Settings.
 */
export function applySlicedFile(
  d: BidDraft,
  info: SlicedFileInfo,
  file: { name: string; blob: Blob },
  materials: Material[],
): BidDraft {
  const slicedKey = newKey('sliced')
  const parts: PartDraft[] = info.plates.map((plate) => ({
    key: newKey('part'),
    name: plate.name,
    qty: '1',
    grams: String(plate.grams),
    hours: formatHours(plate.hours),
    hoursExact: plate.hours,
    source: '3mf',
    slicedLocalKey: slicedKey,
  }))
  const pictures: FileDraft[] = info.plates
    .filter((p) => p.picture)
    .map((p) => ({
      key: newKey('plate'),
      name: `plate-${p.index}.png`,
      kind: 'image',
      mimeType: 'image/png',
      blob: p.picture as Blob,
      origin: 'plate',
      include: true,
      plateIndex: p.index,
    }))
  const sliced: FileDraft = {
    key: slicedKey,
    name: file.name,
    kind: 'sliced',
    mimeType: SLICED_MIME,
    blob: file.blob,
    origin: 'sliced',
    include: true,
  }

  let { materialName, pricePerKg } = d
  const type = info.plates.find((p) => p.materialType)?.materialType
  const match = type ? materials.find((m) => m.name.trim().toLowerCase() === type.toLowerCase()) : undefined
  if (match) {
    materialName = match.name
    pricePerKg = String(match.pricePerKg)
  }

  return {
    ...d,
    materialName,
    pricePerKg,
    parts: [...d.parts, ...parts],
    files: [...d.files, ...pictures, sliced],
  }
}

/** Edits a part's grams/hours: the value becomes manual. */
export function editPartValue(p: PartDraft, field: 'grams' | 'hours', value: string): PartDraft {
  const next: PartDraft = { ...p, [field]: value, source: 'manual' }
  if (field === 'hours') delete next.hoursExact
  return next
}
