import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../src/App'
import { BID_FILE_NAME, INDEX_FILE_NAME, MODEL_META_FILE_NAME, bidPricingInput, type Bid } from '../../src/lib/bid'
import { addCustomer } from '../../src/lib/drive/customerStore'
import {
  ARCHIVE_CONFIRM_MESSAGE,
  loadLibrary,
  loadModelFolder,
  markQuotesChanged,
  newSaveSession,
  rebuildIndex,
  saveNewBid,
  setModelArchived,
  setModelCover,
  updateBid,
  bidContentOf,
  type BidContent,
} from '../../src/lib/drive/bidRepository'
import { MemoryDrive } from '../../src/lib/drive/memoryDrive'
import { parseModelMeta } from '../../src/lib/drive/modelMeta'
import { writeQuoteLog } from '../../src/lib/drive/quoteLog'
import { computePrice, DEFAULT_PRICING_SETTINGS } from '../../src/lib/pricing'
import type { QuoteRecord } from '../../src/lib/quote'
import { createMemoryServices, type AppServices } from '../../src/state/services'

/** Brief addendum v0.7 — "remove from library" = archive (A1–A5, AC39–AC41). */

const S = DEFAULT_PRICING_SETTINGS
const jpeg = (n = 1) => new Blob([new Uint8Array([0xff, 0xd8, n])], { type: 'image/jpeg' })

function LocationProbe() {
  const l = useLocation()
  return <div data-testid="location">{l.pathname + l.search}</div>
}

function renderApp(services: AppServices, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App services={services} />
      <LocationProbe />
    </MemoryRouter>,
  )
}

function content(name: string): BidContent {
  const base: BidContent = {
    name,
    revision: 'V1',
    description: 'תיאור',
    material: { name: 'PLA', pricePerKg: 85 },
    parts: [{ name: 'Base', qty: 1, grams: 100, hours: 3.5, source: 'manual' }],
    laborMinutes: 10,
    hardware: [],
    hasShipping: false,
    packaging: [],
    shippingCost: 0,
    settingsSnapshot: { ...S },
    result: computePrice({ pricePerKg: 85, parts: [], laborMinutes: 0, hardware: [], hasShipping: false, packaging: [], shippingCost: 0 }, S),
  }
  const pseudo = { ...base, files: [], schemaVersion: 2, id: '', createdAt: '', updatedAt: '' } as unknown as Bid
  return { ...base, result: computePrice(bidPricingInput(pseudo), S) }
}

function services() {
  const drive = new MemoryDrive()
  const s = createMemoryServices(drive)
  return { s, drive, root: s.folderPointer.get() as string }
}

async function priced(drive: MemoryDrive, root: string, name: string) {
  return saveNewBid(drive, root, { folderName: name, content: content(name), files: [] }, newSaveSession())
}

async function readBid(drive: MemoryDrive, folderId: string): Promise<{ bid: Bid; fileId: string; marked: boolean; count: number }> {
  const files = await drive.listChildren(folderId, { name: BID_FILE_NAME })
  const f = files.find((x) => x.appCreated) ?? files[0]
  return { bid: JSON.parse(await drive.readText(f.id)), fileId: f.id, marked: f.appCreated === true, count: files.length }
}

async function readMeta(drive: MemoryDrive, folderId: string) {
  const files = await drive.listChildren(folderId, { name: MODEL_META_FILE_NAME })
  return { files, json: files[0] ? JSON.parse(await drive.readText(files[0].id)) : null }
}

const T1 = new Date('2026-10-03T09:00:00Z')
const T2 = new Date('2026-10-03T10:00:00Z')

// ---------------------------------------------------------------------------------------------
describe('A1 / AC39 / AC40 — archive and restore (library code)', () => {
  it('priced: only bid.json (same file, marker kept) and the index change; restore gives identical data apart from archived/archivedAt/updatedAt', async () => {
    const { drive, root } = services()
    const { folderId } = await priced(drive, root, 'Vase')
    await rebuildIndex(drive, root)
    const before = await readBid(drive, folderId)
    const log0 = drive.writeLog.length

    await setModelArchived(drive, root, folderId, true, T1)
    expect(drive.writeLog.slice(log0)).toEqual(['update:bid.json', 'update:_rubedo-index.json'])
    const archived = await readBid(drive, folderId)
    expect(archived).toMatchObject({ fileId: before.fileId, marked: true, count: 1 })
    expect(archived.bid).toMatchObject({ archived: true, archivedAt: T1.toISOString(), updatedAt: T1.toISOString() })
    expect((await loadLibrary(drive, root)).find((e) => e.id === folderId)?.archived).toBe(true)
    expect((await readMeta(drive, folderId)).files).toHaveLength(0)

    await setModelArchived(drive, root, folderId, false, T2)
    const restored = await readBid(drive, folderId)
    const strip = ({ archived: _a, archivedAt: _b, updatedAt: _c, ...rest }: Bid) => rest
    expect(strip(restored.bid)).toEqual(strip(before.bid))
    expect(restored.bid.archived).toBe(false)
    expect(restored.bid.archivedAt).toBeUndefined()
    expect((await loadLibrary(drive, root)).find((e) => e.id === folderId)?.archived).toBe(false)
  })

  it('an edit of an archived bid keeps it archived (the flag is not part of the form)', async () => {
    const { drive, root } = services()
    const { folderId } = await priced(drive, root, 'Vase')
    await setModelArchived(drive, root, folderId, true, T1)
    const { bid } = await readBid(drive, folderId)
    await updateBid(drive, root, { folderId, existing: bid, content: { ...bidContentOf(bid), laborMinutes: 20 }, newFiles: [] }, newSaveSession())
    expect((await readBid(drive, folderId)).bid).toMatchObject({ archived: true, archivedAt: T1.toISOString(), laborMinutes: 20 })
  })

  it('needs-slicing: only _rubedo-model.json (created marked, then updated) and the index change; cover/description kept', async () => {
    const { drive, root } = services()
    const folder = drive.addForeignFolder(root, 'Old vase')
    const a = drive.addForeignFile(folder, 'a.jpg', jpeg(1), 'image/jpeg')
    const b = drive.addForeignFile(folder, 'b.jpg', jpeg(2), 'image/jpeg')
    await setModelCover(drive, root, await loadModelFolder(drive, folder), b)
    const log0 = drive.writeLog.length

    await setModelArchived(drive, root, folder, true, T1)
    expect(drive.writeLog.slice(log0)).toEqual(['update:_rubedo-model.json', 'update:_rubedo-index.json'])
    const meta = await readMeta(drive, folder)
    expect(meta.files).toHaveLength(1)
    expect(meta.files[0].appCreated).toBe(true)
    expect(meta.json).toMatchObject({ coverFileId: b, archived: true, archivedAt: T1.toISOString() })
    const entry = (await loadLibrary(drive, root)).find((e) => e.id === folder)
    expect(entry).toMatchObject({ status: 'needs-slicing', archived: true, coverFileId: b })

    // A cover change on an archived folder keeps the card archived.
    await setModelCover(drive, root, await loadModelFolder(drive, folder), a)
    expect((await loadLibrary(drive, root)).find((e) => e.id === folder)).toMatchObject({ archived: true, coverFileId: a })

    await setModelArchived(drive, root, folder, false, T2)
    const after = await readMeta(drive, folder)
    expect(after.json).toMatchObject({ coverFileId: a, archived: false })
    expect(after.json.archivedAt).toBeUndefined()
    expect((await loadLibrary(drive, root)).find((e) => e.id === folder)?.archived).toBe(false)
  })

  it('needs-slicing without a meta file: archiving creates it (marked); a rebuild keeps the flag', async () => {
    const { drive, root } = services()
    const folder = drive.addForeignFolder(root, 'Bare')
    const log0 = drive.writeLog.length
    await setModelArchived(drive, root, folder, true, T1)
    expect(drive.writeLog.slice(log0).filter((w) => !w.endsWith('_rubedo-index.json'))).toEqual(['upload:_rubedo-model.json'])
    const r = await rebuildIndex(drive, root)
    expect(r.entries.find((e) => e.id === folder)).toMatchObject({ status: 'needs-slicing', archived: true })
  })

  it('pre-v0.4 bid: the old bid.json is never touched; the flag goes to _rubedo-model.json; rebuild + model page see it', async () => {
    const { drive, root } = services()
    const { bid } = await priced(drive, root, 'Template')
    const folder = drive.addForeignFolder(root, 'Old lamp')
    const legacyId = drive.addLegacyAppFile(folder, BID_FILE_NAME, new Blob([JSON.stringify({ ...bid, name: 'Old lamp' })]), 'application/json')
    const oldText = await drive.readText(legacyId)
    const log0 = drive.writeLog.length

    await setModelArchived(drive, root, folder, true, T1)
    const writes = drive.writeLog.slice(log0)
    expect(writes.filter((w) => !w.endsWith('_rubedo-index.json'))).toEqual(['upload:_rubedo-model.json'])
    expect(drive.writeTargets.some((w) => w.targetId === legacyId)).toBe(false)
    expect(await drive.readText(legacyId)).toBe(oldText)
    expect((await readBid(drive, folder)).count).toBe(1)

    expect((await loadLibrary(drive, root)).find((e) => e.id === folder)).toMatchObject({ status: 'priced', name: 'Old lamp', archived: true })
    expect((await rebuildIndex(drive, root)).entries.find((e) => e.id === folder)?.archived).toBe(true)
    const model = await loadModelFolder(drive, folder)
    expect(model.legacyBid).toBe(true)
    expect(model.meta?.archived).toBe(true)

    await setModelArchived(drive, root, folder, false, T2)
    expect(await drive.readText(legacyId)).toBe(oldText)
    expect((await rebuildIndex(drive, root)).entries.find((e) => e.id === folder)?.archived).toBe(false)
  })

  it('refuses a damaged _rubedo-model.json (never replaced) and a folder that is not a model folder; nothing is written', async () => {
    const { drive, root } = services()
    const folder = drive.addForeignFolder(root, 'Broken')
    await drive.uploadFile(folder, MODEL_META_FILE_NAME, new Blob(['{not json']), 'application/json')
    const other = drive.addForeignFolder(folder, 'nested')
    const log0 = drive.writeLog.length
    await expect(setModelArchived(drive, root, folder, true)).rejects.toMatchObject({ name: 'InvalidModelMetaError' })
    await expect(setModelArchived(drive, root, other, true)).rejects.toMatchObject({ status: 400 })
    expect(drive.writeLog.length).toBe(log0)
  })

  it('a meta file whose archived flag has the wrong type is invalid as a whole', () => {
    expect(parseModelMeta({ archived: 'yes', updatedAt: '' })).toBeNull()
    expect(parseModelMeta({ archived: true, archivedAt: 5, updatedAt: '' })).toBeNull()
    expect(parseModelMeta({ archived: true, archivedAt: 'x', updatedAt: '' })).toMatchObject({ archived: true, archivedAt: 'x' })
  })

  it('A4: the index stores archived for every entry (schemaVersion 4)', async () => {
    const { drive, root } = services()
    await priced(drive, root, 'A')
    drive.addForeignFolder(root, 'B')
    await rebuildIndex(drive, root)
    const idx = (await drive.listChildren(root, { name: INDEX_FILE_NAME }))[0]
    const file = JSON.parse(await drive.readText(idx.id))
    expect(file.schemaVersion).toBe(4)
    expect(file.entries.map((e: { archived: unknown }) => e.archived)).toEqual([false, false])
  })
})

// ---------------------------------------------------------------------------------------------
describe('A1 / A3 — model page', () => {
  it('"הסר מהספרייה" opens an accessible confirm modal (focus on cancel, Tab trapped, Escape cancels), never window.confirm', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const { folderId } = await priced(drive, root, 'Vase')
    const confirmSpy = vi.spyOn(window, 'confirm')
    renderApp(s, `/model/${folderId}`)
    const trigger = await screen.findByRole('button', { name: 'הסר מהספרייה' })
    const log0 = drive.writeLog.length

    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'הסר מהספרייה?' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const descId = dialog.getAttribute('aria-describedby') ?? ''
    expect(document.getElementById(descId)?.textContent).toBe(ARCHIVE_CONFIRM_MESSAGE)
    const cancel = within(dialog).getByRole('button', { name: 'ביטול' })
    const confirm = within(dialog).getByRole('button', { name: 'הסר מהספרייה' })
    expect(document.activeElement).toBe(cancel)
    // Cancel is the last focusable element: Tab wraps to the first (confirm), Shift+Tab from the first wraps back.
    await user.tab()
    expect(document.activeElement).toBe(confirm)
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(cancel)
    await user.tab()
    expect(document.activeElement).toBe(confirm)
    await user.tab()
    expect(document.activeElement).toBe(cancel)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
    expect(drive.writeLog.length).toBe(log0)

    await user.click(trigger)
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'ביטול' }))
    expect(drive.writeLog.length).toBe(log0)
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('confirming archives the priced model → banner "המודל בארכיון" + restore; restore removes the banner', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const { folderId } = await priced(drive, root, 'Vase')
    renderApp(s, `/model/${folderId}`)
    await user.click(await screen.findByRole('button', { name: 'הסר מהספרייה' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'הסר מהספרייה' }))
    const banner = await screen.findByTestId('archived-banner')
    expect(banner.textContent).toContain('המודל בארכיון')
    expect(screen.queryByRole('button', { name: 'הסר מהספרייה' })).toBeNull()
    expect((await readBid(drive, folderId)).bid.archived).toBe(true)

    await user.click(within(banner).getByRole('button', { name: 'שחזר לספרייה' }))
    await waitFor(() => expect(screen.queryByTestId('archived-banner')).toBeNull())
    expect(await screen.findByRole('button', { name: 'הסר מהספרייה' })).toBeTruthy()
    expect((await readBid(drive, folderId)).bid.archived).toBe(false)
  })

  it('needs-slicing model page: archive writes _rubedo-model.json; opening it directly shows the banner', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const folder = drive.addForeignFolder(root, 'Old vase')
    renderApp(s, `/model/${folder}`)
    await user.click(await screen.findByRole('button', { name: 'הסר מהספרייה' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'הסר מהספרייה' }))
    await screen.findByTestId('archived-banner')
    expect((await readMeta(drive, folder)).json).toMatchObject({ archived: true })
  })

  it('a failed archive shows a Hebrew error with "try again"; nothing is hidden', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const { folderId } = await priced(drive, root, 'Vase')
    renderApp(s, `/model/${folderId}`)
    await user.click(await screen.findByRole('button', { name: 'הסר מהספרייה' }))
    drive.failNext('updateFileContent')
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'הסר מהספרייה' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/[א-ת]/)
    expect(screen.queryByTestId('archived-banner')).toBeNull()
    await user.click(within(alert).getByRole('button', { name: 'נסו שוב' }))
    await screen.findByTestId('archived-banner')
  })
})

// ---------------------------------------------------------------------------------------------
describe('A2 / AC39 / AC40 — library archive view', () => {
  async function setup() {
    const x = services()
    const { drive, root } = x
    const vase = await priced(x.drive, x.root, 'Vase')
    const lamp = await priced(x.drive, x.root, 'Lamp')
    const old = drive.addForeignFolder(root, 'Old stand')
    await setModelArchived(drive, root, lamp.folderId, true)
    await setModelArchived(drive, root, old, true)
    await rebuildIndex(drive, root)
    return { ...x, vase, lamp, old }
  }

  const cardNames = () => screen.queryAllByTestId('library-card').map((c) => c.textContent ?? '')

  it('archived cards are hidden; "ארכיון (N)" shows only them (URL ?view=archive), search works there; restore moves a card back', async () => {
    const user = userEvent.setup()
    const { s } = await setup()
    renderApp(s, '/library')
    await waitFor(() => expect(cardNames()).toHaveLength(1))
    expect(cardNames()[0]).toContain('Vase')

    await user.click(screen.getByRole('link', { name: 'ארכיון (2)' }))
    expect(screen.getByTestId('location').textContent).toBe('/library?view=archive')
    await waitFor(() => expect(cardNames()).toHaveLength(2))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ארכיון')

    await user.type(screen.getByLabelText('חיפוש לפי שם'), 'lam')
    expect(cardNames()).toHaveLength(1)
    expect(cardNames()[0]).toContain('Lamp')

    await user.click(screen.getByRole('button', { name: 'שחזר לספרייה: Lamp' }))
    await waitFor(() => expect(cardNames()).toHaveLength(0))
    await user.clear(screen.getByLabelText('חיפוש לפי שם'))
    expect(cardNames()).toHaveLength(1)
    expect(cardNames()[0]).toContain('Old stand')

    await user.click(screen.getByRole('link', { name: 'חזרה לספרייה' }))
    expect(screen.getByTestId('location').textContent).toBe('/library')
    await waitFor(() => expect(cardNames()).toHaveLength(2))
    expect(screen.getByRole('link', { name: 'ארכיון (1)' })).toBeTruthy()
  })

  it('opening /library?view=archive directly (refresh) shows the archive', async () => {
    const { s } = await setup()
    renderApp(s, '/library?view=archive')
    await waitFor(() => expect(cardNames()).toHaveLength(2))
    expect(screen.getAllByRole('button', { name: /^שחזר לספרייה/ })).toHaveLength(2)
  })

  it('archiving from the model page removes the card from the main library and puts it under the archive', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const { folderId } = await priced(drive, root, 'Vase')
    renderApp(s, `/model/${folderId}`)
    await user.click(await screen.findByRole('button', { name: 'הסר מהספרייה' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'הסר מהספרייה' }))
    await screen.findByTestId('archived-banner')
    await user.click(screen.getAllByRole('link', { name: 'ספרייה' })[0])
    await waitFor(() => expect(screen.getByRole('link', { name: 'ארכיון (1)' })).toBeTruthy())
    expect(cardNames()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe('A3 / AC41 — customers', () => {
  it('archived models are not in the "new quote" chooser; their quotes stay on the customer page', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const alpha = await priced(drive, root, 'Alpha')
    await priced(drive, root, 'Beta')
    const dana = (await addCustomer(drive, root, { name: 'דנה', email: 'dana@example.com' })).customer
    const record: QuoteRecord = {
      schemaVersion: 1,
      date: '2026-09-20T10:00:00.000Z',
      draftId: 'd',
      customerId: dana.id,
      model: { bidId: alpha.bid.id, name: 'Alpha', revision: 'V1' },
      customer: { name: 'דנה', email: 'dana@example.com' },
      includedHardware: [],
      priceShown: 80,
      landed: 1,
      price70: 3,
      savedBid: { landed: 1, price70: 3 },
      attachments: [],
    }
    await writeQuoteLog(drive, alpha.folderId, record)
    markQuotesChanged(drive)
    await setModelArchived(drive, root, alpha.folderId, true)

    renderApp(s, `/customers/${dana.id}`)
    const row = await screen.findByTestId('customer-quote')
    expect(row.textContent).toContain('Alpha')
    await user.click(screen.getByRole('button', { name: 'שליחת הצעה חדשה' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'בחירת דגם להצעה' }))
    await waitFor(() => expect(dialog.getByRole('button', { name: /Beta/ })).toBeTruthy())
    expect(dialog.queryByRole('button', { name: /Alpha/ })).toBeNull()
  })
})
