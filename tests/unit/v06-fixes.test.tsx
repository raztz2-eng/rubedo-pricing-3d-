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
  MODEL_META_FILE_NAME,
  type Bid,
} from '../../src/lib/bid'
import { parseCustomers, type Customer } from '../../src/lib/customers'
import {
  BID_CHANGED_MESSAGE,
  loadBid,
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
  bidContentOf,
  type BidContent,
} from '../../src/lib/drive/bidRepository'
import {
  addCustomer,
  CUSTOMERS_BUSY_MESSAGE,
  ensureQuoteCustomer,
  INVALID_CUSTOMERS_MESSAGE,
  loadCustomers,
  setCustomerHidden,
  updateCustomer,
} from '../../src/lib/drive/customerStore'
import { MemoryDrive } from '../../src/lib/drive/memoryDrive'
import { writeQuoteLog } from '../../src/lib/drive/quoteLog'
import { computePrice, DEFAULT_PRICING_SETTINGS } from '../../src/lib/pricing'
import type { QuoteRecord } from '../../src/lib/quote'
import { createMemoryServices, type AppServices } from '../../src/state/services'

const S = DEFAULT_PRICING_SETTINGS
const jpeg = (n = 1) => new Blob([new Uint8Array([0xff, 0xd8, n])], { type: 'image/jpeg' })
const json = (v: unknown) => new Blob([JSON.stringify(v)], { type: 'application/json' })

function renderApp(services: AppServices, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App services={services} />
    </MemoryRouter>,
  )
}

function services() {
  const drive = new MemoryDrive()
  const s = createMemoryServices(drive)
  return { s, drive, root: s.folderPointer.get() as string }
}

function content(name: string, over: Partial<BidContent> = {}): BidContent {
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
    ...over,
  }
  const pseudo = { ...base, files: [] } as unknown as Bid
  return { ...base, result: computePrice(bidPricingInput(pseudo), base.settingsSnapshot) }
}

async function priced(drive: MemoryDrive, root: string, name = 'Lamp', over: Partial<BidContent> = {}) {
  return saveNewBid(drive, root, { folderName: name, content: content(name, over), files: [] }, newSaveSession())
}

const customer = (id: string, name: string, email: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  email,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...extra,
})

// =============================================================================================
describe('C1 — a customers file with ANY invalid entry is invalid as a whole and never overwritten', () => {
  it('one bad entry → INVALID_CUSTOMERS_MESSAGE; add / edit / hide / auto-add all refuse; the file bytes never change; the page says so', async () => {
    const { s, drive, root } = services()
    const good = customer('c1', 'דנה', 'dana@example.com')
    const bad = { id: 'c2', name: 'יוסי' } // no e-mail
    expect(parseCustomers([good, bad])).toBeNull()
    const f = await drive.uploadFile(root, CUSTOMERS_FILE_NAME, json([good, bad]), 'application/json')
    const before = await drive.readText(f.id)

    await expect(loadCustomers(drive, root)).rejects.toMatchObject({ userMessage: INVALID_CUSTOMERS_MESSAGE })
    await expect(addCustomer(drive, root, { name: 'רון', email: 'ron@example.com' })).rejects.toMatchObject({ userMessage: INVALID_CUSTOMERS_MESSAGE })
    await expect(updateCustomer(drive, root, 'c1', { name: 'X', email: 'dana@example.com' })).rejects.toMatchObject({ userMessage: INVALID_CUSTOMERS_MESSAGE })
    await expect(setCustomerHidden(drive, root, 'c1', true)).rejects.toMatchObject({ userMessage: INVALID_CUSTOMERS_MESSAGE })
    await expect(ensureQuoteCustomer(drive, root, { name: 'רון', email: 'ron@example.com' })).rejects.toMatchObject({ userMessage: INVALID_CUSTOMERS_MESSAGE })
    expect(await drive.readText(f.id)).toBe(before)
    expect(drive.writeLog.filter((w) => w.includes(CUSTOMERS_FILE_NAME))).toEqual([`upload:${CUSTOMERS_FILE_NAME}`])

    renderApp(s, '/customers')
    expect(await screen.findByText(INVALID_CUSTOMERS_MESSAGE)).toBeTruthy()
    expect(await drive.readText(f.id)).toBe(before)
  })

  it('unknown fields survive every change; an entry without createdAt never gets createdAt=""', async () => {
    const { drive, root } = services()
    const noCreated = { id: 'c2', name: 'יוסי', email: 'yossi@example.com', crm: { tier: 'gold' } }
    await drive.uploadFile(root, CUSTOMERS_FILE_NAME, json([customer('c1', 'דנה', 'dana@example.com', { source: 'instagram' }), noCreated]), 'application/json')
    await updateCustomer(drive, root, 'c1', { name: 'דנה כהן', email: 'dana@example.com', phone: '050' })
    await setCustomerHidden(drive, root, 'c2', true)
    await addCustomer(drive, root, { name: 'רון', email: 'ron@example.com' })
    const file = (await drive.listChildren(root, { name: CUSTOMERS_FILE_NAME }))[0]
    const raw = JSON.parse(await drive.readText(file.id)) as Record<string, unknown>[]
    expect(raw[0]).toMatchObject({ id: 'c1', name: 'דנה כהן', phone: '050', source: 'instagram', createdAt: '2026-10-01T10:00:00.000Z' })
    expect(raw[1]).toMatchObject({ id: 'c2', hidden: true, crm: { tier: 'gold' } })
    expect('createdAt' in raw[1]).toBe(false)
    for (const c of raw) expect(c.createdAt).not.toBe('')
    // Clearing an optional field really clears it.
    await updateCustomer(drive, root, 'c1', { name: 'דנה כהן', email: 'dana@example.com' })
    expect((await loadCustomers(drive, root))[0].phone).toBeUndefined()
  })
})

// =============================================================================================
describe('I1 — no lost updates on _rubedo-customers.json', () => {
  it('(a) two concurrent adds → both kept', async () => {
    const { drive, root } = services()
    await Promise.all([
      addCustomer(drive, root, { name: 'דנה', email: 'dana@example.com' }),
      addCustomer(drive, root, { name: 'רון', email: 'ron@example.com' }),
      ensureQuoteCustomer(drive, root, { name: 'יוסי', email: 'yossi@example.com' }),
    ])
    expect((await loadCustomers(drive, root)).map((c) => c.name).sort()).toEqual(['דנה', 'יוסי', 'רון'])
    expect(await drive.listChildren(root, { name: CUSTOMERS_FILE_NAME })).toHaveLength(1)
  })

  it('(b) the file changed elsewhere between reading and writing → re-read, re-applied, both changes kept', async () => {
    const { drive, root } = services()
    await addCustomer(drive, root, { name: 'דנה', email: 'dana@example.com' })
    const file = (await drive.listChildren(root, { name: CUSTOMERS_FILE_NAME }))[0]
    const realGetFile = drive.getFile.bind(drive)
    let injected = false
    vi.spyOn(drive, 'getFile').mockImplementation(async (id) => {
      if (id === file.id && !injected) {
        injected = true
        // "Another device" adds Yossi right before our write.
        const other = JSON.parse(await drive.readText(file.id)) as Customer[]
        other.push(customer('other', 'יוסי', 'yossi@example.com'))
        await drive.updateFileContent(file.id, json(other), 'application/json')
      }
      return realGetFile(id)
    })
    await addCustomer(drive, root, { name: 'רון', email: 'ron@example.com' })
    expect(injected).toBe(true)
    expect((await loadCustomers(drive, root)).map((c) => c.name)).toEqual(['דנה', 'יוסי', 'רון'])
  })

  it('(b) still changing after 3 attempts → Hebrew error, our change is not written', async () => {
    const { drive, root } = services()
    await addCustomer(drive, root, { name: 'דנה', email: 'dana@example.com' })
    const file = (await drive.listChildren(root, { name: CUSTOMERS_FILE_NAME }))[0]
    const realGetFile = drive.getFile.bind(drive)
    let calls = 0
    vi.spyOn(drive, 'getFile').mockImplementation(async (id) => {
      if (id === file.id) {
        calls += 1
        await drive.updateFileContent(file.id, new Blob([await drive.readText(file.id)]), 'application/json')
      }
      return realGetFile(id)
    })
    await expect(addCustomer(drive, root, { name: 'רון', email: 'ron@example.com' })).rejects.toMatchObject({
      userMessage: CUSTOMERS_BUSY_MESSAGE,
      status: 409,
    })
    expect(calls).toBe(3)
    expect((await loadCustomers(drive, root)).map((c) => c.name)).toEqual(['דנה'])
  })

  it('(c) two marked files → read as one list (by id, newer updatedAt wins); changes go to the oldest; none is removed', async () => {
    const { drive, root } = services()
    const older = await drive.uploadFile(
      root,
      CUSTOMERS_FILE_NAME,
      json([customer('c1', 'דנה', 'dana@example.com'), customer('c2', 'יוסי', 'yossi@example.com')]),
      'application/json',
    )
    const newer = await drive.uploadFile(
      root,
      CUSTOMERS_FILE_NAME,
      json([customer('c2', 'יוסי לוי', 'yossi@example.com', { updatedAt: '2026-10-02T10:00:00.000Z' }), customer('c3', 'רון', 'ron@example.com')]),
      'application/json',
    )
    const newerBefore = await drive.readText(newer.id)
    expect((await loadCustomers(drive, root)).map((c) => c.name)).toEqual(['דנה', 'יוסי לוי', 'רון'])
    await addCustomer(drive, root, { name: 'מיכל', email: 'michal@example.com' })
    const merged = JSON.parse(await drive.readText(older.id)) as Customer[]
    expect(merged.map((c) => c.name)).toEqual(['דנה', 'יוסי לוי', 'רון', 'מיכל'])
    expect(await drive.readText(newer.id)).toBe(newerBefore)
    expect(await drive.listChildren(root, { name: CUSTOMERS_FILE_NAME })).toHaveLength(2)
    // A duplicate e-mail hidden in the second file is still caught.
    await expect(addCustomer(drive, root, { name: 'x', email: 'RON@example.com' })).rejects.toBeTruthy()
  })
})

// =============================================================================================
describe('I2 — updateBid never overwrites a change made in another window', () => {
  it('stale "existing" → Hebrew 409, nothing written', async () => {
    const { drive, root } = services()
    const { folderId, bid } = await priced(drive, root)
    // Another tab saves first.
    await updateBid(drive, root, { folderId, existing: bid, content: { ...bidContentOf(bid), laborMinutes: 99 }, newFiles: [] }, newSaveSession())
    const w0 = drive.writeLog.length
    const photo = { key: 'p', name: 'p.jpg', kind: 'image' as const, mimeType: 'image/jpeg', blob: jpeg() }
    await expect(
      updateBid(drive, root, { folderId, existing: bid, content: { ...bidContentOf(bid), description: 'mine' }, newFiles: [photo] }, newSaveSession()),
    ).rejects.toMatchObject({ status: 409, userMessage: BID_CHANGED_MESSAGE })
    expect(drive.writeLog.length).toBe(w0)
    expect((await loadBid(drive, folderId)).bid.laborMinutes).toBe(99)
  })

  it('a retry of the SAME save (bid.json written, index failed) is not refused', async () => {
    const { drive, root } = services()
    const { folderId, bid } = await priced(drive, root)
    const session = newSaveSession()
    // bid.json is written, then the index update fails.
    const bidFileId = (await loadBid(drive, folderId)).bidFileId
    drive.failNext('updateFileContent', (id) => id !== bidFileId)
    const params = { folderId, existing: bid, content: { ...bidContentOf(bid), laborMinutes: 5 }, newFiles: [] }
    await expect(updateBid(drive, root, params, session)).rejects.toBeTruthy()
    await updateBid(drive, root, params, session)
    expect((await loadBid(drive, folderId)).bid.laborMinutes).toBe(5)
  })

  it('cover / description from a stale page change only their own field (the other tab\'s edit is kept)', async () => {
    const { drive, root } = services()
    const { folderId, bid } = await priced(drive, root)
    const pic = drive.addForeignFile(folderId, 'p.jpg', jpeg(), 'image/jpeg')
    const stalePage = await loadModelFolder(drive, folderId)
    await updateBid(drive, root, { folderId, existing: bid, content: { ...bidContentOf(bid), laborMinutes: 42 }, newFiles: [] }, newSaveSession())
    await setModelCover(drive, root, stalePage, pic)
    await setModelDescription(drive, root, stalePage, 'חדש')
    const after = (await loadBid(drive, folderId)).bid
    expect(after).toMatchObject({ laborMinutes: 42, coverFileId: pic, description: 'חדש' })
  })

  it('UI: saving the edit form after another window saved → the Hebrew 409 message, form kept', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const { folderId, bid } = await priced(drive, root)
    renderApp(s, `/model/${folderId}/edit`)
    await screen.findByLabelText('תיאור')
    await updateBid(drive, root, { folderId, existing: bid, content: { ...bidContentOf(bid), laborMinutes: 77 }, newFiles: [] }, newSaveSession())
    fireEvent.change(screen.getByLabelText('תיאור'), { target: { value: 'שלי' } })
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    expect(await screen.findByText((t) => t.includes(BID_CHANGED_MESSAGE))).toBeTruthy()
    expect((screen.getByLabelText('תיאור') as HTMLTextAreaElement).value).toBe('שלי')
    expect((await loadBid(drive, folderId)).bid.laborMinutes).toBe(77)
  })
})

// =============================================================================================
describe('I3 — a damaged _rubedo-model.json is never replaced; meta writes re-read first', () => {
  it('damaged meta → no cover/description actions on the page; lib refuses; the file bytes and the folder are unchanged', async () => {
    const { s, drive, root } = services()
    const folder = drive.addForeignFolder(root, 'Vase')
    const pic = drive.addForeignFile(folder, 'a.jpg', jpeg(), 'image/jpeg')
    const meta = await drive.uploadFile(folder, MODEL_META_FILE_NAME, new Blob(['{broken']), 'application/json')
    renderApp(s, `/model/${folder}`)
    expect(await screen.findByText(/_rubedo-model\.json פגום/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'קבע כתמונה ראשית' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'עריכת תיאור' })).toBeNull()
    expect(screen.queryByLabelText('העלה תמונה חדשה כראשית')).toBeNull()

    const model = await loadModelFolder(drive, folder)
    const w0 = drive.writeLog.length
    await expect(setModelCover(drive, root, model, pic)).rejects.toBeTruthy()
    await expect(setModelDescription(drive, root, model, 'x')).rejects.toBeTruthy()
    const file = { key: 'c', name: 'c.jpg', kind: 'image' as const, mimeType: 'image/jpeg', blob: jpeg(3) }
    await expect(uploadModelCover(drive, root, model, file, newSaveSession())).rejects.toBeTruthy()
    expect(drive.writeLog.length).toBe(w0) // not even the picture was uploaded
    expect(await drive.readText(meta.id)).toBe('{broken')
  })

  it('a stale page keeps the other field: description saved after a cover chosen elsewhere keeps the cover', async () => {
    const { drive, root } = services()
    const folder = drive.addForeignFolder(root, 'Vase')
    const pic = drive.addForeignFile(folder, 'a.jpg', jpeg(), 'image/jpeg')
    const stale = await loadModelFolder(drive, folder)
    await setModelDescription(drive, root, stale, 'ראשון')
    await setModelCover(drive, root, stale, pic)
    await setModelDescription(drive, root, stale, 'שני')
    expect((await loadModelFolder(drive, folder)).meta).toMatchObject({ coverFileId: pic, description: 'שני' })
  })

  it('create from a folder with a damaged meta file → a Hebrew notice says its cover/description were not used', async () => {
    const { s, drive, root } = services()
    const folder = drive.addForeignFolder(root, 'Vase')
    await drive.uploadFile(folder, MODEL_META_FILE_NAME, new Blob(['{broken']), 'application/json')
    renderApp(s, `/model/${folder}/create`)
    expect((await screen.findByTestId('meta-warning')).textContent).toMatch(/פגום/)
  })
})

// =============================================================================================
describe('I4 — refreshing the quote history', () => {
  function record(date: string, email: string, price: number): QuoteRecord {
    return {
      schemaVersion: 1,
      date,
      draftId: 'd',
      model: { bidId: 'b', name: 'Lamp', revision: 'V1' },
      customer: { name: 'n', email },
      includedHardware: [],
      priceShown: price,
      landed: 1,
      price70: 3,
      savedBid: { landed: 1, price70: 3 },
      attachments: [],
    }
  }

  it('one unreadable log (Drive error), a corrupt one and a Google Doc do not abort the refresh; they are reported/ignored', async () => {
    const { drive, root } = services()
    const { folderId } = await priced(drive, root)
    const ok = await writeQuoteLog(drive, folderId, record('2026-10-01T10:00:00.000Z', 'a@e.co', 10), new Date(2026, 9, 1, 10, 0))
    const failing = await writeQuoteLog(drive, folderId, record('2026-10-01T11:00:00.000Z', 'b@e.co', 20), new Date(2026, 9, 1, 11, 0))
    await drive.uploadFile(ok.folderId, 'quote-20261001-1200.json', new Blob(['{not json']), 'application/json')
    drive.addForeignFile(ok.folderId, 'quote-notes.json', new Blob(['']), 'application/vnd.google-apps.document')
    drive.failNext('readText', (id) => id === failing.fileId)
    const r = await rebuildIndex(drive, root)
    expect(r.quotes.map((q) => q.priceShown)).toEqual([10])
    expect(r.skippedQuotes.sort()).toEqual(['Lamp/quote-20261001-1100.json', 'Lamp/quote-20261001-1200.json'])
    // Next refresh reads the log again (it was never cached).
    expect((await rebuildIndex(drive, root)).quotes.map((q) => q.priceShown)).toEqual([20, 10])
  })

  it('only NEW logs are read: summaries of logs already in the index are reused by file id', async () => {
    const { drive, root } = services()
    const { folderId } = await priced(drive, root)
    const a = await writeQuoteLog(drive, folderId, record('2026-10-01T10:00:00.000Z', 'a@e.co', 10), new Date(2026, 9, 1, 10, 0))
    await rebuildIndex(drive, root)
    const b = await writeQuoteLog(drive, folderId, record('2026-10-01T11:00:00.000Z', 'b@e.co', 20), new Date(2026, 9, 1, 11, 0))
    const spy = vi.spyOn(drive, 'readText')
    const r = await rebuildIndex(drive, root)
    const read = spy.mock.calls.map((c) => c[0])
    expect(read).toContain(b.fileId)
    expect(read).not.toContain(a.fileId)
    expect(r.quotes.map((q) => q.priceShown)).toEqual([20, 10])
  })

  it('the "quotes changed" flag is cleared only by a SUCCESSFUL rebuild', async () => {
    const { drive, root } = services()
    await priced(drive, root)
    await rebuildIndex(drive, root)
    markQuotesChanged(drive)
    drive.failNext('listChildren', (id) => id === root)
    await expect(loadQuoteHistory(drive, root)).rejects.toBeTruthy()
    const spy = vi.spyOn(drive, 'listChildren')
    await loadQuoteHistory(drive, root)
    const n = spy.mock.calls.length
    expect(n).toBeGreaterThan(2) // rebuilt, not served from the cache
    await loadQuoteHistory(drive, root)
    expect(spy.mock.calls.length - n).toBeLessThanOrEqual(1) // now cached
  })
})

// =============================================================================================
describe('Minor fixes', () => {
  async function legacy(drive: MemoryDrive, root: string, tamperPrice: boolean) {
    const folder = drive.addForeignFolder(root, 'Old')
    const c = content('Old', { hasShipping: false, packaging: [{ name: 'Box', qty: 2, unitCost: 4 }], shippingCost: 12 })
    const old = {
      ...c,
      result: tamperPrice ? { ...c.result, price70: c.result.price70 + 5 } : c.result,
      schemaVersion: 1,
      id: 'legacy-0001',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      files: [],
    }
    drive.addLegacyAppFile(folder, BID_FILE_NAME, json(old), 'application/json')
    return { folder, old }
  }

  it('conversion keeps the old id + createdAt and the packaging rows (shipping off); no warning when prices match', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const { folder, old } = await legacy(drive, root, false)
    renderApp(s, `/model/${folder}/create`)
    await screen.findByLabelText('תיאור')
    expect(screen.queryByTestId('conversion-price-warning')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    await screen.findByRole('heading', { level: 1, name: 'Old' })
    const { bid, legacy: isLegacy } = await loadBid(drive, folder)
    expect(isLegacy).toBe(false)
    expect(bid).toMatchObject({ id: old.id, createdAt: old.createdAt, hasShipping: false, packaging: old.packaging, shippingCost: 12 })
    expect(bid.updatedAt).not.toBe(old.updatedAt)
  })

  it('conversion warns in Hebrew when the recalculated price differs from the stored one', async () => {
    const { s, drive, root } = services()
    const { folder } = await legacy(drive, root, true)
    renderApp(s, `/model/${folder}/create`)
    expect((await screen.findByTestId('conversion-price-warning')).textContent).toMatch(/שונה מהמחיר שנשמר/)
  })

  it('edit keeps packaging rows when shipping is switched off (not priced)', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const { folderId } = await priced(drive, root, 'Box', { hasShipping: true, packaging: [{ name: 'Box', qty: 1, unitCost: 5 }], shippingCost: 10 })
    renderApp(s, `/model/${folderId}/edit`)
    await user.click(await screen.findByRole('checkbox', { name: 'כולל אריזה ומשלוח' }))
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    await screen.findByRole('heading', { level: 1, name: 'Box' })
    const { bid } = await loadBid(drive, folderId)
    expect(bid).toMatchObject({ hasShipping: false, packaging: [{ name: 'Box', qty: 1, unitCost: 5 }], shippingCost: 10 })
    expect(bid.result.packaging).toBe(0)
  })

  it('the 2000-character limit is checked only when the description changed', async () => {
    const { drive, root } = services()
    const long = 'x'.repeat(DESCRIPTION_MAX_LENGTH + 10)
    // An older bid with a longer description (saved before the limit existed).
    const { folderId, bid } = await priced(drive, root, 'Long', { description: long })
    const saved = await updateBid(drive, root, { folderId, existing: bid, content: { ...bidContentOf(bid), laborMinutes: 3 }, newFiles: [] }, newSaveSession())
    expect(saved.description).toBe(long)
    await expect(
      updateBid(drive, root, { folderId, existing: saved, content: { ...bidContentOf(saved), description: `${long}y` }, newFiles: [] }, newSaveSession()),
    ).rejects.toMatchObject({ userMessage: DESCRIPTION_TOO_LONG_MESSAGE })
  })

  it('customers file unreadable → the quote log has NO customerId (never a made-up one) and the draft still succeeds', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const { folderId } = await priced(drive, root)
    await drive.uploadFile(root, CUSTOMERS_FILE_NAME, new Blob(['oops']), 'application/json')
    renderApp(s, `/model/${folderId}/quote`)
    await screen.findByText(/רשימת הלקוחות לא נטענה/)
    fireEvent.change(screen.getByLabelText(/^שם הלקוח/), { target: { value: 'רון' } })
    fireEvent.change(screen.getByLabelText(/^מייל הלקוח/), { target: { value: 'ron@example.com' } })
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
    await screen.findByTestId('draft-success')
    const q = (await drive.listChildren(folderId, { name: 'quotes' }))[0]
    const log = JSON.parse(await drive.readText((await drive.listChildren(q.id))[0].id))
    expect('customerId' in log).toBe(false)
    expect(screen.getByTestId('customer-notice').textContent).toMatch(/נכשלה/)
  })

  it('auto-add hits a hidden customer → a notice says so; nothing written', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const { folderId } = await priced(drive, root)
    const c = (await addCustomer(drive, root, { name: 'דנה', email: 'dana@example.com' })).customer
    await setCustomerHidden(drive, root, c.id, true)
    renderApp(s, `/model/${folderId}/quote`)
    await screen.findByRole('combobox', { name: 'בחירת לקוח קיים' })
    fireEvent.change(screen.getByLabelText(/^שם הלקוח/), { target: { value: 'דנה' } })
    fireEvent.change(screen.getByLabelText(/^מייל הלקוח/), { target: { value: 'dana@example.com' } })
    const w0 = drive.writeLog.length
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
    await screen.findByTestId('draft-success')
    expect(screen.getByTestId('customer-notice').textContent).toMatch(/מוסתר/)
    expect(drive.writeLog.slice(w0).filter((w) => w.includes(CUSTOMERS_FILE_NAME))).toEqual([])
  })

  it('e-mails and file names are isolated LTR with <bdi dir="ltr">; the edit link has no aria-label override', async () => {
    const { s, drive, root } = services()
    const { folderId } = await priced(drive, root)
    drive.addForeignFile(folderId, 'model.stl', new Blob(['x']), 'model/stl')
    await addCustomer(drive, root, { name: 'דנה', email: 'dana@example.com' })
    renderApp(s, `/model/${folderId}`)
    const link = (await screen.findByRole('link', { name: 'עריכת הצעה' })) as HTMLAnchorElement
    expect(link.hasAttribute('aria-label')).toBe(false)
    const file = within(screen.getByRole('list', { name: 'קבצי הדגם' })).getByText('model.stl')
    expect(file.tagName).toBe('BDI')
    expect(file.getAttribute('dir')).toBe('ltr')
    renderApp(s, '/customers')
    const email = await screen.findByText('dana@example.com')
    expect(email.tagName).toBe('BDI')
    expect(email.getAttribute('dir')).toBe('ltr')
  })
})

// =============================================================================================
describe('description limit on the model page applies only to a changed text', () => {
  it('an older long description can be opened and the editor does not block saving until it is changed', async () => {
    const user = userEvent.setup()
    const { s, drive, root } = services()
    const long = 'x'.repeat(DESCRIPTION_MAX_LENGTH + 5)
    const { folderId } = await priced(drive, root, 'Long', { description: long })
    renderApp(s, `/model/${folderId}`)
    await user.click(await screen.findByRole('button', { name: 'עריכת תיאור' }))
    expect((screen.getByRole('button', { name: 'שמירת תיאור' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(screen.getByLabelText('תיאור הדגם'), { target: { value: `${long}!` } })
    await waitFor(() => expect((screen.getByRole('button', { name: 'שמירת תיאור' }) as HTMLButtonElement).disabled).toBe(true))
  })
})
