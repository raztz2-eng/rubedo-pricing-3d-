/**
 * Brief addendum v0.3 (N1–N6, AC14–AC17): existing model folders, photos added in Drive, read-only access to
 * files the app did not create. Everything runs against the in-memory drive.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/App'
import { BID_FILE_NAME, FOLDER_MIME, INDEX_FILE_NAME, INDEX_MAX_AGE_MS, type IndexEntry } from '../../src/lib/bid'
import { mapLimit } from '../../src/lib/concurrency'
import {
  FOLDER_SCAN_CONCURRENCY,
  isIndexStale,
  loadLibrary,
  loadLibraryState,
  loadModelFolder,
  newSaveSession,
  rebuildIndex,
  saveNewBid,
  type BidContent,
} from '../../src/lib/drive/bidRepository'
import { classifyFolder, isSkippedFolderName, pickCover } from '../../src/lib/drive/folderContents'
import { loadPreviewBlob, NoPreviewError, sizedThumbnailLink } from '../../src/lib/drive/images'
import { MemoryDrive } from '../../src/lib/drive/memoryDrive'
import { DriveError, type DriveFile } from '../../src/lib/drive/types'
import { computePrice, DEFAULT_PRICING_SETTINGS } from '../../src/lib/pricing'
import { createMemoryServices, type AppServices } from '../../src/state/services'

const SLICED = 'rooting-stand.gcode.3mf'

function fixtureBlob(name: string): Blob {
  return new Blob([new Uint8Array(readFileSync(resolve(process.cwd(), 'tests/fixtures', name)))])
}
const img = (label = 'x') => new Blob([label], { type: 'image/png' })

function content(name: string): BidContent {
  const settings = { ...DEFAULT_PRICING_SETTINGS }
  const result = computePrice(
    { pricePerKg: 85, parts: [{ qty: 1, grams: 100, hours: 3.5 }], laborMinutes: 10, hardware: [], hasShipping: false, packaging: [], shippingCost: 0 },
    settings,
  )
  return {
    name,
    revision: 'V1',
    description: '',
    material: { name: 'PLA', pricePerKg: 85 },
    parts: [{ name: 'p', qty: 1, grams: 100, hours: 3.5, source: 'manual' }],
    laborMinutes: 10,
    hardware: [],
    hasShipping: false,
    packaging: [],
    shippingCost: 0,
    settingsSnapshot: settings,
    result,
  }
}

function renderApp(services: AppServices, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App services={services} />
    </MemoryRouter>,
  )
}

function stubObjectUrls() {
  const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:mock-${++n}`)
  URL.revokeObjectURL = vi.fn()
  return () => {
    URL.createObjectURL = orig.create
    URL.revokeObjectURL = orig.revoke
  }
}

/** A folder the app did NOT create writes are refused for; used to assert N6 / AC17. */
function foreignIds(drive: MemoryDrive): Set<string> {
  return new Set(drive.all().filter((n) => n.appCreated === false).map((n) => n.id))
}

// ---------------------------------------------------------------------------------------------
describe('folderContents helpers', () => {
  it('skips "_…" folders and "Models photo" (spaces trimmed)', () => {
    expect(isSkippedFolderName('_archive')).toBe(true)
    expect(isSkippedFolderName('  _x')).toBe(true)
    expect(isSkippedFolderName('Models photo')).toBe(true)
    expect(isSkippedFolderName('  Models photo  ')).toBe(true)
    expect(isSkippedFolderName('Stand')).toBe(false)
    expect(isSkippedFolderName('Models photos')).toBe(false)
  })

  it('classifies images, files, sliced files and bid.json; cover rule prefers photos over plate pictures', () => {
    const f = (id: string, name: string, mimeType: string): DriveFile => ({ id, name, mimeType })
    const c = classifyFolder([
      f('1', 'bid.json', 'application/json'),
      f('2', 'b.jpg', 'image/jpeg'),
      f('3', 'Stand-plate-1.png', 'image/png'),
      f('4', 'a.HEIC', 'application/octet-stream'),
      f('5', 'x.gcode.3mf', 'application/octet-stream'),
      f('6', 'part.stl', 'model/stl'),
      f('7', 'sub', FOLDER_MIME),
    ])
    expect(c.bidFile?.id).toBe('1')
    expect(c.images.map((i) => i.id)).toEqual(['4', '2', '3'])
    expect(c.files.map((i) => i.id)).toEqual(['6', '5'])
    expect(c.sliced.map((i) => i.id)).toEqual(['5'])
    expect(pickCover(c.images)).toBe('4')
    expect(pickCover(c.images, 'explicit')).toBe('explicit')
    expect(pickCover([f('3', 'Stand-plate-1.png', 'image/png')])).toBe('3')
    expect(pickCover([])).toBeUndefined()
  })
})

describe('mapLimit', () => {
  it('keeps order and never runs more than the limit at once', async () => {
    let running = 0
    let max = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 5, async (n) => {
      running += 1
      max = Math.max(max, running)
      await new Promise((r) => setTimeout(r, 2))
      running -= 1
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24])
    expect(max).toBe(5)
  })

  it('rejects with the first error and starts nothing new afterwards', async () => {
    const started: number[] = []
    await expect(
      mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n)
        if (n === 2) throw new Error('boom')
        await new Promise((r) => setTimeout(r, 5))
        return n
      }),
    ).rejects.toThrow('boom')
    expect(started.length).toBeLessThan(6)
  })
})

describe('image previews (N3)', () => {
  it('uses the sized thumbnail first; falls back to the file for jpg/png/webp; HEIC without thumbnail → no preview', async () => {
    expect(sizedThumbnailLink('https://lh3.googleusercontent.com/abc=s220')).toBe('https://lh3.googleusercontent.com/abc=s800')
    expect(sizedThumbnailLink('https://x/y')).toBe('https://x/y')

    const drive = new MemoryDrive()
    const root = drive.createRootFolder('models')
    const jpg = drive.addForeignFile(root, 'a.jpg', new Blob(['JPG'], { type: 'image/jpeg' }), 'image/jpeg')
    const heicThumb = drive.addForeignFile(root, 'b.HEIC', new Blob(['HEIC']), 'image/heic', { thumbnail: new Blob(['THUMB']) })
    const heicNone = drive.addForeignFile(root, 'c.HEIC', new Blob(['HEIC']), 'image/heic', { thumbnail: null })
    const get = (id: string) => drive.getFile(id)

    expect(await (await loadPreviewBlob(drive, await get(heicThumb))).text()).toBe('THUMB')
    const read = vi.spyOn(drive, 'readThumbnail')
    await loadPreviewBlob(drive, await get(heicThumb))
    expect(read.mock.calls[0][0]).toMatch(/=s800$/)

    drive.failNext('readThumbnail')
    expect(await (await loadPreviewBlob(drive, await get(jpg))).text()).toBe('JPG')

    await expect(loadPreviewBlob(drive, await get(heicNone))).rejects.toBeInstanceOf(NoPreviewError)
  })
})

// ---------------------------------------------------------------------------------------------
describe('N1/N5 — library = every model subfolder; index with status and build time', () => {
  let drive: MemoryDrive
  let root: string
  beforeEach(() => {
    drive = new MemoryDrive()
    root = drive.createRootFolder('models')
  })

  it('priced for bid.json, needs-slicing for the Founder\'s folders; skips "_…", "Models photo" and abandoned app folders', async () => {
    await saveNewBid(drive, root, { folderName: 'Priced', content: content('Priced'), files: [] }, newSaveSession())
    const plain = drive.addForeignFolder(root, 'Old vase', { modifiedTime: '2025-05-01T00:00:00Z' })
    const withSliced = drive.addForeignFolder(root, 'Rooting stand ', { modifiedTime: '2025-06-01T00:00:00Z' })
    const slicedId = drive.addForeignFile(withSliced, SLICED, fixtureBlob(SLICED), 'application/octet-stream')
    drive.addForeignFolder(root, '_drafts')
    drive.addForeignFolder(root, ' Models photo ')
    await drive.createFolder(root, 'Broken save') // created by the app, save failed before bid.json

    const { entries } = await rebuildIndex(drive, root)
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]))
    expect(Object.keys(byName).sort()).toEqual(['Old vase', 'Priced', 'Rooting stand'])
    expect(byName['Priced'].status).toBe('priced')
    expect(byName['Priced'].price70?.toFixed(2)).toBe('83.37')
    expect(byName['Old vase']).toMatchObject({ id: plain, status: 'needs-slicing' })
    expect(byName['Old vase'].price70).toBeUndefined()
    expect(byName['Old vase'].slicedFileId).toBeUndefined()
    expect(byName['Rooting stand']).toMatchObject({ status: 'needs-slicing', slicedFileId: slicedId })
  })

  it('cover of a needs-slicing folder = first photo by name; priced bid without cover uses a photo added later', async () => {
    const f = drive.addForeignFolder(root, 'Vase')
    drive.addForeignFile(f, 'z.jpg', img(), 'image/jpeg')
    const first = drive.addForeignFile(f, 'a.jpg', img(), 'image/jpeg')
    const { folderId } = await saveNewBid(drive, root, { folderName: 'Bare', content: content('Bare'), files: [] }, newSaveSession())
    const later = drive.addForeignFile(folderId, 'later.jpg', img(), 'image/jpeg')

    const { entries } = await rebuildIndex(drive, root)
    expect(entries.find((e) => e.name === 'Vase')?.coverFileId).toBe(first)
    expect(entries.find((e) => e.name === 'Bare')?.coverFileId).toBe(later)
  })

  it('the index stores builtAt; legacy (array) or >10 min old index is stale; loadLibrary still returns entries', async () => {
    expect(INDEX_MAX_AGE_MS).toBe(10 * 60 * 1000)
    const t0 = new Date('2026-09-30T10:00:00Z')
    await rebuildIndex(drive, root, t0)
    const idx = (await drive.listChildren(root, { name: INDEX_FILE_NAME }))[0]
    const file = JSON.parse(await drive.readText(idx.id))
    expect(file).toMatchObject({ schemaVersion: 3, builtAt: t0.toISOString(), entries: [], quotes: [], customers: [] })

    expect(isIndexStale(t0.toISOString(), new Date(t0.getTime() + 9 * 60_000))).toBe(false)
    expect(isIndexStale(t0.toISOString(), new Date(t0.getTime() + 11 * 60_000))).toBe(true)
    expect(isIndexStale(undefined)).toBe(true)
    expect((await loadLibraryState(drive, root, new Date(t0.getTime() + 60_000))).stale).toBe(false)
    expect((await loadLibraryState(drive, root, new Date(t0.getTime() + 11 * 60_000))).stale).toBe(true)

    // v0.2 index (bare array) is read, but stale.
    const legacy: IndexEntry[] = [{ id: 'x', name: 'Legacy', revision: 'V1', price70: 1, landed: 0.3, updatedAt: '2026-01-01' }]
    await drive.updateFileContent(idx.id, new Blob([JSON.stringify(legacy)]), 'application/json')
    const state = await loadLibraryState(drive, root)
    expect(state.stale).toBe(true)
    expect(state.entries.map((e) => e.name)).toEqual(['Legacy'])
    expect((await loadLibrary(drive, root)).map((e) => e.name)).toEqual(['Legacy'])

    // v0.5 index (schemaVersion 2, fresh builtAt, no quote history) is read, but stale (v0.6).
    const v2 = { schemaVersion: 2, builtAt: new Date().toISOString(), entries: legacy }
    await drive.updateFileContent(idx.id, new Blob([JSON.stringify(v2)]), 'application/json')
    const v2State = await loadLibraryState(drive, root)
    expect(v2State.stale).toBe(true)
    expect(v2State.entries.map((e) => e.name)).toEqual(['Legacy'])
  })

  it(`lists at most ${FOLDER_SCAN_CONCURRENCY} model folders at a time`, async () => {
    for (let i = 0; i < 14; i++) drive.addForeignFolder(root, `M${i}`)
    const inner = drive.listChildren.bind(drive)
    let running = 0
    let max = 0
    vi.spyOn(drive, 'listChildren').mockImplementation(async (id, o) => {
      if (id === root) return inner(id, o)
      running += 1
      max = Math.max(max, running)
      await new Promise((r) => setTimeout(r, 2))
      running -= 1
      return inner(id, o)
    })
    const { entries } = await rebuildIndex(drive, root)
    expect(entries).toHaveLength(14)
    expect(max).toBe(FOLDER_SCAN_CONCURRENCY)
  })

  it('a Drive error while scanning aborts the rebuild without writing the index', async () => {
    const a = drive.addForeignFolder(root, 'A')
    drive.addForeignFolder(root, 'B')
    const before = drive.writeLog.length
    drive.failNext('listChildren', (id) => id === a)
    await expect(rebuildIndex(drive, root)).rejects.toThrow(/simulated failure/)
    expect(drive.writeLog.length).toBe(before)
  })
})

// ---------------------------------------------------------------------------------------------
describe('N2 — bid into an existing folder (repository)', () => {
  it('writes bid.json into the SAME folder, creates no folder, does not re-upload the sliced file, card becomes priced', async () => {
    const drive = new MemoryDrive()
    const root = drive.createRootFolder('models')
    const folder = drive.addForeignFolder(root, 'Stand')
    const sliced = drive.addForeignFile(folder, SLICED, fixtureBlob(SLICED), 'application/octet-stream')
    expect((await loadLibrary(drive, root))[0]).toMatchObject({ id: folder, status: 'needs-slicing' })

    const log = drive.writeLog.length
    const c = content('Stand')
    c.parts = [{ name: 'Rooting stand', qty: 1, grams: 55.94, hours: 9312 / 3600, source: '3mf', slicedFileId: sliced }]
    const { folderId, bid } = await saveNewBid(
      drive,
      root,
      {
        folderName: 'Stand',
        existingFolderId: folder,
        existingFiles: [{ id: sliced, name: SLICED, kind: 'sliced', mimeType: 'application/octet-stream' }],
        content: c,
        files: [],
      },
      newSaveSession(),
    )
    expect(folderId).toBe(folder)
    expect(drive.writeLog.slice(log)).toEqual(['upload:bid.json', `update:${INDEX_FILE_NAME}`])
    expect(bid.parts[0].slicedFileId).toBe(sliced)
    expect(bid.files).toEqual([{ id: sliced, name: SLICED, kind: 'sliced', mimeType: 'application/octet-stream' }])
    const lib = await loadLibrary(drive, root)
    expect(lib).toHaveLength(1)
    expect(lib[0]).toMatchObject({ id: folder, status: 'priced' })
  })

  it('refuses when the folder already has a bid.json (never overwrites)', async () => {
    const drive = new MemoryDrive()
    const root = drive.createRootFolder('models')
    const folder = drive.addForeignFolder(root, 'Stand')
    await saveNewBid(drive, root, { folderName: 'Stand', existingFolderId: folder, content: content('Stand'), files: [] }, newSaveSession())
    const before = drive.writeLog.length
    await expect(
      saveNewBid(drive, root, { folderName: 'Stand', existingFolderId: folder, content: content('Stand'), files: [] }, newSaveSession()),
    ).rejects.toMatchObject({ status: 409 })
    expect(drive.writeLog.length).toBe(before)
  })
})

// ---------------------------------------------------------------------------------------------
describe('N6 / AC17 — nothing modifies or moves files the app did not create', () => {
  it('MemoryDrive refuses to update a foreign file, like the real store', async () => {
    const drive = new MemoryDrive()
    const root = drive.createRootFolder('models')
    const f = drive.addForeignFolder(root, 'Vase')
    const photo = drive.addForeignFile(f, 'bid.json', new Blob(['{}']), 'application/json')
    const err = await drive.updateFileContent(photo, new Blob(['x']), 'application/json').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DriveError)
    expect((err as DriveError).status).toBe(403)
    expect(await drive.readText(photo)).toBe('{}')
  })

  it('library rebuild, model page load and create-into-folder only create new files; no update targets a foreign file', async () => {
    const drive = new MemoryDrive()
    const root = drive.createRootFolder('models')
    const folder = drive.addForeignFolder(root, 'Stand')
    drive.addForeignFile(folder, 'photo.jpg', img(), 'image/jpeg')
    drive.addForeignFile(folder, SLICED, fixtureBlob(SLICED), 'application/octet-stream')
    const foreign = foreignIds(drive)

    await rebuildIndex(drive, root)
    await loadModelFolder(drive, folder)
    await saveNewBid(drive, root, { folderName: 'Stand', existingFolderId: folder, content: content('Stand'), files: [] }, newSaveSession())
    await rebuildIndex(drive, root)

    for (const w of drive.writeTargets) {
      if (w.op === 'updateFileContent') expect(foreign.has(w.targetId), `update of foreign ${w.targetId}`).toBe(false)
    }
    // Every foreign node is still where it was, unchanged.
    for (const n of drive.all().filter((x) => foreign.has(x.id))) expect(n.appCreated).toBe(false)
    expect(drive.all().filter((n) => n.parentId === folder).map((n) => n.name).sort()).toEqual(['bid.json', 'photo.jpg', SLICED].sort())
  })
})

// ---------------------------------------------------------------------------------------------
describe('UI — AC14 / AC15 / AC16 / N4 / N5', () => {
  let restore: () => void
  beforeEach(() => {
    restore = stubObjectUrls()
  })
  afterEach(() => {
    restore()
    vi.restoreAllMocks()
  })

  it('AC14: a folder without bid.json is a needs-slicing card with its name, badge and no price', async () => {
    const services = createMemoryServices()
    const root = services.folderPointer.get() as string
    services.drive.addForeignFolder(root, 'Old vase')
    renderApp(services, '/library')
    const card = await screen.findByTestId('library-card')
    expect(card.textContent).toContain('Old vase')
    expect(card.getAttribute('data-status')).toBe('needs-slicing')
    expect(within(card).getByTestId('status-badge').textContent).toBe('דורש סלייס')
    expect(card.textContent).not.toMatch(/₪/)
    expect(screen.getByRole('link', { name: 'צור הצעת מחיר' })).toBeTruthy()
  })

  it('AC15: sliced file found → badge; create bid prefills 55.94 g / 2.587 h; save into the same folder → priced ₪23.17', async () => {
    const user = userEvent.setup()
    const services = createMemoryServices()
    const drive = services.drive
    const root = services.folderPointer.get() as string
    const folder = drive.addForeignFolder(root, 'Rooting stand')
    const sliced = drive.addForeignFile(folder, SLICED, fixtureBlob(SLICED), 'application/octet-stream')
    renderApp(services, '/library')

    const card = await screen.findByTestId('library-card')
    expect(within(card).getByTestId('status-badge').textContent).toBe('נמצא קובץ סלייס — צור הצעה')
    await user.click(screen.getByRole('link', { name: 'צור הצעת מחיר' }))

    const rows = await screen.findAllByTestId('part-row')
    expect(rows).toHaveLength(1)
    expect((within(rows[0]).getByLabelText('משקל') as HTMLInputElement).value).toBe('55.94')
    expect((within(rows[0]).getByLabelText('זמן הדפסה') as HTMLInputElement).value).toBe('2.587')
    expect((screen.getByLabelText(/^שם \*$/) as HTMLInputElement).value).toBe('Rooting stand')
    expect(screen.getByTestId('price-70').textContent).toContain('₪23.17')

    const log = drive.writeLog.length
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    await screen.findByRole('heading', { name: 'Rooting stand' })
    expect(screen.queryByRole('dialog')).toBeNull()
    const writes = drive.writeLog.slice(log)
    expect(writes.filter((w) => w.startsWith('folder:'))).toEqual([])
    expect(writes.filter((w) => w.startsWith('upload:'))).toEqual(['upload:bid.json'])

    const bidFile = (await drive.listChildren(folder, { name: BID_FILE_NAME }))[0]
    const bid = JSON.parse(await drive.readText(bidFile.id))
    expect(bid.parts[0]).toMatchObject({ source: '3mf', slicedFileId: sliced })
    expect(drive.all().filter((n) => n.parentId === root && n.mimeType === FOLDER_MIME)).toHaveLength(1)

    await user.click(screen.getAllByRole('link', { name: /^ספרייה/ })[0])
    const priced = await screen.findByTestId('library-card')
    await waitFor(() => expect(priced.getAttribute('data-status')).toBe('priced'))
    expect(priced.textContent).toContain('₪23.17')
  })

  it('AC16 / N3 / N4: photos added in Drive later appear on the model page; HEIC via thumbnail; all files with Drive links', async () => {
    const services = createMemoryServices()
    const drive = services.drive
    const root = services.folderPointer.get() as string
    const { folderId } = await saveNewBid(drive, root, { folderName: 'Stand', content: content('Stand'), files: [] }, newSaveSession())
    drive.addForeignFile(folderId, 'added-later.jpg', new Blob(['J'], { type: 'image/jpeg' }), 'image/jpeg')
    drive.addForeignFile(folderId, 'IMG_1.HEIC', new Blob(['H']), 'image/heic', { thumbnail: new Blob(['T']) })
    drive.addForeignFile(folderId, 'IMG_2.HEIC', new Blob(['H']), 'image/heic', { thumbnail: null })
    const stl = drive.addForeignFile(folderId, 'part.stl', new Blob(['solid']), 'model/stl')
    drive.addForeignFile(folderId, SLICED, fixtureBlob(SLICED), 'application/octet-stream')

    renderApp(services, `/model/${folderId}`)
    await screen.findByRole('heading', { name: 'Stand' })
    const gallery = within(screen.getByRole('region', { name: 'תמונות' }))
    await waitFor(() => expect(gallery.getAllByRole('img').map((i) => i.getAttribute('alt')).sort()).toEqual(['IMG_1.HEIC', 'added-later.jpg']))
    await waitFor(() => expect(gallery.getByText('אין תצוגה מקדימה')).toBeTruthy())

    const files = within(screen.getByRole('list', { name: 'קבצי הדגם' }))
    expect((files.getByRole('link', { name: 'part.stl' }) as HTMLAnchorElement).getAttribute('href')).toBe(drive.fileUrl(stl))
    expect(files.getByRole('link', { name: SLICED })).toBeTruthy()
    expect(files.queryByText(BID_FILE_NAME)).toBeNull()
    expect(screen.getAllByRole('button', { name: 'הורדה ל-Bambu Studio' })).toHaveLength(1)
  })

  it('model page of a needs-slicing folder: name, badge, create button, photos — no price panel', async () => {
    const services = createMemoryServices()
    const root = services.folderPointer.get() as string
    const folder = services.drive.addForeignFolder(root, 'Vase')
    services.drive.addForeignFile(folder, 'v.png', img(), 'image/png')
    renderApp(services, `/model/${folder}`)
    await screen.findByRole('heading', { name: 'Vase' })
    expect(screen.getByTestId('status-badge').textContent).toBe('דורש סלייס')
    expect(screen.getByRole('link', { name: 'צור הצעת מחיר' }).getAttribute('href')).toBe(`/model/${folder}/create`)
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'תמונות' })).getAllByRole('img')).toHaveLength(1))
    expect(screen.queryByTestId('price-panel')).toBeNull()
  })

  it('create from a folder without a sliced file: name prefilled, manual entry, saves into that folder', async () => {
    const user = userEvent.setup()
    const services = createMemoryServices()
    const root = services.folderPointer.get() as string
    const folder = services.drive.addForeignFolder(root, 'Vase')
    renderApp(services, `/model/${folder}/create`)
    expect(((await screen.findByLabelText(/^שם \*$/)) as HTMLInputElement).value).toBe('Vase')
    expect(screen.queryAllByTestId('part-row')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: /הוספת חלק ידנית/ }))
    const row = within(screen.getByTestId('part-row'))
    await user.type(row.getByLabelText('משקל'), '100')
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    await screen.findByRole('heading', { name: 'Vase' })
    expect(await services.drive.listChildren(folder, { name: BID_FILE_NAME })).toHaveLength(1)
  })

  it('N5: a stale index auto-refreshes once on open; a fresh one waits for "רענון ספרייה"', async () => {
    const user = userEvent.setup()
    const services = createMemoryServices()
    const drive = services.drive
    const root = services.folderPointer.get() as string

    await rebuildIndex(drive, root) // fresh
    drive.addForeignFolder(root, 'New in Drive')
    const view = renderApp(services, '/library')
    await screen.findByText('אין עדיין דגמים שמורים.')
    await user.click(screen.getByRole('button', { name: 'רענון ספרייה' }))
    expect((await screen.findByTestId('library-card')).textContent).toContain('New in Drive')
    view.unmount()

    await rebuildIndex(drive, root, new Date(Date.now() - 11 * 60_000)) // stale
    drive.addForeignFolder(root, 'Second')
    const spy = vi.spyOn(drive, 'listChildren')
    renderApp(services, '/library')
    await waitFor(() => expect(screen.getAllByTestId('library-card').map((c) => c.textContent).join()).toContain('Second'))
    // Exactly one automatic rebuild (one listing of the model folders).
    expect(spy.mock.calls.filter(([id, o]) => id === root && o?.foldersOnly)).toHaveLength(1)
  })
})
