import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../src/App'
import {
  bidPricingInput,
  BID_FILE_NAME,
  CUSTOMERS_FILE_NAME,
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_TOO_LONG_MESSAGE,
  INDEX_FILE_NAME,
  MODEL_META_FILE_NAME,
  type Bid,
  type HardwareLine,
} from '../../src/lib/bid'
import { pickerCustomers, quotesForCustomer, summariseQuotes } from '../../src/lib/customers'
import {
  FOLDER_SCAN_CONCURRENCY,
  loadLibrary,
  loadModelFolder,
  loadQuoteHistory,
  markQuotesChanged,
  newSaveSession,
  rebuildIndex,
  saveNewBid,
  setModelCover,
  setModelDescription,
  updateBid,
  uploadModelCover,
  type BidContent,
} from '../../src/lib/drive/bidRepository'
import { addCustomer, ensureQuoteCustomer, loadCustomers, setCustomerHidden, updateCustomer } from '../../src/lib/drive/customerStore'
import { classifyFolder } from '../../src/lib/drive/folderContents'
import { MemoryDrive } from '../../src/lib/drive/memoryDrive'
import { writeQuoteLog } from '../../src/lib/drive/quoteLog'
import { computePrice, DEFAULT_PRICING_SETTINGS, type PricingSettings } from '../../src/lib/pricing'
import type { QuoteRecord } from '../../src/lib/quote'
import { createMemoryServices, type AppServices } from '../../src/state/services'

const S = DEFAULT_PRICING_SETTINGS
const jpeg = (n = 1) => new Blob([new Uint8Array([0xff, 0xd8, n])], { type: 'image/jpeg' })

function renderApp(services: AppServices, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App services={services} />
    </MemoryRouter>,
  )
}

const HARDWARE: HardwareLine[] = [
  { name: 'מבחנות', qty: 5, unitCost: 3, included: true },
  { name: 'צמח', qty: 1, unitCost: 20, included: false },
]

function content(name: string, over: Partial<BidContent> = {}, snapshot: PricingSettings = S): BidContent {
  const base: BidContent = {
    name,
    revision: 'V1',
    description: 'תיאור',
    material: { name: 'PLA', pricePerKg: 85 },
    parts: [{ name: 'Base', qty: 1, grams: 100, hours: 3.5, source: 'manual' }],
    laborMinutes: 10,
    hardware: HARDWARE,
    hasShipping: true,
    packaging: [{ name: 'קופסה', qty: 1, unitCost: 3 }],
    shippingCost: 15,
    settingsSnapshot: { ...snapshot },
    result: computePrice({ pricePerKg: 85, parts: [], laborMinutes: 0, hardware: [], hasShipping: false, packaging: [], shippingCost: 0 }, snapshot),
    ...over,
  }
  const pseudo = { ...base, files: [], schemaVersion: 2, id: '', createdAt: '', updatedAt: '' } as unknown as Bid
  return { ...base, result: computePrice(bidPricingInput(pseudo), snapshot) }
}

async function pricedModel(drive: MemoryDrive, root: string, name = 'RootLab') {
  const { folderId, bid } = await saveNewBid(drive, root, { folderName: name, content: content(name), files: [] }, newSaveSession())
  return { folderId, bid }
}

function services() {
  const drive = new MemoryDrive()
  const s = createMemoryServices(drive)
  return { s, drive, root: s.folderPointer.get() as string }
}

async function bidJson(drive: MemoryDrive, folderId: string): Promise<{ bid: Bid; fileId: string; marked: boolean; count: number }> {
  const files = await drive.listChildren(folderId, { name: BID_FILE_NAME })
  const f = files.find((x) => x.appCreated) ?? files[0]
  return { bid: JSON.parse(await drive.readText(f.id)), fileId: f.id, marked: f.appCreated === true, count: files.length }
}

function updateTargets(drive: MemoryDrive, from = 0): string[] {
  return drive.writeTargets.slice(from).filter((w) => w.op === 'updateFileContent').map((w) => w.targetId)
}

async function indexId(drive: MemoryDrive, root: string): Promise<string> {
  return (await drive.listChildren(root, { name: INDEX_FILE_NAME }))[0].id
}

// ---------------------------------------------------------------------------------------------
describe('E1 / AC32 — editing a marked bid', () => {
  it('lib: every E1 field round-trips; only that bid.json (marker kept) and the index are rewritten', async () => {
    const { drive, root } = services()
    const { folderId, bid } = await pricedModel(drive, root)
    const { fileId } = await bidJson(drive, folderId)
    const idx = await indexId(drive, root)
    const w0 = drive.writeTargets.length
    const edited = content('RootLab Pro', {
      description: 'חדש',
      material: { name: 'PETG', pricePerKg: 100 },
      parts: [
        { name: 'A', qty: 2, grams: 50, hours: 1, source: 'manual' },
        { name: 'B', qty: 1, grams: 10, hours: 0.5, source: '3mf' },
      ],
      laborMinutes: 30,
      hardware: [{ name: 'מבחנות', qty: 6, unitCost: 3, included: false }, { name: 'ברגים', qty: 4, unitCost: 0.5, included: true }],
      hasShipping: false,
      packaging: [],
      shippingCost: 0,
    })
    const photo = { key: 'p', name: 'new.jpg', kind: 'image' as const, mimeType: 'image/jpeg', blob: jpeg() }
    await updateBid(drive, root, { folderId, existing: bid, content: edited, newFiles: [photo] }, newSaveSession())

    const after = await bidJson(drive, folderId)
    expect(after.marked).toBe(true)
    expect(after.count).toBe(1)
    expect(after.fileId).toBe(fileId)
    const { id, createdAt, files, coverFileId, ...rest } = after.bid
    expect(id).toBe(bid.id)
    expect(createdAt).toBe(bid.createdAt)
    expect(rest).toMatchObject({ ...edited })
    expect(files.map((f) => f.name)).toEqual(['new.jpg'])
    expect(coverFileId).toBe(files[0].id)
    expect(new Set(updateTargets(drive, w0))).toEqual(new Set([fileId, idx]))
  })

  it('UI: the model page shows a prominent "עריכת הצעה"; the form edits description + included flag and saves', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const { folderId } = await pricedModel(drive, root)
    renderApp(s, `/model/${folderId}`)
    const edit = (await screen.findByText('עריכת הצעה')).closest('a') as HTMLAnchorElement
    expect(edit.getAttribute('href')).toBe(`/model/${folderId}/edit`)
    expect(edit.className).toContain('btn-primary')
    await user.click(edit)
    const desc = (await screen.findByLabelText('תיאור')) as HTMLTextAreaElement
    expect(desc.value).toBe('תיאור')
    fireEvent.change(desc, { target: { value: 'תיאור ערוך' } })
    expect(screen.getByTestId('description-counter').textContent).toContain(`10/${DESCRIPTION_MAX_LENGTH}`)
    const hw = within(screen.getByRole('region', { name: 'חומרה' }))
    const boxes = hw.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map((b) => b.checked)).toEqual([true, false])
    await user.click(boxes[1])
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    await screen.findByRole('heading', { level: 1, name: 'RootLab' })
    const { bid } = await bidJson(drive, folderId)
    expect(bid.description).toBe('תיאור ערוך')
    expect(bid.hardware.map((h) => h.included)).toEqual([true, true])
  })

  it('bid form: a description over 2000 characters blocks saving with a Hebrew message (nothing is cut off)', async () => {
    const { s, drive, root } = services()
    const { folderId } = await pricedModel(drive, root)
    renderApp(s, `/model/${folderId}/edit`)
    const desc = (await screen.findByLabelText('תיאור')) as HTMLTextAreaElement
    const long = 'א'.repeat(DESCRIPTION_MAX_LENGTH + 1)
    fireEvent.change(desc, { target: { value: long } })
    expect(desc.value).toBe(long)
    expect(screen.getAllByRole('alert').some((a) => a.textContent === DESCRIPTION_TOO_LONG_MESSAGE)).toBe(true)
    expect((screen.getByRole('button', { name: 'שמירה' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(desc, { target: { value: 'א'.repeat(DESCRIPTION_MAX_LENGTH) } })
    expect((screen.getByRole('button', { name: 'שמירה' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
describe('E1 / AC33 — converting a pre-v0.4 bid', () => {
  it('"המר להצעה ניתנת לעריכה" prefills ALL old values; the new marked bid.json keeps them; the old file is untouched', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const folder = drive.addForeignFolder(root, 'Old lamp')
    const photo = drive.addForeignFile(folder, 'z-photo.jpg', jpeg(), 'image/jpeg')
    const sliced = drive.addForeignFile(folder, 'lamp.gcode.3mf', new Blob(['x']), 'application/octet-stream')
    // Old settings (labor ₪50/h): the converted bid keeps this snapshot and so its prices.
    const snapshot = { ...S, laborRate: 50 }
    const c = content('Old lamp', { description: 'מנורה ישנה', laborMinutes: 12 }, snapshot)
    c.parts = [{ name: 'Shade', qty: 2, grams: 40, hours: 2, source: '3mf', slicedFileId: sliced }]
    const pseudo = { ...c, files: [], schemaVersion: 1, id: '', createdAt: '', updatedAt: '' } as unknown as Bid
    c.result = computePrice(bidPricingInput(pseudo), snapshot)
    const legacy = {
      ...c,
      schemaVersion: 1,
      id: 'old-id',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
      files: [
        { id: photo, name: 'z-photo.jpg', kind: 'image', mimeType: 'image/jpeg' },
        { id: sliced, name: 'lamp.gcode.3mf', kind: 'sliced', mimeType: 'application/octet-stream' },
      ],
      coverFileId: photo,
    }
    const legacyId = drive.addLegacyAppFile(folder, BID_FILE_NAME, new Blob([JSON.stringify(legacy)]), 'application/json')
    const oldBlob = await drive.readBlob(legacyId)

    renderApp(s, `/model/${folder}`)
    await user.click(await screen.findByRole('link', { name: 'המר להצעה ניתנת לעריכה' }))
    expect(((await screen.findByLabelText('תיאור')) as HTMLTextAreaElement).value).toBe('מנורה ישנה')
    expect((screen.getByLabelText('זמן עבודה') as HTMLInputElement).value).toBe('12')
    // The old snapshot is used (not the current Settings) — the 70% price is unchanged.
    expect(screen.getByTestId('sticky-price-70').textContent).toBe(`₪${c.result.price70.toFixed(2)}`)
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    await screen.findByRole('heading', { level: 1, name: 'Old lamp' })

    const { bid, marked, count } = await bidJson(drive, folder)
    expect(marked).toBe(true)
    expect(count).toBe(2)
    expect(bid).toMatchObject({
      name: 'Old lamp',
      description: 'מנורה ישנה',
      laborMinutes: 12,
      material: c.material,
      hardware: HARDWARE,
      hasShipping: true,
      packaging: c.packaging,
      shippingCost: 15,
      settingsSnapshot: snapshot,
      coverFileId: photo,
    })
    expect(bid.parts).toEqual([{ name: 'Shade', qty: 2, grams: 40, hours: 2, source: '3mf', slicedFileId: sliced }])
    expect(bid.result.price70).toBeCloseTo(c.result.price70, 10)
    expect(bid.files.map((f) => f.id).sort()).toEqual([photo, sliced].sort())
    // Old file untouched; nothing re-uploaded.
    expect(await drive.readBlob(legacyId)).toBe(oldBlob)
    expect(updateTargets(drive)).not.toContain(legacyId)
    expect(drive.writeLog.filter((w) => w.startsWith('upload:') && !w.includes('json'))).toEqual([])
    // Afterwards it edits normally.
    expect(screen.getByText('עריכת הצעה')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------
describe('E2 / AC34 — model cover', () => {
  it('priced: setModelCover writes coverFileId into bid.json (snapshot kept) and the library card uses it', async () => {
    const { drive, root } = services()
    const { folderId, bid } = await pricedModel(drive, root)
    drive.addForeignFile(folderId, 'a.jpg', jpeg(1), 'image/jpeg')
    const b = drive.addForeignFile(folderId, 'b.jpg', jpeg(2), 'image/jpeg')
    const model = await loadModelFolder(drive, folderId)
    await setModelCover(drive, root, model, b)
    const after = await bidJson(drive, folderId)
    expect(after.bid.coverFileId).toBe(b)
    expect(after.bid.settingsSnapshot).toEqual(bid.settingsSnapshot)
    expect(after.bid.result).toEqual(bid.result)
    expect((await loadLibrary(drive, root)).find((e) => e.id === folderId)?.coverFileId).toBe(b)
    expect((await rebuildIndex(drive, root)).entries.find((e) => e.id === folderId)?.coverFileId).toBe(b)
  })

  it('needs-slicing: the choice goes to a marked _rubedo-model.json; the library shows it (also after a rebuild); a 2nd choice rewrites the same file', async () => {
    const { drive, root } = services()
    const folder = drive.addForeignFolder(root, 'Vase')
    const a = drive.addForeignFile(folder, 'a.jpg', jpeg(1), 'image/jpeg')
    const b = drive.addForeignFile(folder, 'b.jpg', jpeg(2), 'image/jpeg')
    expect((await loadLibrary(drive, root)).find((e) => e.id === folder)?.coverFileId).toBe(a)

    await setModelCover(drive, root, await loadModelFolder(drive, folder), b)
    const metas = await drive.listChildren(folder, { name: MODEL_META_FILE_NAME })
    expect(metas).toHaveLength(1)
    expect(metas[0].appCreated).toBe(true)
    expect(JSON.parse(await drive.readText(metas[0].id))).toMatchObject({ coverFileId: b })
    expect((await loadLibrary(drive, root)).find((e) => e.id === folder)?.coverFileId).toBe(b)
    expect((await rebuildIndex(drive, root)).entries.find((e) => e.id === folder)?.coverFileId).toBe(b)
    // Still a needs-slicing card; the meta file is not a model file.
    const page = await loadModelFolder(drive, folder)
    expect(page.bid).toBeUndefined()
    expect(page.contents.files).toEqual([])

    const w0 = drive.writeTargets.length
    await setModelCover(drive, root, page, a)
    expect(updateTargets(drive, w0)).toContain(metas[0].id)
    expect(await drive.listChildren(folder, { name: MODEL_META_FILE_NAME })).toHaveLength(1)
    expect((await loadLibrary(drive, root)).find((e) => e.id === folder)?.coverFileId).toBe(a)
  })

  it('"העלה תמונה חדשה כראשית" uploads a marked picture into the folder, then sets it (priced and needs-slicing)', async () => {
    const { drive, root } = services()
    const { folderId } = await pricedModel(drive, root)
    const file = { key: 'c1', name: 'cover.jpg', kind: 'image' as const, mimeType: 'image/jpeg', blob: jpeg(7) }
    const session = newSaveSession()
    const id = await uploadModelCover(drive, root, await loadModelFolder(drive, folderId), file, session)
    const uploaded = (await drive.listChildren(folderId)).find((f) => f.id === id)
    expect(uploaded).toMatchObject({ name: 'cover.jpg', appCreated: true })
    const { bid } = await bidJson(drive, folderId)
    expect(bid.coverFileId).toBe(id)
    expect(bid.files.map((f) => f.id)).toContain(id)

    const folder = drive.addForeignFolder(root, 'Owl')
    const file2 = { key: 'c2', name: 'owl.jpg', kind: 'image' as const, mimeType: 'image/jpeg', blob: jpeg(8) }
    // First attempt fails after the upload; the retry with the same session does not upload twice.
    drive.failNext('uploadFile', (n) => n === MODEL_META_FILE_NAME)
    const s2 = newSaveSession()
    await expect(uploadModelCover(drive, root, await loadModelFolder(drive, folder), file2, s2)).rejects.toBeTruthy()
    const id2 = await uploadModelCover(drive, root, await loadModelFolder(drive, folder), file2, s2)
    expect((await drive.listChildren(folder)).filter((f) => f.name === 'owl.jpg')).toHaveLength(1)
    expect((await loadLibrary(drive, root)).find((e) => e.id === folder)?.coverFileId).toBe(id2)
  })

  it('UI: every picture has "קבע כתמונה ראשית"; choosing one moves the badge and the header cover', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const folder = drive.addForeignFolder(root, 'Vase')
    const a = drive.addForeignFile(folder, 'a.jpg', jpeg(1), 'image/jpeg')
    const b = drive.addForeignFile(folder, 'b.jpg', jpeg(2), 'image/jpeg')
    renderApp(s, `/model/${folder}`)
    await screen.findByRole('heading', { level: 1, name: 'Vase' })
    expect(screen.getByTestId('model-cover').getAttribute('data-file-id')).toBe(a)
    expect(screen.getAllByRole('button', { name: 'קבע כתמונה ראשית' })).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'קבע כתמונה ראשית' }))
    await waitFor(() => expect(screen.getByTestId('model-cover').getAttribute('data-file-id')).toBe(b))
    const pictures = within(screen.getByRole('list', { name: 'תמונות הדגם' })).getAllByRole('listitem')
    expect(within(pictures[1]).getByTestId('cover-badge')).toBeTruthy()
    expect(screen.getByLabelText('העלה תמונה חדשה כראשית')).toBeTruthy()
    // The meta file never shows up as a model file.
    expect(screen.queryByText(MODEL_META_FILE_NAME)).toBeNull()
  })

  it('a pre-v0.4 (unmarked) bid cannot get a cover or description from the page — nothing is written', async () => {
    const { drive, root } = services()
    const { bid } = await pricedModel(drive, root, 'Tmp')
    const folder = drive.addForeignFolder(root, 'Old')
    const p = drive.addForeignFile(folder, 'p.jpg', jpeg(), 'image/jpeg')
    drive.addLegacyAppFile(folder, BID_FILE_NAME, new Blob([JSON.stringify({ ...bid, name: 'Old' })]), 'application/json')
    const model = await loadModelFolder(drive, folder)
    const w0 = drive.writeLog.length
    await expect(setModelCover(drive, root, model, p)).rejects.toMatchObject({ status: 403 })
    await expect(setModelDescription(drive, root, model, 'x')).rejects.toMatchObject({ status: 403 })
    expect(drive.writeLog.length).toBe(w0)
  })
})

// ---------------------------------------------------------------------------------------------
describe('E3 / AC35 — inline description edit', () => {
  it('priced → bid.json (result + snapshot kept); needs-slicing → _rubedo-model.json; > 2000 characters refused, nothing written', async () => {
    const { drive, root } = services()
    const { folderId, bid } = await pricedModel(drive, root)
    await setModelDescription(drive, root, await loadModelFolder(drive, folderId), '  חדש  ')
    const after = (await bidJson(drive, folderId)).bid
    expect(after.description).toBe('חדש')
    expect(after.result).toEqual(bid.result)
    expect(after.settingsSnapshot).toEqual(bid.settingsSnapshot)

    const folder = drive.addForeignFolder(root, 'Vase')
    await setModelDescription(drive, root, await loadModelFolder(drive, folder), 'אגרטל')
    expect((await loadModelFolder(drive, folder)).meta?.description).toBe('אגרטל')

    const w0 = drive.writeLog.length
    const long = 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1)
    await expect(setModelDescription(drive, root, await loadModelFolder(drive, folder), long)).rejects.toMatchObject({
      userMessage: DESCRIPTION_TOO_LONG_MESSAGE,
    })
    await expect(setModelDescription(drive, root, await loadModelFolder(drive, folderId), long)).rejects.toMatchObject({
      userMessage: DESCRIPTION_TOO_LONG_MESSAGE,
    })
    expect(drive.writeLog.length).toBe(w0)
    await setModelDescription(drive, root, await loadModelFolder(drive, folder), 'x'.repeat(DESCRIPTION_MAX_LENGTH))
  })

  it('UI: pencil → textarea with a live counter → save; over the limit the save button is disabled', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const folder = drive.addForeignFolder(root, 'Vase')
    renderApp(s, `/model/${folder}`)
    await user.click(await screen.findByRole('button', { name: 'עריכת תיאור' }))
    const box = screen.getByLabelText('תיאור הדגם') as HTMLTextAreaElement
    await user.type(box, 'אגרטל')
    expect(screen.getByTestId('description-counter').textContent).toContain(`5/${DESCRIPTION_MAX_LENGTH}`)
    fireEvent.change(box, { target: { value: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1) } })
    expect((screen.getByRole('button', { name: 'שמירת תיאור' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe(DESCRIPTION_TOO_LONG_MESSAGE)
    fireEvent.change(box, { target: { value: 'אגרטל כחול' } })
    await user.click(screen.getByRole('button', { name: 'שמירת תיאור' }))
    expect((await screen.findByTestId('model-description')).textContent).toBe('אגרטל כחול')
    expect((await loadModelFolder(drive, folder)).meta?.description).toBe('אגרטל כחול')
  })

  it('creating a bid from a needs-slicing folder is prefilled with its saved cover + description', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const folder = drive.addForeignFolder(root, 'Vase')
    drive.addForeignFile(folder, 'a.jpg', jpeg(1), 'image/jpeg')
    const b = drive.addForeignFile(folder, 'b.jpg', jpeg(2), 'image/jpeg')
    await setModelCover(drive, root, await loadModelFolder(drive, folder), b)
    await setModelDescription(drive, root, await loadModelFolder(drive, folder), 'אגרטל')
    renderApp(s, `/model/${folder}/create`)
    expect(((await screen.findByLabelText('תיאור')) as HTMLTextAreaElement).value).toBe('אגרטל')
    await user.click(screen.getByRole('button', { name: /הוספת חלק ידנית/ }))
    fireEvent.change(screen.getByLabelText('משקל'), { target: { value: '10' } })
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    await screen.findByRole('heading', { level: 1, name: 'Vase' })
    const { bid } = await bidJson(drive, folder)
    expect(bid.description).toBe('אגרטל')
    expect(bid.coverFileId).toBe(b)
  })
})

// ---------------------------------------------------------------------------------------------
describe('folder scans ignore the app files', () => {
  it('_rubedo-model.json is not a model file/picture; "_…" folders are still skipped', async () => {
    const { drive, root } = services()
    const folder = drive.addForeignFolder(root, 'Vase')
    await setModelDescription(drive, root, await loadModelFolder(drive, folder), 'x')
    drive.addForeignFolder(root, '_archive')
    const c = classifyFolder(await drive.listChildren(folder))
    expect(c.files).toEqual([])
    expect(c.images).toEqual([])
    expect(c.metaFile?.name).toBe(MODEL_META_FILE_NAME)
    const { entries } = await rebuildIndex(drive, root)
    expect(entries.map((e) => e.name)).toEqual(['Vase'])
  })

  it('a damaged _rubedo-model.json: the page says so in Hebrew, the library falls back to the default cover', async () => {
    const { s, drive, root } = services()
    const folder = drive.addForeignFolder(root, 'Vase')
    const a = drive.addForeignFile(folder, 'a.jpg', jpeg(1), 'image/jpeg')
    await drive.uploadFile(folder, MODEL_META_FILE_NAME, new Blob(['{oops']), 'application/json')
    expect((await rebuildIndex(drive, root)).entries[0].coverFileId).toBe(a)
    renderApp(s, `/model/${folder}`)
    expect(await screen.findByText(/_rubedo-model\.json פגום/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------
describe('E4 / AC36 — customers list', () => {
  it('add / edit / hide; e-mail unique (case-insensitive); the file is a marked bare array; nothing is ever removed', async () => {
    const { drive, root } = services()
    const dana = (await addCustomer(drive, root, { name: 'דנה', email: 'Dana@Example.com', phone: '050-1234567' })).customer
    await addCustomer(drive, root, { name: 'יוסי', email: 'yossi@example.com' })
    const w0 = drive.writeLog.length
    await expect(addCustomer(drive, root, { name: 'אחרת', email: 'dana@example.COM' })).rejects.toMatchObject({ userMessage: 'כבר קיים לקוח עם כתובת המייל הזו.' })
    await expect(addCustomer(drive, root, { name: '', email: 'bad' })).rejects.toBeTruthy()
    expect(drive.writeLog.length).toBe(w0)

    const file = (await drive.listChildren(root, { name: CUSTOMERS_FILE_NAME }))
    expect(file).toHaveLength(1)
    expect(file[0].appCreated).toBe(true)
    const raw = JSON.parse(await drive.readText(file[0].id))
    expect(Array.isArray(raw)).toBe(true)
    expect(raw[0]).toMatchObject({ id: dana.id, name: 'דנה', email: 'Dana@Example.com', phone: '050-1234567' })
    expect(typeof raw[0].createdAt).toBe('string')

    await expect(updateCustomer(drive, root, dana.id, { name: 'דנה', email: 'YOSSI@example.com' })).rejects.toBeTruthy()
    await updateCustomer(drive, root, dana.id, { name: 'דנה כהן', email: 'dana@example.com', notes: 'VIP' })
    await setCustomerHidden(drive, root, dana.id, true)
    let list = await loadCustomers(drive, root)
    expect(list).toHaveLength(2)
    expect(list.find((c) => c.id === dana.id)).toMatchObject({ name: 'דנה כהן', notes: 'VIP', hidden: true, createdAt: dana.createdAt })
    expect(pickerCustomers(list, '').map((c) => c.name)).toEqual(['יוסי'])
    await setCustomerHidden(drive, root, dana.id, false)
    list = await loadCustomers(drive, root)
    expect(pickerCustomers(list, 'DANA').map((c) => c.name)).toEqual(['דנה כהן'])
    expect(pickerCustomers(list, 'יוס').map((c) => c.name)).toEqual(['יוסי'])
    // Only creates and marked updates of that one file.
    expect(new Set(updateTargets(drive))).toEqual(new Set([file[0].id]))
  })

  it('a damaged customers file is an error and is never overwritten', async () => {
    const { drive, root } = services()
    const f = await drive.uploadFile(root, CUSTOMERS_FILE_NAME, new Blob(['not json']), 'application/json')
    await expect(loadCustomers(drive, root)).rejects.toBeTruthy()
    await expect(addCustomer(drive, root, { name: 'דנה', email: 'd@e.co' })).rejects.toBeTruthy()
    await expect(ensureQuoteCustomer(drive, root, { name: 'דנה', email: 'd@e.co' })).rejects.toBeTruthy()
    expect(await drive.readText(f.id)).toBe('not json')
  })

  it('UI: "לקוחות" in the header; add, search, hide (shown under the toggle), edit on the customer page', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    await addCustomer(drive, root, { name: 'יוסי', email: 'yossi@example.com' })
    renderApp(s, '/')
    await user.click(within(screen.getByRole('navigation')).getByRole('link', { name: 'לקוחות' }))
    await screen.findByRole('heading', { level: 1, name: 'לקוחות' })
    await screen.findByText('יוסי')

    await user.click(screen.getByRole('button', { name: '+ לקוח חדש' }))
    const form = within(screen.getByRole('form', { name: 'הוספת לקוח' }))
    await user.type(form.getByLabelText(/^שם/), 'דנה')
    await user.type(form.getByLabelText(/^מייל/), 'YOSSI@example.com')
    await user.click(form.getByRole('button', { name: 'הוספת לקוח' }))
    expect(await form.findByText('כבר קיים לקוח עם כתובת המייל הזו.')).toBeTruthy()
    await user.clear(form.getByLabelText(/^מייל/))
    await user.type(form.getByLabelText(/^מייל/), 'dana@example.com')
    expect(form.getByLabelText(/^מייל/).getAttribute('dir')).toBe('ltr')
    await user.click(form.getByRole('button', { name: 'הוספת לקוח' }))
    await waitFor(() => expect(screen.getAllByTestId('customer-row')).toHaveLength(2))

    await user.type(screen.getByLabelText('חיפוש לפי שם או מייל'), 'dana')
    expect(screen.getAllByTestId('customer-row')).toHaveLength(1)
    await user.click(screen.getByRole('link', { name: 'דנה' }))
    await screen.findByRole('heading', { level: 1, name: 'דנה' })
    await user.click(screen.getByRole('button', { name: 'עריכת פרטי לקוח' }))
    const edit = within(screen.getByRole('form', { name: 'שמירת פרטי לקוח' }))
    await user.type(edit.getByLabelText(/^טלפון/), '0501234567')
    await user.click(edit.getByRole('button', { name: 'שמירת פרטי לקוח' }))
    await screen.findByText('0501234567')
    await user.click(screen.getByRole('button', { name: 'הסתר' }))
    await screen.findByRole('button', { name: 'הצג שוב' })

    await user.click(screen.getByRole('link', { name: 'לכל הלקוחות' }))
    await screen.findByText('יוסי')
    expect(screen.queryByText('דנה')).toBeNull()
    await user.click(screen.getByRole('checkbox', { name: /הצגת לקוחות מוסתרים/ }))
    expect(screen.getByText('דנה')).toBeTruthy()
    expect(screen.getByText('מוסתר')).toBeTruthy()
    expect((await loadCustomers(drive, root)).find((c) => c.name === 'דנה')).toMatchObject({ hidden: true, phone: '0501234567' })
  })
})

// ---------------------------------------------------------------------------------------------
describe('E4 / AC37 — quote screen customer picker + auto-add after the draft', () => {
  async function quoteSetup() {
    const x = services()
    const { folderId } = await pricedModel(x.drive, x.root)
    return { ...x, folderId }
  }
  const nameField = () => screen.getByLabelText(/^שם הלקוח/) as HTMLInputElement
  const emailField = () => screen.getByLabelText(/^מייל הלקוח/) as HTMLInputElement
  const createDraft = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
  async function quoteLog(drive: MemoryDrive, folderId: string): Promise<QuoteRecord> {
    const q = (await drive.listChildren(folderId, { name: 'quotes' }))[0]
    const logs = await drive.listChildren(q.id)
    return JSON.parse(await drive.readText(logs[logs.length - 1].id))
  }

  it('combobox: type-ahead, ↓ / Enter fills name + e-mail; hidden customers are not offered; e-mail shown LTR', async () => {
    const user = userEvent.setup()
    const { s, drive, root, folderId } = await quoteSetup()
    const dana = (await addCustomer(drive, root, { name: 'דנה כהן', email: 'dana@example.com' })).customer
    const hidden = (await addCustomer(drive, root, { name: 'דנה נסתרת', email: 'hidden@example.com' })).customer
    await setCustomerHidden(drive, root, hidden.id, true)
    renderApp(s, `/model/${folderId}/quote`)
    const combo = (await screen.findByRole('combobox', { name: 'בחירת לקוח קיים' })) as HTMLInputElement
    expect(combo.getAttribute('aria-autocomplete')).toBe('list')
    await user.type(combo, 'דנה')
    expect(combo.getAttribute('aria-expanded')).toBe('true')
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(within(options[0]).getByText('dana@example.com').getAttribute('dir')).toBe('ltr')
    await user.keyboard('{ArrowDown}')
    expect(combo.getAttribute('aria-activedescendant')).toBe(options[0].id)
    expect(options[0].getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{Enter}')
    expect(nameField().value).toBe('דנה כהן')
    expect(emailField().value).toBe('dana@example.com')
    expect(combo.getAttribute('aria-expanded')).toBe('false')

    // Known customer: the log carries its id; the customers file is not rewritten.
    const w0 = drive.writeLog.length
    await createDraft(user)
    await screen.findByTestId('draft-success')
    expect((await quoteLog(drive, folderId)).customerId).toBe(dana.id)
    expect(drive.writeLog.slice(w0).filter((w) => w.includes(CUSTOMERS_FILE_NAME))).toEqual([])
  })

  it('a new name + e-mail is added ONLY after the draft succeeded (same id as in the log); a failed draft saves nothing', async () => {
    const user = userEvent.setup()
    const { s, drive, root, folderId } = await quoteSetup()
    renderApp(s, `/model/${folderId}/quote`)
    await screen.findByRole('combobox', { name: 'בחירת לקוח קיים' })
    fireEvent.change(nameField(), { target: { value: 'רון' } })
    fireEvent.change(emailField(), { target: { value: 'ron@example.com' } })

    s.mail.failNext('network')
    await createDraft(user)
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
    expect(await drive.listChildren(root, { name: CUSTOMERS_FILE_NAME })).toEqual([])

    await createDraft(user)
    await screen.findByTestId('draft-success')
    const list = await loadCustomers(drive, root)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'רון', email: 'ron@example.com' })
    expect((await quoteLog(drive, folderId)).customerId).toBe(list[0].id)
    expect(screen.getByTestId('customer-notice').textContent).toContain('נוסף/ה לרשימת הלקוחות')
    const file = (await drive.listChildren(root, { name: CUSTOMERS_FILE_NAME }))[0]
    expect(file.appCreated).toBe(true)
  })

  it('existing e-mail typed with a different name → stored name kept, small notice, no write', async () => {
    const user = userEvent.setup()
    const { s, drive, root, folderId } = await quoteSetup()
    const dana = (await addCustomer(drive, root, { name: 'דנה כהן', email: 'dana@example.com' })).customer
    renderApp(s, `/model/${folderId}/quote`)
    await screen.findByRole('combobox', { name: 'בחירת לקוח קיים' })
    fireEvent.change(nameField(), { target: { value: 'דני' } })
    fireEvent.change(emailField(), { target: { value: 'DANA@example.com' } })
    const w0 = drive.writeLog.length
    await createDraft(user)
    await screen.findByTestId('draft-success')
    expect(screen.getByTestId('customer-notice').textContent).toContain('„דנה כהן”')
    expect((await loadCustomers(drive, root)).map((c) => c.name)).toEqual(['דנה כהן'])
    expect(drive.writeLog.slice(w0).filter((w) => w.includes(CUSTOMERS_FILE_NAME))).toEqual([])
    expect((await quoteLog(drive, folderId)).customerId).toBe(dana.id)
  })

  it('customer save fails → the draft still succeeded; a non-blocking Hebrew notice with a retry', async () => {
    const user = userEvent.setup()
    const { s, drive, root, folderId } = await quoteSetup()
    renderApp(s, `/model/${folderId}/quote`)
    await screen.findByRole('combobox', { name: 'בחירת לקוח קיים' })
    fireEvent.change(nameField(), { target: { value: 'רון' } })
    fireEvent.change(emailField(), { target: { value: 'ron@example.com' } })
    drive.failNext('uploadFile', (n) => n === CUSTOMERS_FILE_NAME)
    await createDraft(user)
    await screen.findByTestId('draft-success')
    const notice = screen.getByTestId('customer-notice')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toMatch(/שמירת הלקוח ברשימת הלקוחות נכשלה/)
    expect(s.mail.drafts).toHaveLength(1)
    await user.click(within(notice).getByRole('button', { name: 'שמירת הלקוח שוב' }))
    await waitFor(() => expect(screen.queryByTestId('customer-notice')?.textContent ?? '').toContain('נוסף/ה'))
    expect((await loadCustomers(drive, root)).map((c) => c.email)).toEqual(['ron@example.com'])
    expect(s.mail.drafts).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------
describe('E4 / AC38 — customer history from every model + "new quote"', () => {
  function record(over: Partial<QuoteRecord> & { date: string; email: string; name: string; price: number }): QuoteRecord {
    const r: QuoteRecord = {
      schemaVersion: 1,
      date: over.date,
      draftId: 'd',
      model: { bidId: 'b', name: over.model?.name ?? 'M', revision: 'V1' },
      customer: { name: over.name, email: over.email },
      includedHardware: [],
      priceShown: over.price,
      landed: 1,
      price70: 3,
      savedBid: { landed: 1, price70: 3 },
      attachments: [],
    }
    if (over.customerId) r.customerId = over.customerId
    return r
  }

  async function history() {
    const x = services()
    const { drive, root } = x
    const a = await pricedModel(drive, root, 'Alpha')
    const b = await pricedModel(drive, root, 'Beta')
    const dana = (await addCustomer(drive, root, { name: 'דנה', email: 'dana@example.com' })).customer
    const other = (await addCustomer(drive, root, { name: 'יוסי', email: 'yossi@example.com' })).customer
    // Old (v0.5) log: no customerId, e-mail in another case → matched by e-mail.
    await writeQuoteLog(drive, a.folderId, record({ date: '2026-09-20T10:00:00.000Z', name: 'Dana', email: 'DANA@example.com', price: 80, model: { name: 'Alpha' } as QuoteRecord['model'] }), new Date('2026-09-20T10:00:00Z'))
    await writeQuoteLog(drive, b.folderId, record({ date: '2026-10-01T10:00:00.000Z', name: 'דנה', email: 'dana@example.com', price: 120, customerId: dana.id, model: { name: 'Beta' } as QuoteRecord['model'] }), new Date('2026-10-01T10:00:00Z'))
    await writeQuoteLog(drive, b.folderId, record({ date: '2026-09-25T10:00:00.000Z', name: 'יוסי', email: 'yossi@example.com', price: 99, customerId: other.id, model: { name: 'Beta' } as QuoteRecord['model'] }), new Date('2026-09-25T10:00:00Z'))
    // Written behind the app's back: tell the cache, as the quote screen does after writing a log.
    markQuotesChanged(drive)
    return { ...x, a, b, dana, other }
  }

  it('lib: rebuild collects every quote log (index v3 with a customer summary); matching by id, else by e-mail', async () => {
    const { drive, root, dana, other } = await history()
    const r = await rebuildIndex(drive, root)
    expect(r.quotes.map((q) => q.priceShown)).toEqual([120, 99, 80])
    const customers = await loadCustomers(drive, root)
    expect(quotesForCustomer(r.quotes, dana, customers).map((q) => [q.modelName, q.priceShown])).toEqual([
      ['Beta', 120],
      ['Alpha', 80],
    ])
    expect(quotesForCustomer(r.quotes, other, customers).map((q) => q.priceShown)).toEqual([99])
    const idx = JSON.parse(await drive.readText(await indexId(drive, root)))
    expect(idx.schemaVersion).toBe(3)
    expect(idx.customers).toEqual(summariseQuotes(r.quotes))
    expect(idx.customers).toContainEqual({ email: 'dana@example.com', quoteCount: 1, lastQuoteAt: '2026-09-20T10:00:00.000Z' })
    expect(idx.customers).toContainEqual({ customerId: dana.id, email: 'dana@example.com', quoteCount: 1, lastQuoteAt: '2026-10-01T10:00:00.000Z' })
  })

  it(`quote logs are read at most ${FOLDER_SCAN_CONCURRENCY} at a time`, async () => {
    const { drive, root } = services()
    const { folderId } = await pricedModel(drive, root)
    for (let i = 0; i < 12; i++) {
      await writeQuoteLog(drive, folderId, record({ date: `2026-09-${String(i + 10)}T10:00:00.000Z`, name: 'n', email: 'n@e.co', price: i + 1 }), new Date(2026, 8, i + 10))
    }
    const inner = drive.readText.bind(drive)
    let running = 0
    let max = 0
    vi.spyOn(drive, 'readText').mockImplementation(async (id) => {
      running += 1
      max = Math.max(max, running)
      await new Promise((r) => setTimeout(r, 2))
      running -= 1
      return inner(id)
    })
    const r = await rebuildIndex(drive, root)
    expect(r.quotes).toHaveLength(12)
    expect(max).toBeLessThanOrEqual(FOLDER_SCAN_CONCURRENCY)
    expect(max).toBeGreaterThan(1)
  })

  it('a fresh index is reused; after a quote is written in this session the history is rebuilt once', async () => {
    const { drive, root } = await history()
    await rebuildIndex(drive, root)
    const spy = vi.spyOn(drive, 'listChildren')
    await loadQuoteHistory(drive, root)
    const reads = spy.mock.calls.length
    expect(reads).toBeLessThanOrEqual(1) // only the index lookup
    markQuotesChanged(drive)
    await loadQuoteHistory(drive, root)
    expect(spy.mock.calls.length).toBeGreaterThan(reads + 1) // rebuilt
  })

  it('UI: customer page lists quotes from all models newest first; the list shows count + last date; "שליחת הצעה חדשה" opens the prefilled quote screen', async () => {
    const user = userEvent.setup()
    const { s, b, dana } = await history()
    renderApp(s, '/customers')
    await waitFor(() => expect(screen.getAllByTestId('customer-quote-count').map((x) => x.textContent)).toEqual(['2', '1']))

    await user.click(screen.getByRole('link', { name: 'דנה' }))
    await screen.findByRole('heading', { level: 1, name: 'דנה' })
    const rows = await screen.findAllByTestId('customer-quote')
    expect(rows.map((r) => within(r).getByRole('link').textContent)).toEqual(['Beta', 'Alpha'])
    expect(rows[0].textContent).toContain('₪120')
    expect(within(rows[0]).getByRole('link').getAttribute('href')).toBe(`/model/${b.folderId}`)

    await user.click(screen.getByRole('button', { name: 'שליחת הצעה חדשה' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'בחירת דגם להצעה' }))
    await user.type(dialog.getByLabelText('חיפוש דגם לפי שם'), 'bet')
    expect(dialog.queryByText('Alpha')).toBeNull()
    await user.click(dialog.getByRole('button', { name: /Beta/ }))
    await screen.findByRole('heading', { level: 1, name: /שליחת הצעת מחיר — Beta/ })
    await waitFor(() => expect((screen.getByLabelText(/^שם הלקוח/) as HTMLInputElement).value).toBe('דנה'))
    expect((screen.getByLabelText(/^מייל הלקוח/) as HTMLInputElement).value).toBe('dana@example.com')
    expect(dana.id).toBeTruthy()
  })

  it('a quote sent from the screen shows up on the customer page right away (history rebuilt after the quote)', async () => {
    const user = userEvent.setup()
    const { s, drive, root, a } = await history()
    await rebuildIndex(drive, root)
    renderApp(s, `/model/${a.folderId}/quote`)
    await screen.findByRole('combobox', { name: 'בחירת לקוח קיים' })
    fireEvent.change(screen.getByLabelText(/^שם הלקוח/), { target: { value: 'רון' } })
    fireEvent.change(screen.getByLabelText(/^מייל הלקוח/), { target: { value: 'ron@example.com' } })
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
    await screen.findByTestId('draft-success')
    await user.click(within(screen.getByRole('navigation')).getByRole('link', { name: 'לקוחות' }))
    await user.click(await screen.findByRole('link', { name: 'רון' }))
    const rows = await screen.findAllByTestId('customer-quote')
    expect(rows.map((r) => within(r).getByRole('link').textContent)).toEqual(['Alpha'])
  })
})
