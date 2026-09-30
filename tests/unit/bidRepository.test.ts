import { beforeEach, describe, expect, it } from 'vitest'
import { BID_FILE_NAME, defaultAppSettings, FOLDER_MIME, INDEX_FILE_NAME, SETTINGS_FILE_NAME, type Bid } from '../../src/lib/bid'
import {
  checkName,
  loadBid,
  loadLibrary,
  loadSettings,
  newSaveSession,
  rebuildIndex,
  saveNewBid,
  saveSettings,
  updateBid,
  type BidContent,
  type LocalFile,
} from '../../src/lib/drive/bidRepository'
import { MemoryDrive } from '../../src/lib/drive/memoryDrive'
import { computePrice, DEFAULT_PRICING_SETTINGS } from '../../src/lib/pricing'

function content(name: string, overrides: Partial<BidContent> = {}): BidContent {
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
    ...overrides,
  }
}

const file = (key: string, name: string, kind: LocalFile['kind'], mimeType = 'application/octet-stream'): LocalFile => ({
  key,
  name,
  kind,
  mimeType,
  blob: new Blob([name], { type: mimeType }),
})

let drive: MemoryDrive
let root: string

beforeEach(() => {
  drive = new MemoryDrive()
  root = drive.createRootFolder('models')
})

describe('settings file', () => {
  it('is created with defaults on first run and round-trips', async () => {
    const s = await loadSettings(drive, root)
    expect(s).toEqual(defaultAppSettings())
    expect((await drive.listChildren(root, { name: SETTINGS_FILE_NAME })).length).toBe(1)
    await saveSettings(drive, root, { ...s, pricing: { ...s.pricing, laborRate: 100 } })
    expect((await loadSettings(drive, root)).pricing.laborRate).toBe(100)
    expect((await drive.listChildren(root, { name: SETTINGS_FILE_NAME })).length).toBe(1)
  })
})

describe('saveNewBid (AC7)', () => {
  it('creates <models>/<name>/ with all files and writes bid.json last, then the index', async () => {
    const files = [
      file('a', 'photo.jpg', 'image', 'image/jpeg'),
      file('b', 'model.stl', 'model'),
      file('c', 'x.gcode.3mf', 'sliced'),
    ]
    const c = content('Stand', { parts: [{ name: 'p', qty: 1, grams: 55.94, hours: 2.5, source: '3mf', slicedLocalKey: 'c' }] })
    const { folderId, bid } = await saveNewBid(drive, root, { folderName: 'Stand', content: c, files }, newSaveSession())

    const folder = drive.all().find((n) => n.id === folderId)
    expect(folder).toMatchObject({ name: 'Stand', parentId: root, mimeType: FOLDER_MIME })
    const names = (await drive.listChildren(folderId)).map((f) => f.name)
    expect(names).toEqual(['photo.jpg', 'model.stl', 'x.gcode.3mf', BID_FILE_NAME])

    const uploads = drive.writeLog.filter((l) => !l.startsWith('folder:'))
    const bidIdx = uploads.indexOf(`upload:${BID_FILE_NAME}`)
    expect(bidIdx).toBe(3)
    expect(uploads.slice(bidIdx + 1).every((l) => l.includes(INDEX_FILE_NAME))).toBe(true)

    const stored = (await loadBid(drive, folderId)).bid
    expect(stored).toEqual(bid)
    expect(stored.files.map((f) => f.kind)).toEqual(['image', 'model', 'sliced'])
    expect(stored.coverFileId).toBe(stored.files[0].id)
    expect(stored.parts[0].slicedFileId).toBe(stored.files[2].id)
    expect(stored.parts[0]).not.toHaveProperty('slicedLocalKey')
    expect(stored.schemaVersion).toBe(2)

    const lib = await loadLibrary(drive, root)
    expect(lib).toHaveLength(1)
    expect(lib[0]).toMatchObject({ id: folderId, name: 'Stand', revision: 'V1', coverFileId: stored.coverFileId })
    expect(lib[0].price70).toBeCloseTo(83.369, 2)
  })

  it('retry after a failed upload reuses the folder and skips uploaded files', async () => {
    const files = [file('a', 'one.jpg', 'image', 'image/jpeg'), file('b', 'two.stl', 'model')]
    const session = newSaveSession()
    drive.failNext('uploadFile', (name) => name === 'two.stl')
    await expect(saveNewBid(drive, root, { folderName: 'M', content: content('M'), files }, session)).rejects.toThrow()

    // Not visible in the library: no bid.json yet.
    expect((await rebuildIndex(drive, root)).entries).toHaveLength(0)

    const { folderId } = await saveNewBid(drive, root, { folderName: 'M', content: content('M'), files }, session)
    expect(drive.all().filter((n) => n.mimeType === FOLDER_MIME && n.parentId === root)).toHaveLength(1)
    expect((await drive.listChildren(folderId)).map((f) => f.name)).toEqual(['one.jpg', 'two.stl', BID_FILE_NAME])
  })

  it('retry after bid.json was written (index failed) keeps one bid.json with the same id', async () => {
    const session = newSaveSession()
    drive.failNext('uploadFile', (name) => name === INDEX_FILE_NAME)
    await expect(saveNewBid(drive, root, { folderName: 'M', content: content('M'), files: [] }, session)).rejects.toThrow()
    const firstId = session.bidId
    const { folderId, bid } = await saveNewBid(drive, root, { folderName: 'M', content: content('M'), files: [] }, session)
    expect(bid.id).toBe(firstId)
    expect(await drive.listChildren(folderId, { name: BID_FILE_NAME })).toHaveLength(1)
  })
})

describe('checkName (AC8)', () => {
  it('free name → not taken', async () => {
    expect((await checkName(drive, root, 'New')).taken).toBe(false)
  })

  it('existing name → taken, suggests V2 then V3', async () => {
    await saveNewBid(drive, root, { folderName: 'Stand', content: content('Stand'), files: [] }, newSaveSession())
    const c1 = await checkName(drive, root, 'Stand')
    expect(c1).toEqual({ taken: true, nextRevision: { folderName: 'Stand V2', revision: 'V2' } })
    await saveNewBid(drive, root, { folderName: 'Stand V2', content: content('Stand', { revision: 'V2' }), files: [] }, newSaveSession())
    expect((await checkName(drive, root, ' stand ')).nextRevision).toEqual({ folderName: 'stand V3', revision: 'V3' })
    // Original bid untouched.
    const lib = await loadLibrary(drive, root)
    expect(lib.map((e) => e.revision).sort()).toEqual(['V1', 'V2'])
  })
})

describe('library index (AC9)', () => {
  it('rebuild ignores folders without bid.json and sorts newest first', async () => {
    await saveNewBid(drive, root, { folderName: 'Old', content: content('Old'), files: [], now: new Date('2026-01-01') }, newSaveSession())
    await saveNewBid(drive, root, { folderName: 'New', content: content('New'), files: [], now: new Date('2026-06-01') }, newSaveSession())
    const orphan = await drive.createFolder(root, 'Half-saved')
    await drive.uploadFile(orphan.id, 'photo.jpg', new Blob(['x']), 'image/jpeg')

    const r = await rebuildIndex(drive, root)
    expect(r.entries.map((e) => e.name)).toEqual(['New', 'Old'])
    expect(r.skipped).toEqual([])
  })

  it('loadLibrary rebuilds when the index file is missing', async () => {
    const saved = await saveNewBid(drive, root, { folderName: 'A', content: content('A'), files: [] }, newSaveSession())
    const fresh = new MemoryDrive()
    // Simulate an index-less folder by copying only the bid into a new drive.
    const r2 = fresh.createRootFolder('models')
    const f = await fresh.createFolder(r2, 'A')
    await fresh.uploadFile(f.id, BID_FILE_NAME, new Blob([JSON.stringify(saved.bid)]), 'application/json')
    const lib = await loadLibrary(fresh, r2)
    expect(lib.map((e) => e.name)).toEqual(['A'])
    expect(await fresh.listChildren(r2, { name: INDEX_FILE_NAME })).toHaveLength(1)
  })

  it('skips folders whose bid.json is corrupt', async () => {
    const f = await drive.createFolder(root, 'Broken')
    await drive.uploadFile(f.id, BID_FILE_NAME, new Blob(['{not json']), 'application/json')
    const r = await rebuildIndex(drive, root)
    expect(r.entries).toEqual([])
    expect(r.skipped).toEqual(['Broken'])
  })
})

describe('updateBid (edit flow, AC11)', () => {
  it('keeps id/createdAt/snapshot, adds new files, updates index', async () => {
    const { folderId, bid } = await saveNewBid(
      drive,
      root,
      { folderName: 'E', content: content('E'), files: [file('a', 'a.jpg', 'image', 'image/jpeg')], now: new Date('2026-01-01') },
      newSaveSession(),
    )
    // Settings change after the bid was saved.
    await saveSettings(drive, root, { ...defaultAppSettings(), pricing: { ...DEFAULT_PRICING_SETTINGS, laborRate: 200 } })
    const reloaded: Bid = (await loadBid(drive, folderId)).bid
    expect(reloaded.settingsSnapshot.laborRate).toBe(80)
    expect(reloaded.result).toEqual(bid.result)

    const updated = await updateBid(
      drive,
      root,
      {
        folderId,
        existing: reloaded,
        content: { ...content('E renamed'), settingsSnapshot: reloaded.settingsSnapshot },
        newFiles: [file('b', 'b.stl', 'model')],
        now: new Date('2026-02-01'),
      },
      newSaveSession(),
    )
    expect(updated.id).toBe(bid.id)
    expect(updated.createdAt).toBe(bid.createdAt)
    expect(updated.updatedAt).toBe(new Date('2026-02-01').toISOString())
    expect(updated.settingsSnapshot.laborRate).toBe(80)
    expect(updated.files.map((f) => f.name)).toEqual(['a.jpg', 'b.stl'])
    expect(await drive.listChildren(folderId, { name: BID_FILE_NAME })).toHaveLength(1)
    const lib = await loadLibrary(drive, root)
    expect(lib).toHaveLength(1)
    expect(lib[0].name).toBe('E renamed')
  })
})

describe('robust index handling', () => {
  it('a corrupt index (invalid JSON) is rebuilt instead of failing the save', async () => {
    await saveNewBid(drive, root, { folderName: 'A', content: content('A'), files: [] }, newSaveSession())
    const idx = (await drive.listChildren(root, { name: INDEX_FILE_NAME }))[0]
    await drive.updateFileContent(idx.id, new Blob(['{broken']), 'application/json')

    const { folderId } = await saveNewBid(drive, root, { folderName: 'B', content: content('B'), files: [] }, newSaveSession())
    expect(folderId).toBeTruthy()
    const lib = await loadLibrary(drive, root)
    expect(lib.map((e) => e.name).sort()).toEqual(['A', 'B'])
    expect(await drive.listChildren(root, { name: INDEX_FILE_NAME })).toHaveLength(1)
  })

  it('loadLibrary with a corrupt index rebuilds it', async () => {
    await saveNewBid(drive, root, { folderName: 'A', content: content('A'), files: [] }, newSaveSession())
    const idx = (await drive.listChildren(root, { name: INDEX_FILE_NAME }))[0]
    await drive.updateFileContent(idx.id, new Blob(['not json']), 'application/json')
    expect((await loadLibrary(drive, root)).map((e) => e.name)).toEqual(['A'])
  })

  it('rebuildIndex rethrows Drive errors and does not write a partial index', async () => {
    await saveNewBid(drive, root, { folderName: 'A', content: content('A'), files: [] }, newSaveSession())
    await saveNewBid(drive, root, { folderName: 'B', content: content('B'), files: [] }, newSaveSession())
    const bFolder = (await drive.listChildren(root, { name: 'B' }))[0]
    const bBid = (await drive.listChildren(bFolder.id, { name: BID_FILE_NAME }))[0]
    const writesBefore = drive.writeLog.length

    drive.failNext('readText', (id) => id === bBid.id)
    await expect(rebuildIndex(drive, root)).rejects.toThrow(/simulated failure/)
    expect(drive.writeLog.length).toBe(writesBefore) // index untouched
    expect((await loadLibrary(drive, root)).map((e) => e.name).sort()).toEqual(['A', 'B'])
  })

  it('rebuildIndex still skips (not throws on) bid.json that fails isBid', async () => {
    const f = await drive.createFolder(root, 'Weird')
    await drive.uploadFile(f.id, BID_FILE_NAME, new Blob(['{"hello":1}']), 'application/json')
    const r = await rebuildIndex(drive, root)
    expect(r.skipped).toEqual(['Weird'])
  })
})

describe('checkName with excludeFolderId (edit rename)', () => {
  it("ignores the edited bid's own folder/entry but still sees other bids", async () => {
    const a = await saveNewBid(drive, root, { folderName: 'A', content: content('A'), files: [] }, newSaveSession())
    await saveNewBid(drive, root, { folderName: 'B', content: content('B'), files: [] }, newSaveSession())
    expect((await checkName(drive, root, 'A', a.folderId)).taken).toBe(false)
    expect((await checkName(drive, root, 'b', a.folderId)).taken).toBe(true)
    expect((await checkName(drive, root, 'C', a.folderId)).taken).toBe(false)
  })
})
