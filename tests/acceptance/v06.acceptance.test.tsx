/**
 * Addendum v0.6 (Founder request, 2 Oct 2026) — editing, model cover, inline description, customers list. AC32–AC38.
 *
 * Outside-in: the whole App on the in-memory Drive + MemoryMail (createMemoryServices). Drive content that the app did
 * not create (the Founder's own folders, pre-v0.4 app files) is simulated with addForeignFolder / addForeignFile /
 * addLegacyAppFile. bid.json, customers and quote-log files are written as literal JSON in the brief's schemas.
 * Expected prices: T1/T2 (brief §7) and, for mixed inputs, the Founder's formula in CLAUDE.md recomputed here.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addManualPart,
  EDIT_BID_LABEL,
  editBidLink,
  fixtureFile,
  nameInput,
  navLink,
  newServices,
  panel,
  renderApp,
  saveButton,
  setValue,
  type MemServices,
} from './helpers'
import { bidJson, DEFAULTS, memoryQuoteModel, MODEL_NAME, PNG_BYTES, type Snapshot } from './v05-fixtures'

type Drive = MemServices['drive']
type User = ReturnType<typeof userEvent.setup>

const CUSTOMERS_FILE = '_rubedo-customers.json'
const MODEL_META_FILE = '_rubedo-model.json'
const CONVERT_LABEL = 'המר להצעה ניתנת לעריכה'
const SET_COVER = 'קבע כתמונה ראשית'
const UPLOAD_COVER = 'העלה תמונה חדשה כראשית'
const CREATE_DRAFT = 'צור טיוטה ב-Gmail'
const HEBREW = /[֐-׿]/

// ---------- image identity (which Drive file an <img> shows) ----------
// The in-memory drive hands out the very Blob a file was stored with, so a labelled Blob → "blob:<label>" URL tells
// exactly which file every <img> renders.
const labels = new Map<Blob, string>()
let origCreate: typeof URL.createObjectURL | undefined
let origRevoke: typeof URL.revokeObjectURL | undefined

function labelled<T extends Blob>(b: T, label: string): T {
  labels.set(b, label)
  return b
}

function jpeg(label: string): Blob {
  return labelled(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, label.length])], { type: 'image/jpeg' }), label)
}

function png(label: string): Blob {
  return labelled(new Blob([PNG_BYTES], { type: 'image/png' }), label)
}

function pngUpload(name: string): File {
  return labelled(new File([PNG_BYTES], name, { type: 'image/png' }), name)
}

function imgSrc(alt: string, root: HTMLElement = document.body): string {
  return within(root).getByRole('img', { name: alt }).getAttribute('src') ?? ''
}

beforeEach(() => {
  origCreate = URL.createObjectURL
  origRevoke = URL.revokeObjectURL
  URL.createObjectURL = vi.fn((b: Blob) => `blob:${labels.get(b) ?? 'unlabelled'}`)
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  if (origCreate) URL.createObjectURL = origCreate
  else delete (URL as { createObjectURL?: unknown }).createObjectURL
  if (origRevoke) URL.revokeObjectURL = origRevoke
  else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
  labels.clear()
  localStorage.clear()
  vi.restoreAllMocks()
})

// ---------- drive helpers ----------

async function bidFiles(drive: Drive, folderId: string) {
  return drive.listChildren(folderId, { name: 'bid.json' })
}

/** The single marked bid.json of a folder. */
async function markedBid(drive: Drive, folderId: string) {
  const marked = (await bidFiles(drive, folderId)).filter((f) => f.appCreated === true)
  expect(marked, 'exactly one marked bid.json').toHaveLength(1)
  return { file: marked[0], json: JSON.parse(await drive.readText(marked[0].id)) }
}

async function folderByName(drive: Drive, root: string, name: string) {
  const f = (await drive.listChildren(root, { foldersOnly: true })).find((x) => x.name === name)
  if (!f) throw new Error(`no folder ${name}`)
  return f
}

async function uploadJson(drive: Drive, parent: string, name: string, value: unknown) {
  return drive.uploadFile(parent, name, new Blob([JSON.stringify(value)], { type: 'application/json' }), 'application/json')
}

async function readCustomers(drive: Drive, root: string): Promise<Record<string, unknown>[] | null> {
  const f = await drive.listChildren(root, { name: CUSTOMERS_FILE })
  if (f.length === 0) return null
  expect(f).toHaveLength(1)
  expect(f[0].appCreated, `${CUSTOMERS_FILE} carries the app marker`).toBe(true)
  return JSON.parse(await drive.readText(f[0].id))
}

/** A priced model (app-created, marked bid.json) with two photos; cover = a.png. */
async function pricedModel(drive: Drive, root: string, name = 'Lamp') {
  const folder = await drive.createFolder(root, name)
  const a = await drive.uploadFile(folder.id, 'a.png', png(`${name}/a.png`), 'image/png')
  const b = await drive.uploadFile(folder.id, 'b.png', png(`${name}/b.png`), 'image/png')
  const bid = bidJson({
    schemaVersion: 2,
    name,
    description: 'תיאור ישן',
    grams: 100,
    hours: 3.5,
    laborMinutes: 10,
    hardware: [],
    coverFileId: a.id,
    files: [
      { id: a.id, name: 'a.png', kind: 'image', mimeType: 'image/png' },
      { id: b.id, name: 'b.png', kind: 'image', mimeType: 'image/png' },
    ],
  })
  const bidFile = await uploadJson(drive, folder.id, 'bid.json', bid)
  return { folderId: folder.id, aId: a.id, bId: b.id, bidFileId: bidFile.id }
}

/** A needs-slicing folder the Founder made himself, with two photos (default cover = x.jpg, first by name). */
function needsSlicingFolder(drive: Drive, root: string, name = 'Owl lamp') {
  const folder = drive.addForeignFolder(root, name)
  const x = drive.addForeignFile(folder, 'x.jpg', jpeg(`${name}/x.jpg`), 'image/jpeg')
  const y = drive.addForeignFile(folder, 'y.jpg', jpeg(`${name}/y.jpg`), 'image/jpeg')
  return { folderId: folder, xId: x, yId: y }
}

function libraryCard(name: string): HTMLElement {
  const card = screen.getAllByTestId('library-card').find((c) => (c.textContent ?? '').includes(name))
  if (!card) throw new Error(`no library card for ${name}`)
  return card
}

/** Every Drive file/folder the app did NOT create, with its content object (to prove they are untouched). */
function foreignSnapshot(drive: Drive) {
  return drive
    .all()
    .filter((n) => !n.appCreated)
    .map((n) => ({ id: n.id, name: n.name, parentId: n.parentId, mimeType: n.mimeType }))
}

/** The Founder's method (CLAUDE.md "Pricing method"), recomputed independently of src/lib/pricing.ts. */
function refResult(p: {
  parts: { grams: number; hours: number; qty: number }[]
  pricePerKg: number
  laborMinutes: number
  hardware: { qty: number; unitCost: number; included?: boolean }[]
  hasShipping: boolean
  packaging: { qty: number; unitCost: number }[]
  shippingCost: number
  s: Snapshot
}) {
  const s = p.s
  const printerRate =
    ((s.printerCost + s.upgrades + s.maintenancePerYear * s.lifeYears) / (s.lifeYears * 8760 * s.uptime) + (s.powerW / 1000) * s.kwhPrice) * s.buffer
  const filament = (p.parts.reduce((a, x) => a + x.grams * x.qty, 0) / 1000) * p.pricePerKg * s.efficiency
  const hardware = p.hardware.filter((h) => h.included !== false).reduce((a, h) => a + h.qty * h.unitCost, 0)
  const labor = (p.laborMinutes / 60) * s.laborRate
  const packaging = p.hasShipping ? p.packaging.reduce((a, x) => a + x.qty * x.unitCost, 0) + p.shippingCost : 0
  const machine = p.parts.reduce((a, x) => a + x.hours * x.qty, 0) * printerRate
  const landed = filament + hardware + labor + packaging + machine
  return { printerRate, filament, hardware, labor, packaging, machine, landed, price50: landed / 0.5, price60: landed / 0.4, price70: landed / 0.3 }
}

// ---------- form helpers ----------

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

function hardwareRows() {
  const sec = within(region('חומרה'))
  return {
    names: sec.queryAllByLabelText(/^רכיב \d+$/) as HTMLInputElement[],
    qty: sec.queryAllByLabelText('כמות') as HTMLInputElement[],
    cost: sec.queryAllByLabelText('מחיר ליחידה') as HTMLInputElement[],
    included: sec.queryAllByRole('checkbox', { name: /כלול במחיר/ }) as HTMLInputElement[],
  }
}

async function addHardware(user: User, name: string, qty: string, unitCost: string) {
  await user.click(within(region('חומרה')).getByRole('button', { name: /הוספת רכיב/ }))
  const r = hardwareRows()
  const i = r.names.length - 1
  setValue(r.names[i], name)
  setValue(r.qty[i], qty)
  setValue(r.cost[i], unitCost)
}

function partRows() {
  return screen.queryAllByTestId('part-row').map((row) => ({
    row,
    name: within(row).getByLabelText('שם החלק') as HTMLInputElement,
    qty: within(row).getByLabelText('כמות') as HTMLInputElement,
    grams: within(row).getByLabelText('משקל') as HTMLInputElement,
    hours: within(row).getByLabelText('זמן הדפסה') as HTMLInputElement,
  }))
}

function shippingToggle(): HTMLInputElement {
  return within(region('אריזה ומשלוח')).getByRole('checkbox', { name: /כולל אריזה ומשלוח/ }) as HTMLInputElement
}

async function openEdit(user: User) {
  await user.click(editBidLink())
  await screen.findByRole('heading', { level: 1, name: /^עריכת / })
}

// =============================================================================================
describe('AC32 — editing a marked bid changes only that bid.json (marker kept); every E1 field round-trips', () => {
  it('AC32.entry (E1): a marked bid\'s model page shows a prominent "עריכת הצעה" button that opens the full edit form', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const m = await pricedModel(services.drive, root)
    renderApp(services, `/model/${m.folderId}`)
    await screen.findByRole('heading', { level: 1, name: 'Lamp' })
    const link = editBidLink()
    expect((link.textContent ?? '').trim()).toContain(EDIT_BID_LABEL)
    expect(link.getAttribute('href')).toBe(`/model/${m.folderId}/edit`)
    expect(link.className, 'prominent = primary button style').toMatch(/btn-primary/)
    await user.click(link)
    await screen.findByRole('heading', { level: 1, name: 'עריכת Lamp' })
    expect(nameInput().value).toBe('Lamp')
    expect(screen.queryByText(CONVERT_LABEL)).toBeNull()
  })

  it('AC32.round-trip: name, description, material + ₪/kg, parts (remove / replace sliced file / add / edit), labor, hardware (remove / edit / add / included), packaging + shipping, new photo + model file — all saved into the SAME marked bid.json, only it is rewritten, and every value comes back in the form', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive

    // Another model whose bid.json must never be touched by this edit.
    const other = await pricedModel(drive, root, 'Other')
    const otherBefore = await drive.readText(other.bidFileId)

    // 1. Create the bid through the app: T3 sliced file, three hardware rows (Pot not included).
    renderApp(services, '/new')
    setValue(await screen.findByLabelText(/^שם \*$/), 'Vase')
    setValue(screen.getByLabelText('תיאור'), 'אגרטל ראשון')
    await user.upload(screen.getByLabelText('העלאת קובץ פרוס'), fixtureFile('untitled.gcode.3mf'))
    await waitFor(() => expect(partRows()).toHaveLength(1))
    expect(panel().p70).toBe('₪50.28') // T3 anchor (brief §7)
    await addHardware(user, 'Magnet', '4', '0.5')
    await addHardware(user, 'Plant', '2', '7.5')
    await addHardware(user, 'Pot', '1', '4')
    await user.click(hardwareRows().included[2])
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Vase' })
    const folder = await folderByName(drive, root, 'Vase')
    const created = await markedBid(drive, folder.id)
    const oldSliced = created.json.files.find((f: { kind: string }) => f.kind === 'sliced')
    expect(oldSliced?.name).toBe('untitled.gcode.3mf')

    // 2. Edit every field.
    await openEdit(user)
    const logStart = drive.writeLog.length
    const targetsStart = drive.writeTargets.length
    setValue(nameInput(), 'Vase XL')
    setValue(screen.getByLabelText('תיאור'), 'אגרטל מעודכן\nשורה שנייה')
    // parts: remove the T3 part, replace the sliced file with T2, add a manual part and edit it
    await user.click(screen.getByRole('button', { name: 'הסרת חלק 1' }))
    await user.upload(screen.getByLabelText('העלאת קובץ פרוס'), fixtureFile('rooting-stand.gcode.3mf'))
    await waitFor(() => expect(partRows()).toHaveLength(1))
    expect(partRows()[0].name.value).toMatch(/Rooting stand/i)
    await addManualPart(user, '5', '0.5')
    const base = partRows()[1]
    setValue(base.name, 'Base')
    setValue(base.grams, '10')
    setValue(base.hours, '1')
    setValue(base.qty, '2')
    // material + price per kg (after the sliced file, which pre-selects its own material)
    await user.selectOptions(screen.getByLabelText('חומר'), 'PETG')
    setValue(screen.getByLabelText('מחיר חומר'), '100')
    setValue(screen.getByLabelText('זמן עבודה'), '25')
    // hardware: remove Magnet, Plant → 3 and not included, Pot → included, add Stand
    await user.click(within(region('חומרה')).getByRole('button', { name: 'הסרת רכיב 1' }))
    setValue(hardwareRows().qty[0], '3')
    await user.click(hardwareRows().included[0])
    await user.click(hardwareRows().included[1])
    await addHardware(user, 'Stand', '1', '12')
    // packaging + shipping
    await user.click(shippingToggle())
    await user.click(within(region('אריזה ומשלוח')).getByRole('button', { name: /הוספת פריט אריזה/ }))
    setValue(within(region('אריזה ומשלוח')).getByLabelText('פריט אריזה 1'), 'Box')
    setValue(within(region('אריזה ומשלוח')).getByLabelText('כמות'), '2')
    setValue(within(region('אריזה ומשלוח')).getByLabelText('מחיר ליחידה'), '1.5')
    setValue(screen.getByLabelText('עלות משלוח'), '20')
    // photos / files
    await user.upload(screen.getByLabelText('הוספת תמונות'), pngUpload('new.png'))
    await user.upload(screen.getByLabelText('הוספת קבצי דגם'), new File(['solid vase'], 'vase.stl'))

    const expected = refResult({
      parts: [
        { grams: 55.94, hours: 9312 / 3600, qty: 1 }, // T2 (brief §7)
        { grams: 10, hours: 1, qty: 2 },
      ],
      pricePerKg: 100,
      laborMinutes: 25,
      hardware: [
        { qty: 3, unitCost: 7.5, included: false },
        { qty: 1, unitCost: 4, included: true },
        { qty: 1, unitCost: 12, included: true },
      ],
      hasShipping: true,
      packaging: [{ qty: 2, unitCost: 1.5 }],
      shippingCost: 20,
      s: DEFAULTS,
    })
    expect(expected.landed.toFixed(2)).toBe('83.74')
    expect(panel()).toMatchObject({ hardware: '₪16.00', packaging: '₪23.00', landed: '₪83.74', p70: '₪279.12' })
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Vase XL' })

    // Same file, still marked, the only bid.json in the folder; id + createdAt kept, updatedAt new.
    const after = await markedBid(drive, folder.id)
    expect(after.file.id).toBe(created.file.id)
    expect(await bidFiles(drive, folder.id)).toHaveLength(1)
    const b = after.json
    expect(b.id).toBe(created.json.id)
    expect(b.createdAt).toBe(created.json.createdAt)
    expect(b.updatedAt >= created.json.updatedAt).toBe(true)
    expect(b.name).toBe('Vase XL')
    expect(b.description).toBe('אגרטל מעודכן\nשורה שנייה')
    expect(b.material).toEqual({ name: 'PETG', pricePerKg: 100 })
    expect(b.laborMinutes).toBe(25)
    expect(b.parts).toHaveLength(2)
    expect(b.parts[0]).toMatchObject({ qty: 1, grams: 55.94, source: '3mf' })
    expect(b.parts[0].hours).toBeCloseTo(9312 / 3600, 3)
    expect(b.parts[0].name).toMatch(/Rooting stand/i)
    expect(b.parts[1]).toMatchObject({ name: 'Base', qty: 2, grams: 10, hours: 1, source: 'manual' })
    expect(b.hardware).toEqual([
      { name: 'Plant', qty: 3, unitCost: 7.5, included: false },
      { name: 'Pot', qty: 1, unitCost: 4, included: true },
      { name: 'Stand', qty: 1, unitCost: 12, included: true },
    ])
    expect(b.hasShipping).toBe(true)
    expect(b.packaging).toEqual([{ name: 'Box', qty: 2, unitCost: 1.5 }])
    expect(b.shippingCost).toBe(20)
    expect(b.settingsSnapshot).toEqual(DEFAULTS)
    for (const k of ['filament', 'hardware', 'labor', 'packaging', 'machine', 'landed', 'price50', 'price60', 'price70'] as const) {
      expect(b.result[k], `result.${k}`).toBeCloseTo(expected[k], 6)
    }
    // Files: old ones kept, new photo / model / sliced file (the replacement) added; the new part links to it.
    const byName = new Map<string, { id: string; kind: string }>(b.files.map((f: { name: string; id: string; kind: string }) => [f.name, f]))
    expect(byName.get('untitled.gcode.3mf')?.id).toBe(oldSliced.id)
    expect(byName.get('new.png')?.kind).toBe('image')
    expect(byName.get('vase.stl')?.kind).toBe('model')
    expect(byName.get('rooting-stand.gcode.3mf')?.kind).toBe('sliced')
    expect(b.parts[0].slicedFileId).toBe(byName.get('rooting-stand.gcode.3mf')?.id)
    const folderNames = (await drive.listChildren(folder.id)).map((f) => f.name)
    for (const n of ['new.png', 'vase.stl', 'rooting-stand.gcode.3mf', 'untitled.gcode.3mf']) expect(folderNames).toContain(n)

    // Only this bid.json was rewritten: one update of it, uploads of the NEW files into this folder, index cache.
    const writes = drive.writeLog.slice(logStart)
    const targets = drive.writeTargets.slice(targetsStart)
    expect(writes.filter((w) => w === 'update:bid.json')).toHaveLength(1)
    const indexIds = (await drive.listChildren(root, { name: '_rubedo-index.json' })).map((f) => f.id)
    for (const t of targets.filter((x) => x.op === 'updateFileContent')) expect([after.file.id, ...indexIds]).toContain(t.targetId)
    for (const w of writes) {
      expect(w, 'allowed write during an edit').toMatch(/^(update:bid\.json|update:_rubedo-index\.json|upload:(new\.png|vase\.stl|rooting-stand\.gcode\.3mf|.*-plate-\d+\.png))$/)
    }
    for (const t of targets.filter((x) => x.op === 'uploadFile')) expect(t.targetId).toBe(folder.id)
    expect(targets.some((t) => t.op === 'createFolder')).toBe(false)
    expect(await drive.readText(other.bidFileId)).toBe(otherBefore)

    // 3. Round-trip: the edit form shows every saved value again; saving unchanged keeps everything.
    await openEdit(user)
    expect(nameInput().value).toBe('Vase XL')
    expect((screen.getByLabelText('תיאור') as HTMLTextAreaElement).value).toBe('אגרטל מעודכן\nשורה שנייה')
    expect((screen.getByLabelText('חומר') as HTMLSelectElement).value).toBe('PETG')
    expect((screen.getByLabelText('מחיר חומר') as HTMLInputElement).value).toBe('100')
    expect((screen.getByLabelText('זמן עבודה') as HTMLInputElement).value).toBe('25')
    const parts = partRows()
    expect(parts.map((p) => [p.qty.value, p.grams.value])).toEqual([
      ['1', '55.94'],
      ['2', '10'],
    ])
    expect(parts[1].name.value).toBe('Base')
    const hw = hardwareRows()
    expect(hw.names.map((x) => x.value)).toEqual(['Plant', 'Pot', 'Stand'])
    expect(hw.qty.map((x) => x.value)).toEqual(['3', '1', '1'])
    expect(hw.included.map((x) => x.checked)).toEqual([false, true, true])
    expect(shippingToggle().checked).toBe(true)
    expect((within(region('אריזה ומשלוח')).getByLabelText('פריט אריזה 1') as HTMLInputElement).value).toBe('Box')
    expect((screen.getByLabelText('עלות משלוח') as HTMLInputElement).value).toBe('20')
    expect(panel()).toMatchObject({ landed: '₪83.74', p70: '₪279.12' })
    const beforeResave = await drive.readText(after.file.id)
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Vase XL' })
    const resaved = JSON.parse(await drive.readText(after.file.id))
    const strip = (x: Record<string, unknown>) => ({ ...x, updatedAt: '' })
    expect(strip(resaved)).toEqual(strip(JSON.parse(beforeResave)))
    expect((await markedBid(drive, folder.id)).file.id).toBe(after.file.id)
  })

  it('AC32.snapshot (E1): edit keeps the bid\'s settings snapshot; "…מחדש לפי ההגדרות הנוכחיות" re-prices with current Settings (T1 at ₪80/h → T0 at ₪20/h)', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    renderApp(services, '/new')
    setValue(await screen.findByLabelText(/^שם \*$/), 'Snap')
    await addManualPart(user, '100', '3.5')
    setValue(screen.getByLabelText('זמן עבודה'), '10')
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Snap' })
    const folder = await folderByName(services.drive, root, 'Snap')

    await user.click(navLink('הגדרות'))
    setValue(await screen.findByLabelText('תעריף עבודה'), '20')
    await user.click(screen.getByRole('button', { name: 'שמירת הגדרות' }))
    await screen.findByText(/^נשמר\./)

    renderAgain(services, `/model/${folder.id}`)
    await screen.findByRole('heading', { level: 1, name: 'Snap' })
    await openEdit(user)
    expect(panel().p70).toBe('₪83.37') // T1: snapshot kept
    await user.click(screen.getByRole('button', { name: /מחדש לפי ההגדרות הנוכחיות/ }))
    expect(panel()).toMatchObject({ labor: '₪3.33', landed: '₪15.01', p70: '₪50.04' }) // T0
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Snap' })
    const b = (await markedBid(services.drive, folder.id)).json
    expect(b.settingsSnapshot.laborRate).toBe(20)
    expect(b.result.price70.toFixed(2)).toBe('50.04')
  })
})

function renderAgain(services: MemServices, path: string) {
  cleanup()
  renderApp(services, path)
}

// =============================================================================================
describe('AC33 — converting a pre-v0.4 bid creates a new marked bid.json with all old values; the old file is untouched', () => {
  const LEGACY_SNAPSHOT: Snapshot = { ...DEFAULTS, laborRate: 20 }

  function legacyBid(photoId: string) {
    const parts = [
      { name: 'body', qty: 1, grams: 60, hours: 2, source: 'manual' },
      { name: 'ears', qty: 2, grams: 20, hours: 0.5, source: 'manual' },
    ]
    const hardware = [
      { name: 'LED', qty: 1, unitCost: 12 },
      { name: 'Battery', qty: 2, unitCost: 3 },
    ]
    const packaging = [{ name: 'Box', qty: 1, unitCost: 2 }]
    return {
      schemaVersion: 1,
      id: 'legacy-owl-0001',
      name: 'Old Owl',
      revision: 'V2',
      description: 'ינשוף שנשמר לפני v0.4',
      createdAt: '2026-09-29T08:00:00.000Z',
      updatedAt: '2026-09-29T09:00:00.000Z',
      material: { name: 'PETG', pricePerKg: 95 },
      parts,
      laborMinutes: 30,
      hardware,
      hasShipping: true,
      packaging,
      shippingCost: 15,
      settingsSnapshot: LEGACY_SNAPSHOT,
      result: refResult({ parts, pricePerKg: 95, laborMinutes: 30, hardware, hasShipping: true, packaging, shippingCost: 15, s: LEGACY_SNAPSHOT }),
      files: [{ id: photoId, name: 'owl.jpg', kind: 'image', mimeType: 'image/jpeg' }],
      coverFileId: photoId,
    }
  }

  async function legacyFolder(drive: Drive, root: string) {
    // Everything the app created before v0.4 carries no marker.
    const folder = drive.addForeignFolder(root, 'Old Owl')
    const photo = drive.addLegacyAppFile(folder, 'owl.jpg', jpeg('Old Owl/owl.jpg'), 'image/jpeg')
    const old = legacyBid(photo)
    const oldText = JSON.stringify(old)
    const oldFile = drive.addLegacyAppFile(folder, 'bid.json', new Blob([oldText], { type: 'application/json' }), 'application/json')
    return { folder, photo, old, oldText, oldFile }
  }

  it('AC33.convert: legacy notice + "המר להצעה ניתנת לעריכה" → form prefilled with ALL old values (incl. snapshot prices) → save writes a NEW marked bid.json beside the old one; the old bid.json is byte-identical and never written', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const L = await legacyFolder(drive, root)
    const oldResult = L.old.result
    expect(oldResult.landed).toBeGreaterThan(0)

    renderApp(services, `/model/${L.folder}`)
    await screen.findByRole('heading', { level: 1, name: 'Old Owl' })
    expect(screen.getByTestId('legacy-bid-notice').textContent).toMatch(HEBREW)
    expect(screen.queryAllByRole('link').filter((l) => (l.textContent ?? '').includes(EDIT_BID_LABEL))).toEqual([])
    const convert = screen.getByRole('link', { name: CONVERT_LABEL })
    const logStart = drive.writeLog.length
    const targetsStart = drive.writeTargets.length
    await user.click(convert)
    await screen.findByRole('heading', { level: 1, name: new RegExp(CONVERT_LABEL) })

    // Prefilled with all old values.
    expect(nameInput().value).toBe('Old Owl')
    expect((screen.getByLabelText('תיאור') as HTMLTextAreaElement).value).toBe(L.old.description)
    expect((screen.getByLabelText('חומר') as HTMLSelectElement).value).toBe('PETG')
    expect((screen.getByLabelText('מחיר חומר') as HTMLInputElement).value).toBe('95')
    expect((screen.getByLabelText('זמן עבודה') as HTMLInputElement).value).toBe('30')
    expect(partRows().map((p) => [p.name.value, p.qty.value, p.grams.value, p.hours.value])).toEqual([
      ['body', '1', '60', '2'],
      ['ears', '2', '20', '0.5'],
    ])
    expect(hardwareRows().names.map((x) => x.value)).toEqual(['LED', 'Battery'])
    expect(hardwareRows().included.map((x) => x.checked)).toEqual([true, true])
    expect(shippingToggle().checked).toBe(true)
    expect((within(region('אריזה ומשלוח')).getByLabelText('פריט אריזה 1') as HTMLInputElement).value).toBe('Box')
    expect((screen.getByLabelText('עלות משלוח') as HTMLInputElement).value).toBe('15')
    // Prices = the old bid's (its snapshot, laborRate 20), not current Settings (80).
    const p = panel()
    expect(p.landed).toBe(`₪${oldResult.landed.toFixed(2)}`)
    expect(p.p70).toBe(`₪${oldResult.price70.toFixed(2)}`)

    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Old Owl' })

    // Two bid.json files now: the untouched old one and a new marked one.
    const all = await bidFiles(drive, L.folder)
    expect(all).toHaveLength(2)
    const oldNow = all.find((f) => f.id === L.oldFile)!
    expect(oldNow.appCreated).toBe(false)
    expect(await drive.readText(L.oldFile)).toBe(L.oldText)
    const targets = drive.writeTargets.slice(targetsStart)
    expect(targets.some((t) => t.targetId === L.oldFile), 'no write ever targets the old bid.json').toBe(false)
    expect(drive.writeLog.slice(logStart).filter((w) => /bid\.json/.test(w))).toEqual(['upload:bid.json'])
    for (const t of targets.filter((x) => x.op !== 'updateFileContent')) expect([L.folder, root]).toContain(t.targetId)

    const n = (await markedBid(drive, L.folder)).json
    expect(n.name).toBe(L.old.name)
    expect(n.description).toBe(L.old.description)
    expect(n.revision).toBe(L.old.revision)
    expect(n.material).toEqual(L.old.material)
    expect(n.parts).toEqual(L.old.parts)
    expect(n.laborMinutes).toBe(L.old.laborMinutes)
    expect(n.hardware).toEqual(L.old.hardware.map((h) => ({ ...h, included: true })))
    expect(n.hasShipping).toBe(true)
    expect(n.packaging).toEqual(L.old.packaging)
    expect(n.shippingCost).toBe(15)
    expect(n.settingsSnapshot).toEqual(LEGACY_SNAPSHOT)
    for (const k of Object.keys(oldResult) as (keyof typeof oldResult)[]) expect(n.result[k], `result.${k}`).toBeCloseTo(oldResult[k], 6)
    expect(n.files).toEqual(L.old.files)
    expect(n.coverFileId).toBe(L.photo)

    // Afterwards it edits normally: no legacy notice, "עריכת הצעה" rewrites the NEW file only.
    expect(screen.queryByTestId('legacy-bid-notice')).toBeNull()
    await openEdit(user)
    setValue(screen.getByLabelText('זמן עבודה'), '40')
    const t2 = drive.writeTargets.length
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Old Owl' })
    const updates = drive.writeTargets.slice(t2).filter((t) => t.op === 'updateFileContent').map((t) => t.targetId)
    const newFile = (await markedBid(drive, L.folder)).file
    expect(updates).toContain(newFile.id)
    expect(updates).not.toContain(L.oldFile)
    expect((await markedBid(drive, L.folder)).json.laborMinutes).toBe(40)
    expect(await drive.readText(L.oldFile)).toBe(L.oldText)
  })

  it('AC33.edit-route: opening /edit of a pre-v0.4 bid shows the read-only notice with the conversion action (no editable form)', async () => {
    const { services, root } = newServices()
    const L = await legacyFolder(services.drive, root)
    renderApp(services, `/model/${L.folder}/edit`)
    const link = await screen.findByRole('link', { name: CONVERT_LABEL })
    expect(link.getAttribute('href')).toBe(`/model/${L.folder}/create`)
    expect(screen.queryByRole('button', { name: 'שמירה' })).toBeNull()
  })
})

// =============================================================================================
describe('AC34 — cover: priced → coverFileId in bid.json; needs-slicing → _rubedo-model.json; library card shows the chosen cover in both cases', () => {
  async function chooseCoverFor(user: User, fileName: string) {
    const gallery = within(screen.getByRole('list', { name: 'תמונות הדגם' }))
    const item = gallery.getByRole('img', { name: fileName }).closest('li') as HTMLElement
    await user.click(within(item).getByRole('button', { name: SET_COVER }))
  }

  it('AC34.priced: every picture offers "קבע כתמונה ראשית"; choosing b.png updates coverFileId in the same marked bid.json (nothing else written into the folder); model header and library card show b.png', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const m = await pricedModel(drive, root)

    renderApp(services, '/library')
    await waitFor(() => expect(imgSrc('Lamp', libraryCard('Lamp'))).toBe('blob:Lamp/a.png'))
    await user.click(libraryCard('Lamp'))
    await screen.findByRole('heading', { level: 1, name: 'Lamp' })
    await waitFor(() => expect(imgSrc('Lamp — תמונה ראשית')).toBe('blob:Lamp/a.png'))
    // The current cover is marked; the other picture offers the action.
    const gallery = within(screen.getByRole('list', { name: 'תמונות הדגם' }))
    expect(gallery.getAllByRole('button', { name: SET_COVER })).toHaveLength(1)

    const bidBefore = JSON.parse(await drive.readText(m.bidFileId))
    const logStart = drive.writeLog.length
    await chooseCoverFor(user, 'b.png')
    await waitFor(() => expect(imgSrc('Lamp — תמונה ראשית')).toBe('blob:Lamp/b.png'))

    const after = await markedBid(drive, m.folderId)
    expect(after.file.id).toBe(m.bidFileId)
    expect(after.json.coverFileId).toBe(m.bId)
    expect({ ...after.json, coverFileId: '', updatedAt: '' }).toEqual({ ...bidBefore, coverFileId: '', updatedAt: '' })
    for (const w of drive.writeLog.slice(logStart)) expect(w).toMatch(/^(update:bid\.json|(upload|update):_rubedo-index\.json)$/)
    expect(drive.writeLog.slice(logStart)).toContain('update:bid.json')
    expect(await drive.listChildren(m.folderId, { name: MODEL_META_FILE })).toEqual([])

    // Library (without a manual refresh) shows the new cover.
    await user.click(navLink('ספרייה'))
    await waitFor(() => expect(imgSrc('Lamp', libraryCard('Lamp'))).toBe('blob:Lamp/b.png'))
  })

  it('AC34.needs-slicing: choosing y.jpg in a Founder folder without bid.json writes ONLY a marked _rubedo-model.json {coverFileId}; the Founder\'s files are untouched; header + library card show y.jpg', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const f = needsSlicingFolder(drive, root)
    const foreignBefore = foreignSnapshot(drive)

    renderApp(services, '/library')
    await waitFor(() => expect(imgSrc('Owl lamp', libraryCard('Owl lamp'))).toBe('blob:Owl lamp/x.jpg'))
    await user.click(libraryCard('Owl lamp'))
    await screen.findByRole('heading', { level: 1, name: 'Owl lamp' })

    const logStart = drive.writeLog.length
    const targetsStart = drive.writeTargets.length
    await chooseCoverFor(user, 'y.jpg')
    await waitFor(() => expect(imgSrc('Owl lamp — תמונה ראשית')).toBe('blob:Owl lamp/y.jpg'))

    const meta = await drive.listChildren(f.folderId, { name: MODEL_META_FILE })
    expect(meta).toHaveLength(1)
    expect(meta[0].appCreated).toBe(true)
    expect(JSON.parse(await drive.readText(meta[0].id)).coverFileId).toBe(f.yId)
    expect(await bidFiles(drive, f.folderId)).toEqual([])
    const folderWrites = drive.writeTargets.slice(targetsStart).filter((t) => t.targetId === f.folderId)
    expect(folderWrites).toEqual([{ op: 'uploadFile', targetId: f.folderId }])
    for (const w of drive.writeLog.slice(logStart)) expect(w).toMatch(/^(upload|update):(_rubedo-model\.json|_rubedo-index\.json)$/)
    expect(foreignSnapshot(drive)).toEqual(foreignBefore)

    // Choosing again rewrites the same marked meta file (no second file).
    await chooseCoverFor(user, 'x.jpg')
    await waitFor(() => expect(imgSrc('Owl lamp — תמונה ראשית')).toBe('blob:Owl lamp/x.jpg'))
    await chooseCoverFor(user, 'y.jpg')
    await waitFor(() => expect(imgSrc('Owl lamp — תמונה ראשית')).toBe('blob:Owl lamp/y.jpg'))
    expect(await drive.listChildren(f.folderId, { name: MODEL_META_FILE })).toHaveLength(1)

    await user.click(navLink('ספרייה'))
    await waitFor(() => expect(imgSrc('Owl lamp', libraryCard('Owl lamp'))).toBe('blob:Owl lamp/y.jpg'))
    // Still a needs-slicing card.
    expect(libraryCard('Owl lamp').getAttribute('data-status')).toBe('needs-slicing')
  })

  it('AC34.upload (E2): "העלה תמונה חדשה כראשית" uploads the picture INTO the model folder and makes it the cover — priced (bid.json) and needs-slicing (_rubedo-model.json)', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const m = await pricedModel(drive, root)
    const f = needsSlicingFolder(drive, root)

    renderApp(services, `/model/${m.folderId}`)
    await screen.findByRole('heading', { level: 1, name: 'Lamp' })
    await user.upload(screen.getByLabelText(UPLOAD_COVER), pngUpload('fresh.png'))
    await waitFor(() => expect(imgSrc('Lamp — תמונה ראשית')).toBe('blob:fresh.png'))
    const fresh = (await drive.listChildren(m.folderId, { name: 'fresh.png' }))[0]
    expect(fresh?.appCreated).toBe(true)
    expect((await markedBid(drive, m.folderId)).json.coverFileId).toBe(fresh.id)

    renderAgain(services, `/model/${f.folderId}`)
    await screen.findByRole('heading', { level: 1, name: 'Owl lamp' })
    await user.upload(screen.getByLabelText(UPLOAD_COVER), pngUpload('owl-new.png'))
    await waitFor(() => expect(imgSrc('Owl lamp — תמונה ראשית')).toBe('blob:owl-new.png'))
    const owlNew = (await drive.listChildren(f.folderId, { name: 'owl-new.png' }))[0]
    expect(owlNew?.appCreated).toBe(true)
    const meta = (await drive.listChildren(f.folderId, { name: MODEL_META_FILE }))[0]
    expect(JSON.parse(await drive.readText(meta.id)).coverFileId).toBe(owlNew.id)

    await user.click(navLink('ספרייה'))
    await user.click(await screen.findByRole('button', { name: 'רענון ספרייה' }))
    await waitFor(() => expect(imgSrc('Lamp', libraryCard('Lamp'))).toBe('blob:fresh.png'))
    await waitFor(() => expect(imgSrc('Owl lamp', libraryCard('Owl lamp'))).toBe('blob:owl-new.png'))
  })
})

// =============================================================================================
describe('AC35 — inline description edit persists for priced and needs-slicing models; 2000-char limit enforced', () => {
  async function editDescription(user: User, text: string) {
    await user.click(screen.getByRole('button', { name: 'עריכת תיאור' }))
    setValue(screen.getByLabelText('תיאור הדגם'), text)
  }

  function saveDescriptionButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: 'שמירת תיאור' }) as HTMLButtonElement
  }

  it('AC35.priced: pencil → textarea → save rewrites only the description in the same marked bid.json; persists after reload; no full form opened', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const m = await pricedModel(drive, root)
    renderApp(services, `/model/${m.folderId}`)
    await screen.findByRole('heading', { level: 1, name: 'Lamp' })
    expect(screen.getByTestId('model-description').textContent).toBe('תיאור ישן')

    const before = JSON.parse(await drive.readText(m.bidFileId))
    await editDescription(user, 'מנורת ינשוף\nעם 3 נורות')
    expect(screen.queryByRole('button', { name: 'שמירה' }), 'no full bid form').toBeNull()
    const logStart = drive.writeLog.length
    await user.click(saveDescriptionButton())
    await waitFor(() => expect(screen.getByTestId('model-description').textContent).toBe('מנורת ינשוף\nעם 3 נורות'))

    const after = await markedBid(drive, m.folderId)
    expect(after.file.id).toBe(m.bidFileId)
    expect(after.json.description).toBe('מנורת ינשוף\nעם 3 נורות')
    expect({ ...after.json, description: '', updatedAt: '' }).toEqual({ ...before, description: '', updatedAt: '' })
    for (const w of drive.writeLog.slice(logStart)) expect(w).toMatch(/^(update:bid\.json|(upload|update):_rubedo-index\.json)$/)

    renderAgain(services, `/model/${m.folderId}`)
    await screen.findByRole('heading', { level: 1, name: 'Lamp' })
    expect(screen.getByTestId('model-description').textContent).toBe('מנורת ינשוף\nעם 3 נורות')
  })

  it('AC35.needs-slicing: description saved in a marked _rubedo-model.json (no bid.json created), persists after reload, and — with the chosen cover — prefills "צור הצעת מחיר" (E3)', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const f = needsSlicingFolder(drive, root)
    renderApp(services, `/model/${f.folderId}`)
    await screen.findByRole('heading', { level: 1, name: 'Owl lamp' })
    await editDescription(user, 'ינשוף מודפס')
    await user.click(saveDescriptionButton())
    await waitFor(() => expect(screen.getByTestId('model-description').textContent).toBe('ינשוף מודפס'))

    const meta = await drive.listChildren(f.folderId, { name: MODEL_META_FILE })
    expect(meta).toHaveLength(1)
    expect(meta[0].appCreated).toBe(true)
    expect(JSON.parse(await drive.readText(meta[0].id)).description).toBe('ינשוף מודפס')
    expect(await bidFiles(drive, f.folderId)).toEqual([])

    // Cover too, then reload.
    const item = within(screen.getByRole('list', { name: 'תמונות הדגם' })).getByRole('img', { name: 'y.jpg' }).closest('li') as HTMLElement
    await user.click(within(item).getByRole('button', { name: SET_COVER }))
    await waitFor(() => expect(imgSrc('Owl lamp — תמונה ראשית')).toBe('blob:Owl lamp/y.jpg'))
    expect(await drive.listChildren(f.folderId, { name: MODEL_META_FILE })).toHaveLength(1)
    const metaNow = JSON.parse(await drive.readText(meta[0].id))
    expect(metaNow).toMatchObject({ description: 'ינשוף מודפס', coverFileId: f.yId })

    renderAgain(services, `/model/${f.folderId}`)
    await screen.findByRole('heading', { level: 1, name: 'Owl lamp' })
    expect(screen.getByTestId('model-description').textContent).toBe('ינשוף מודפס')

    // E3: creating the bid later is prefilled with both.
    await user.click(screen.getByRole('link', { name: 'צור הצעת מחיר' }))
    await screen.findByRole('button', { name: /הוספת חלק ידנית/ })
    expect((screen.getByLabelText('תיאור') as HTMLTextAreaElement).value).toBe('ינשוף מודפס')
    await addManualPart(user, '100', '3.5')
    setValue(screen.getByLabelText('זמן עבודה'), '10')
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Owl lamp' })
    const bid = (await markedBid(drive, f.folderId)).json
    expect(bid.description).toBe('ינשוף מודפס')
    expect(bid.coverFileId).toBe(f.yId)
    expect(bid.result.price70.toFixed(2)).toBe('83.37') // T1
  })

  it('AC35.limit: 2001 characters → Hebrew error, save disabled, nothing written (priced and needs-slicing); exactly 2000 → saved', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const m = await pricedModel(drive, root)
    const f = needsSlicingFolder(drive, root)

    for (const target of [
      { folderId: m.folderId, title: 'Lamp' },
      { folderId: f.folderId, title: 'Owl lamp' },
    ]) {
      renderAgain(services, `/model/${target.folderId}`)
      await screen.findByRole('heading', { level: 1, name: target.title })
      const logStart = drive.writeLog.length
      await editDescription(user, 'א'.repeat(2001))
      await waitFor(() => expect(screen.getAllByRole('alert').some((a) => /2000/.test(a.textContent ?? '') && HEBREW.test(a.textContent ?? ''))).toBe(true))
      expect(saveDescriptionButton().disabled).toBe(true)
      await user.click(saveDescriptionButton())
      expect(drive.writeLog.slice(logStart), `${target.title}: nothing written for 2001 chars`).toEqual([])

      setValue(screen.getByLabelText('תיאור הדגם'), 'ב'.repeat(2000))
      expect(saveDescriptionButton().disabled).toBe(false)
      await user.click(saveDescriptionButton())
      await waitFor(() => expect(screen.getByTestId('model-description').textContent).toBe('ב'.repeat(2000)))
    }
    expect((await markedBid(drive, m.folderId)).json.description).toBe('ב'.repeat(2000))
    const meta = (await drive.listChildren(f.folderId, { name: MODEL_META_FILE }))[0]
    expect(JSON.parse(await drive.readText(meta.id)).description).toBe('ב'.repeat(2000))
  })
})

// =============================================================================================
describe('AC36 — customers: add / edit / hide / search; e-mail unique; nothing is ever deleted', () => {
  function addForm() {
    return within(screen.getByRole('form', { name: 'הוספת לקוח' }))
  }

  async function addCustomerUi(user: User, c: { name: string; email: string; phone?: string; notes?: string }) {
    await user.click(screen.getByRole('button', { name: /לקוח חדש/ }))
    const form = addForm()
    setValue(form.getByLabelText(/^שם/), c.name)
    setValue(form.getByLabelText(/^מייל/), c.email)
    if (c.phone !== undefined) setValue(form.getByLabelText(/^טלפון/), c.phone)
    if (c.notes !== undefined) setValue(form.getByLabelText(/^הערות/), c.notes)
    await user.click(form.getByRole('button', { name: 'הוספת לקוח' }))
  }

  function rowNames(): string[] {
    return screen.queryAllByTestId('customer-row').map((r) => within(r).getAllByRole('link')[0].textContent ?? '')
  }

  it('AC36.crud: header nav "לקוחות" → add (marked _rubedo-customers.json in the models folder, brief schema) → duplicate e-mail (any case) refused → edit → hide (kept in file, hidden from list unless toggled) → search by name / e-mail; no delete anywhere', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    renderApp(services, '/')
    await user.click(navLink('לקוחות'))
    await screen.findByRole('heading', { level: 1, name: 'לקוחות' })
    expect(await readCustomers(drive, root)).toBeNull()

    // Add
    await addCustomerUi(user, { name: 'דנה כהן', email: 'dana@example.com', phone: '050-1234567', notes: 'מעדיפה ירוק' })
    await waitFor(() => expect(rowNames()).toEqual(['דנה כהן']))
    await addCustomerUi(user, { name: 'Yossi Levi', email: 'yossi@example.com' })
    await waitFor(() => expect(rowNames()).toHaveLength(2))
    let list = (await readCustomers(drive, root))!
    expect(list).toHaveLength(2)
    const dana = list.find((c) => c.email === 'dana@example.com')!
    expect(dana).toMatchObject({ name: 'דנה כהן', phone: '050-1234567', notes: 'מעדיפה ירוק' })
    expect(typeof dana.id).toBe('string')
    expect(Number.isNaN(Date.parse(String(dana.createdAt)))).toBe(false)
    expect(Number.isNaN(Date.parse(String(dana.updatedAt)))).toBe(false)
    const ids = list.map((c) => c.id)
    expect(new Set(ids).size).toBe(2)

    // Email uniqueness, case-insensitive: refused with a Hebrew error, file unchanged.
    const fileBefore = JSON.stringify(list)
    await addCustomerUi(user, { name: 'Dana again', email: 'DANA@Example.com' })
    await waitFor(() => expect(within(screen.getByRole('form', { name: 'הוספת לקוח' })).getAllByRole('alert').some((a) => HEBREW.test(a.textContent ?? ''))).toBe(true))
    expect(JSON.stringify(await readCustomers(drive, root))).toBe(fileBefore)
    await user.click(addForm().getByRole('button', { name: 'ביטול' }))

    // Search by name and by e-mail.
    const search = screen.getByRole('searchbox', { name: /חיפוש/ })
    setValue(search, 'דנה')
    expect(rowNames()).toEqual(['דנה כהן'])
    setValue(search, 'YOSSI@')
    expect(rowNames()).toEqual(['Yossi Levi'])
    setValue(search, '')

    // Edit (customer page): name + phone; same id, createdAt kept. Changing to another customer's e-mail is refused.
    await user.click(screen.getByRole('link', { name: 'Yossi Levi' }))
    await screen.findByRole('heading', { level: 1, name: 'Yossi Levi' })
    await user.click(screen.getByRole('button', { name: 'עריכת פרטי לקוח' }))
    const editForm = within(screen.getByRole('form', { name: 'שמירת פרטי לקוח' }))
    setValue(editForm.getByLabelText(/^מייל/), 'Dana@example.com')
    await user.click(editForm.getByRole('button', { name: 'שמירת פרטי לקוח' }))
    await waitFor(() => expect(editForm.getAllByRole('alert').some((a) => HEBREW.test(a.textContent ?? ''))).toBe(true))
    expect(JSON.stringify(await readCustomers(drive, root))).toBe(fileBefore)
    setValue(editForm.getByLabelText(/^מייל/), 'yossi@example.com')
    setValue(editForm.getByLabelText(/^שם/), 'יוסי לוי')
    setValue(editForm.getByLabelText(/^טלפון/), '052-7654321')
    await user.click(editForm.getByRole('button', { name: 'שמירת פרטי לקוח' }))
    await screen.findByRole('heading', { level: 1, name: 'יוסי לוי' })
    list = (await readCustomers(drive, root))!
    const yossiBefore = JSON.parse(fileBefore).find((c: { email: string }) => c.email === 'yossi@example.com')
    const yossi = list.find((c) => c.id === yossiBefore.id)!
    expect(yossi).toMatchObject({ name: 'יוסי לוי', email: 'yossi@example.com', phone: '052-7654321', createdAt: yossiBefore.createdAt })
    expect(list).toHaveLength(2)

    // Hide: no delete action exists; the customer stays in the file, flagged, and leaves the default list.
    expect(screen.queryByRole('button', { name: /מחק|מחיקה|הסר לקוח/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'הסתר' }))
    await screen.findByRole('button', { name: 'הצג שוב' })
    list = (await readCustomers(drive, root))!
    expect(list).toHaveLength(2)
    expect(list.find((c) => c.id === yossi.id)).toMatchObject({ name: 'יוסי לוי', email: 'yossi@example.com' })
    // The hide flag was recorded in the file (some field other than updatedAt changed).
    const hiddenNow = { ...list.find((c) => c.id === yossi.id), updatedAt: '' }
    expect(hiddenNow).not.toEqual({ ...yossi, updatedAt: '' })

    await user.click(screen.getByRole('link', { name: 'לכל הלקוחות' }))
    await screen.findByRole('heading', { level: 1, name: 'לקוחות' })
    await waitFor(() => expect(rowNames()).toEqual(['דנה כהן']))
    expect(screen.queryByRole('button', { name: /מחק|מחיקה/ })).toBeNull()
    await user.click(screen.getByRole('checkbox', { name: /מוסתרים/ }))
    await waitFor(() => expect(rowNames().sort()).toEqual(['דנה כהן', 'יוסי לוי'].sort()))

    // Hidden customers are not offered in the quote screen's picker.
    const model = await memoryQuoteModel(services, root)
    renderAgain(services, `/model/${model.folderId}/quote`)
    const picker = await screen.findByRole('combobox', { name: 'בחירת לקוח קיים' })
    await user.click(picker)
    await user.type(picker, 'example.com')
    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.textContent ?? '').join('|')).toContain('dana@example.com')
    expect(options.map((o) => o.textContent ?? '').join('|')).not.toContain('yossi@example.com')

    // Nothing was ever removed: every customer ever added is still in the file; only create/update writes happened.
    list = (await readCustomers(drive, root))!
    expect(list.map((c) => c.id).sort()).toEqual([...ids].sort())
    for (const w of drive.writeLog) expect(w).toMatch(/^(folder|upload|update):/)
  })
})

// =============================================================================================
describe('AC37 — quote screen: picker fills name+email; a new customer is saved only after a successful draft; a failed draft saves nothing', () => {
  const NOW = '2026-10-01T10:00:00.000Z'
  const SEED = [
    { id: 'cust-dana-0001', name: 'דנה כהן', email: 'dana@example.com', phone: '050-1234567', createdAt: NOW, updatedAt: NOW },
    { id: 'cust-yossi-002', name: 'Yossi Levi', email: 'yossi@example.com', createdAt: NOW, updatedAt: NOW },
  ]

  function nameField() {
    return screen.getByLabelText(/^שם הלקוח/) as HTMLInputElement
  }
  function emailField() {
    return screen.getByLabelText(/^מייל הלקוח/) as HTMLInputElement
  }

  async function quoteLogs(drive: Drive, modelFolderId: string) {
    const q = await drive.listChildren(modelFolderId, { name: 'quotes', foldersOnly: true })
    if (q.length === 0) return []
    const files = await drive.listChildren(q[0].id)
    return Promise.all(files.map(async (f) => JSON.parse(await drive.readText(f.id))))
  }

  async function draftSucceeded() {
    await screen.findByRole('link', { name: /טיוטות/ }, { timeout: 4000 })
  }

  it('AC37.picker: type-ahead on name and on e-mail; picking fills name + email; the draft and its log use that customer (log carries customerId); the customers file is not rewritten', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const seeded = await uploadJson(drive, root, CUSTOMERS_FILE, SEED)
    const m = await memoryQuoteModel(services, root)
    renderApp(services, `/model/${m.folderId}/quote`)
    const picker = await screen.findByRole('combobox', { name: 'בחירת לקוח קיים' })

    // By e-mail
    await user.click(picker)
    await user.type(picker, 'yossi@')
    let options = await screen.findAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0].textContent).toContain('Yossi Levi')
    // By name
    await user.clear(picker)
    await user.type(picker, 'דנה')
    options = await screen.findAllByRole('option')
    expect(options).toHaveLength(1)
    await user.click(options[0])
    expect(nameField().value).toBe('דנה כהן')
    expect(emailField().value).toBe('dana@example.com')

    const logStart = drive.writeLog.length
    await user.click(screen.getByRole('button', { name: CREATE_DRAFT }))
    await draftSucceeded()
    expect(services.mail.drafts).toHaveLength(1)
    expect(services.mail.drafts[0].raw).toContain('dana@example.com')
    const logs = await quoteLogs(drive, m.folderId)
    expect(logs).toHaveLength(1)
    expect(logs[0].customerId).toBe('cust-dana-0001')
    expect(await drive.readText(seeded.id)).toBe(JSON.stringify(SEED))
    expect(drive.writeLog.slice(logStart).some((w) => w.includes(CUSTOMERS_FILE))).toBe(false)
  })

  it('AC37.new-customer: a new name+email is NOT saved while typing or on a failed draft (no write at all); after a successful draft it is added (marked file, brief schema) and the log\'s customerId is that customer', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const m = await memoryQuoteModel(services, root)
    renderApp(services, `/model/${m.folderId}/quote`)
    await screen.findByRole('combobox', { name: 'בחירת לקוח קיים' })
    const logStart = drive.writeLog.length

    setValue(nameField(), 'רונית אברהם')
    setValue(emailField(), 'ronit@example.com')
    await new Promise((r) => setTimeout(r, 50))
    expect(await readCustomers(drive, root)).toBeNull()
    expect(drive.writeLog.slice(logStart)).toEqual([])

    // Failed draft → nothing saved.
    services.mail.failNext('network')
    await user.click(screen.getByRole('button', { name: CREATE_DRAFT }))
    await waitFor(() => expect(screen.getAllByRole('alert').some((a) => HEBREW.test(a.textContent ?? ''))).toBe(true))
    expect(services.mail.drafts).toHaveLength(0)
    expect(await readCustomers(drive, root)).toBeNull()
    expect(drive.writeLog.slice(logStart)).toEqual([])

    // Successful draft → added.
    await user.click(screen.getByRole('button', { name: CREATE_DRAFT }))
    await draftSucceeded()
    const list = await waitFor(async () => {
      const l = await readCustomers(drive, root)
      expect(l).not.toBeNull()
      return l!
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'רונית אברהם', email: 'ronit@example.com' })
    expect(typeof list[0].id).toBe('string')
    expect(Number.isNaN(Date.parse(String(list[0].createdAt)))).toBe(false)
    const logs = await quoteLogs(drive, m.folderId)
    expect(logs).toHaveLength(1)
    expect(logs[0].customerId).toBe(list[0].id)
    // The customer was saved after the log (the draft already existed by then).
    const w = drive.writeLog.slice(logStart)
    expect(w.findIndex((x) => x.includes(CUSTOMERS_FILE))).toBeGreaterThan(w.findIndex((x) => x.startsWith('upload:quote-')))

    // The new customer is now offered by the picker.
    renderAgain(services, `/model/${m.folderId}/quote`)
    const picker = await screen.findByRole('combobox', { name: 'בחירת לקוח קיים' })
    await user.click(picker)
    await user.type(picker, 'ronit')
    expect((await screen.findAllByRole('option'))[0].textContent).toContain('רונית אברהם')
  })

  it('AC37.existing-email: typing a stored e-mail (other case) with a different name → after the draft the stored name is kept, nothing is added, and a small notice says so', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const seeded = await uploadJson(drive, root, CUSTOMERS_FILE, SEED)
    const m = await memoryQuoteModel(services, root)
    renderApp(services, `/model/${m.folderId}/quote`)
    await screen.findByRole('combobox', { name: 'בחירת לקוח קיים' })
    setValue(nameField(), 'Dana K')
    setValue(emailField(), 'DANA@example.com')
    await user.click(screen.getByRole('button', { name: CREATE_DRAFT }))
    await draftSucceeded()
    await screen.findByText((text) => text.includes('דנה כהן') && /dana@example\.com/i.test(text))
    expect(await drive.readText(seeded.id)).toBe(JSON.stringify(SEED))
    const logs = await quoteLogs(drive, m.folderId)
    expect(logs[0].customerId).toBe('cust-dana-0001')
  })
})

// =============================================================================================
describe('AC38 — customer page lists quotes from all models (incl. old logs matched by e-mail) newest first; "new quote" opens the quote screen prefilled', () => {
  const NOW = '2026-09-01T10:00:00.000Z'
  const SEED = [
    { id: 'cust-dana-0001', name: 'דנה כהן', email: 'dana@example.com', createdAt: NOW, updatedAt: NOW },
    { id: 'cust-yossi-002', name: 'Yossi Levi', email: 'yossi@example.com', createdAt: NOW, updatedAt: NOW },
  ]

  /** A quote log as v0.5 (no customerId) or v0.6 (with customerId) wrote it — brief Q4 fields. */
  function log(o: { date: string; model: string; name: string; email: string; price: number; customerId?: string }) {
    return {
      schemaVersion: 1,
      date: o.date,
      draftId: `draft-${o.date}`,
      model: { bidId: `bid-${o.model}`, name: o.model, revision: 'V1' },
      customer: { name: o.name, email: o.email },
      includedHardware: [],
      priceShown: o.price,
      landed: 10,
      price70: 33.33,
      savedBid: { landed: 10, price70: 33.33 },
      attachments: [],
      ...(o.customerId ? { customerId: o.customerId } : {}),
    }
  }

  async function setup() {
    const { services, root } = newServices()
    const drive = services.drive
    await uploadJson(drive, root, CUSTOMERS_FILE, SEED)
    const a = await memoryQuoteModel(services, root) // RootLab
    const bFolder = await drive.createFolder(root, 'Owl lamp')
    await uploadJson(drive, bFolder.id, 'bid.json', bidJson({ schemaVersion: 2, name: 'Owl lamp', grams: 50, hours: 1, laborMinutes: 0, hardware: [] }))
    const qa = await drive.createFolder(a.folderId, 'quotes')
    const qb = await drive.createFolder(bFolder.id, 'quotes')
    // Old v0.5 log (no customerId) → matched by e-mail.
    await uploadJson(drive, qa.id, 'quote-20260920-1000.json', log({ date: '2026-09-20T10:00:00.000Z', model: MODEL_NAME, name: 'דנה', email: 'dana@example.com', price: 101 }))
    // v0.6 log with customerId.
    await uploadJson(drive, qb.id, 'quote-20261001-0900.json', log({ date: '2026-10-01T09:00:00.000Z', model: 'Owl lamp', name: 'דנה כהן', email: 'dana@example.com', price: 77, customerId: 'cust-dana-0001' }))
    // Another customer's quote (between the two dates) — must not appear on Dana's page.
    await uploadJson(drive, qb.id, 'quote-20260925-1200.json', log({ date: '2026-09-25T12:00:00.000Z', model: 'Owl lamp', name: 'Yossi Levi', email: 'yossi@example.com', price: 55, customerId: 'cust-yossi-002' }))
    return { services, root, drive, a, bFolderId: bFolder.id }
  }

  function quoteRows() {
    return screen.queryAllByTestId('customer-quote')
  }

  it('AC38.history: Dana\'s page lists both models\' quotes (old log by e-mail + new log by id), newest first, with price shown and a link to each model; Yossi\'s quote is not there; the list shows her count', async () => {
    const user = userEvent.setup()
    const s = await setup()
    renderApp(s.services, '/customers')
    await waitFor(() => expect(screen.getAllByTestId('customer-row')).toHaveLength(2))
    const danaRow = screen.getAllByTestId('customer-row').find((r) => (r.textContent ?? '').includes('דנה כהן'))!
    await waitFor(() => expect(within(danaRow).getByTestId('customer-quote-count').textContent).toBe('2'))

    await user.click(within(danaRow).getByRole('link', { name: 'דנה כהן' }))
    await screen.findByRole('heading', { level: 1, name: 'דנה כהן' })
    await waitFor(() => expect(quoteRows()).toHaveLength(2))
    const [first, second] = quoteRows()
    expect(first.textContent).toContain('Owl lamp')
    expect(first.textContent).toContain('77')
    expect(within(first).getByRole('link', { name: 'Owl lamp' }).getAttribute('href')).toBe(`/model/${s.bFolderId}`)
    expect(second.textContent).toContain(MODEL_NAME)
    expect(second.textContent).toContain('101')
    expect(within(second).getByRole('link', { name: MODEL_NAME }).getAttribute('href')).toBe(`/model/${s.a.folderId}`)
    expect(screen.queryByText(/55/)).toBeNull()
  })

  it('AC38.new-quote: "שליחת הצעה חדשה" → choose a model → its quote screen prefilled with the customer; the draft\'s log is listed first on her page afterwards', async () => {
    const user = userEvent.setup()
    const s = await setup()
    renderApp(s.services, '/customers/cust-dana-0001')
    await screen.findByRole('heading', { level: 1, name: 'דנה כהן' })
    await user.click(screen.getByRole('button', { name: 'שליחת הצעה חדשה' }))
    const dialog = await screen.findByRole('dialog')
    const choice = await within(dialog).findByRole('button', { name: new RegExp('RootLab') })
    await user.click(choice)

    const name = (await screen.findByLabelText(/^שם הלקוח/, {}, { timeout: 4000 })) as HTMLInputElement
    await waitFor(() => expect(name.value).toBe('דנה כהן'))
    expect((screen.getByLabelText(/^מייל הלקוח/) as HTMLInputElement).value).toBe('dana@example.com')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(MODEL_NAME)

    await user.click(screen.getByRole('button', { name: CREATE_DRAFT }))
    await screen.findByRole('link', { name: /טיוטות/ }, { timeout: 4000 })

    renderAgain(s.services, '/customers/cust-dana-0001')
    await screen.findByRole('heading', { level: 1, name: 'דנה כהן' })
    await waitFor(() => expect(quoteRows()).toHaveLength(3))
    expect(quoteRows()[0].textContent).toContain(MODEL_NAME)
    expect(quoteRows()[0].textContent).toContain('101') // default customer price = ceil(₪100.04)
    expect(quoteRows()[1].textContent).toContain('Owl lamp')
  })
})

