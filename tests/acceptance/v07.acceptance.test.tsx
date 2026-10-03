/**
 * Addendum v0.7 (Founder decision, 3 Oct 2026) — "remove from library" = archive (no Drive deletion). AC39–AC41.
 *
 * Outside-in: the whole App on the in-memory Drive (createMemoryServices). The Founder's own folders/files and pre-v0.4
 * app files are simulated with addForeignFolder / addForeignFile / addLegacyAppFile; bid.json files are literal JSON in
 * the brief §4 schema (v05-fixtures.bidJson).
 *
 * "No other Drive change" (AC39, COO clarification of 3 Oct): archiving/restoring may write ONLY
 *   - priced (marked bid.json): that bid.json (update, marker kept);
 *   - needs-slicing / pre-v0.4: `<folder>/_rubedo-model.json` (create on first archive, update afterwards);
 *   - plus the `_rubedo-index.json` cache in the models folder (create or update).
 * Every other node must keep its id, name, parent, mime type, version and bytes. The memory drive has no
 * delete/trash/move/rename operation at all, so "nothing disappeared and nothing moved" is checked by the snapshot.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { navLink, newServices, renderApp, setValue, type MemServices } from './helpers'
import { bidJson, memoryQuoteModel, MODEL_NAME, PNG_BYTES } from './v05-fixtures'

type Drive = MemServices['drive']
type User = ReturnType<typeof userEvent.setup>

const ARCHIVE = 'הסר מהספרייה'
const RESTORE = 'שחזר לספרייה'
const BANNER = 'המודל בארכיון'
const CONFIRM_TEXT = 'המודל יוסתר מהספרייה. הקבצים נשארים ב-Drive ואפשר לשחזר מהארכיון.'
const META = '_rubedo-model.json'
const INDEX = '_rubedo-index.json'
const CUSTOMERS_FILE = '_rubedo-customers.json'

beforeEach(() => {
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:mock-${++n}`)
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  delete (URL as { createObjectURL?: unknown }).createObjectURL
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
  localStorage.clear()
  vi.restoreAllMocks()
})

// ---------- Drive fixtures ----------

async function uploadJson(drive: Drive, parent: string, name: string, value: unknown) {
  return drive.uploadFile(parent, name, new Blob([JSON.stringify(value)], { type: 'application/json' }), 'application/json')
}

function png(): Blob {
  return new Blob([PNG_BYTES], { type: 'image/png' })
}

/** A priced model (app-created folder, marked bid.json) with one photo. */
async function pricedModel(drive: Drive, root: string, name: string, grams = 100) {
  const folder = await drive.createFolder(root, name)
  const a = await drive.uploadFile(folder.id, 'a.png', png(), 'image/png')
  const bid = bidJson({
    schemaVersion: 2,
    name,
    description: `תיאור ${name}`,
    grams,
    hours: 3.5,
    laborMinutes: 10,
    hardware: [{ name: 'Magnet', qty: 2, unitCost: 1.5, included: true }],
    coverFileId: a.id,
    files: [{ id: a.id, name: 'a.png', kind: 'image', mimeType: 'image/png' }],
  })
  const bidFile = await uploadJson(drive, folder.id, 'bid.json', bid)
  return { folderId: folder.id, bid, bidFileId: bidFile.id }
}

/** A folder the Founder made himself (no bid.json) with two photos. */
function needsSlicingFolder(drive: Drive, root: string, name: string) {
  const folder = drive.addForeignFolder(root, name)
  const x = drive.addForeignFile(folder, 'x.jpg', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: 'image/jpeg' }), 'image/jpeg')
  const y = drive.addForeignFile(folder, 'y.jpg', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 2])], { type: 'image/jpeg' }), 'image/jpeg')
  return { folderId: folder, xId: x, yId: y }
}

/** A model saved before v0.4: foreign folder + unmarked (legacy) bid.json. */
function legacyModel(drive: Drive, root: string, name: string) {
  const folder = drive.addForeignFolder(root, name)
  const photo = drive.addLegacyAppFile(folder, 'owl.jpg', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 3])], { type: 'image/jpeg' }), 'image/jpeg')
  const bid = bidJson({ schemaVersion: 1, name, grams: 60, hours: 2, laborMinutes: 30, hardware: [{ name: 'LED', qty: 1, unitCost: 12 }], coverFileId: photo }, `legacy-${name}`)
  const text = JSON.stringify(bid)
  const bidFileId = drive.addLegacyAppFile(folder, 'bid.json', new Blob([text], { type: 'application/json' }), 'application/json')
  return { folderId: folder, bidFileId, bid, text }
}

async function markedBids(drive: Drive, folderId: string) {
  return (await drive.listChildren(folderId, { name: 'bid.json' })).filter((f) => f.appCreated === true)
}

async function readBid(drive: Drive, fileId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await drive.readText(fileId))
}

async function metaFiles(drive: Drive, folderId: string) {
  return drive.listChildren(folderId, { name: META })
}

// ---------- "no other Drive change" ----------

interface NodeState {
  id: string
  name: string
  parentId: string | null
  mimeType: string
  version: string | undefined
  appCreated: boolean | undefined
  bytes: string
}

async function driveSnapshot(drive: Drive): Promise<Map<string, NodeState>> {
  const out = new Map<string, NodeState>()
  for (const n of drive.all()) {
    let bytes = ''
    if (n.mimeType !== 'application/vnd.google-apps.folder') {
      try {
        bytes = Array.from(new Uint8Array(await (await drive.readBlob(n.id)).arrayBuffer())).join(',')
      } catch {
        bytes = '<no data>'
      }
    }
    out.set(n.id, { id: n.id, name: n.name, parentId: n.parentId, mimeType: n.mimeType, version: n.version, appCreated: n.appCreated, bytes })
  }
  return out
}

/**
 * Asserts that between `before` and now the ONLY changes are: `allowedFileIds` / new files named `allowedNew[parent]`
 * were written (created or content-updated, keeping the app marker), and the index cache in `root`. Returns the ids of
 * the nodes that changed or appeared.
 */
async function expectOnlyChanges(
  drive: Drive,
  before: Map<string, NodeState>,
  o: { root: string; allowedFileIds: string[]; allowedNew: { parentId: string; name: string }[] },
) {
  const after = await driveSnapshot(drive)
  const changed: string[] = []
  // Nothing disappeared, moved or was renamed.
  for (const [id, b] of before) {
    const a = after.get(id)
    expect(a, `node ${b.name} (${id}) still exists`).toBeDefined()
    expect({ name: a!.name, parentId: a!.parentId, mimeType: a!.mimeType }, `node ${b.name} not moved/renamed`).toEqual({
      name: b.name,
      parentId: b.parentId,
      mimeType: b.mimeType,
    })
    expect(a!.appCreated, `marker of ${b.name} unchanged`).toBe(b.appCreated)
    if (a!.bytes !== b.bytes || a!.version !== b.version) {
      changed.push(id)
      const isIndex = b.name === INDEX && b.parentId === o.root
      expect(isIndex || o.allowedFileIds.includes(id), `unexpected content change of ${b.name} (${id})`).toBe(true)
    }
  }
  for (const [id, a] of after) {
    if (before.has(id)) continue
    changed.push(id)
    const isIndex = a.name === INDEX && a.parentId === o.root
    const allowed = isIndex || o.allowedNew.some((x) => x.parentId === a.parentId && x.name === a.name)
    expect(allowed, `unexpected new node ${a.name} in ${a.parentId}`).toBe(true)
    expect(a.appCreated, `new ${a.name} carries the app marker`).toBe(true)
  }
  return changed
}

// ---------- UI helpers ----------

function cardNames(): string[] {
  return screen.queryAllByTestId('library-card').map((c) => (c.querySelector('span.font-semibold')?.textContent ?? '').trim())
}

function card(name: string): HTMLElement {
  const c = screen.getAllByTestId('library-card').find((x) => (x.textContent ?? '').includes(name))
  if (!c) throw new Error(`no library card for ${name}`)
  return c
}

function hasCard(name: string): boolean {
  return screen.queryAllByTestId('library-card').some((x) => (x.textContent ?? '').includes(name))
}

function archiveLink(): HTMLElement {
  return screen.getByRole('link', { name: /^ארכיון \(\d+\)$/ })
}

function archiveCount(): number {
  return Number(/\((\d+)\)/.exec(archiveLink().textContent ?? '')?.[1])
}

function searchBox(): HTMLElement {
  return screen.getByRole('searchbox')
}

function renderAgain(services: MemServices, path: string) {
  cleanup()
  renderApp(services, path)
}

async function openLibrary(services: MemServices, path = '/library') {
  renderAgain(services, path)
  await waitFor(() => expect(screen.queryAllByTestId('library-card').length + screen.queryAllByText(/אין דגמים בארכיון|כל הדגמים בארכיון|אין עדיין/).length).toBeGreaterThan(0))
  // Let the auto-refresh of a stale index settle.
  await waitFor(() => expect(screen.queryByText('טוען ספרייה…')).toBeNull())
}

async function openModel(services: MemServices, folderId: string, title: string) {
  renderAgain(services, `/model/${folderId}`)
  await screen.findByRole('heading', { level: 1, name: title }, { timeout: 4000 })
}

function archiveButton(): HTMLElement {
  return screen.getByRole('button', { name: ARCHIVE })
}

/** Clicks "הסר מהספרייה", checks the dialog, confirms, and waits for the archived banner. */
async function archiveViaUi(user: User) {
  await user.click(archiveButton())
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain(CONFIRM_TEXT)
  await user.click(within(dialog).getByRole('button', { name: ARCHIVE }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await screen.findByTestId('archived-banner', {}, { timeout: 4000 })
}

function isoDate(v: unknown): boolean {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v))
}

function without(o: Record<string, unknown>, ...keys: string[]) {
  const c = { ...o }
  for (const k of keys) delete c[k]
  return c
}

// =============================================================================================
describe('AC39 — archiving writes only the model\'s bid.json (priced) / _rubedo-model.json (needs-slicing, pre-v0.4); card leaves the library and appears under the archive; no other Drive change', () => {
  it('AC39.priced: "הסר מהספרייה" → confirm → archived/archivedAt in the SAME marked bid.json (marker kept); only it + the index are written; card moves from the library to "ארכיון (1)"', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const lamp = await pricedModel(drive, root, 'Lamp')
    const vase = await pricedModel(drive, root, 'Vase', 50)
    const vaseBidText = await drive.readText(vase.bidFileId)

    await openLibrary(services)
    await waitFor(() => expect(hasCard('Lamp') && hasCard('Vase')).toBe(true))
    expect(archiveCount()).toBe(0)

    await user.click(card('Lamp'))
    await screen.findByRole('heading', { level: 1, name: 'Lamp' })
    const before = await driveSnapshot(drive)
    const logStart = drive.writeLog.length

    await archiveViaUi(user)

    // Only bid.json (update) and the index were written.
    for (const w of drive.writeLog.slice(logStart)) expect(w).toMatch(/^(update:bid\.json|(upload|update):_rubedo-index\.json)$/)
    expect(drive.writeLog.slice(logStart)).toContain('update:bid.json')
    const changed = await expectOnlyChanges(drive, before, { root, allowedFileIds: [lamp.bidFileId], allowedNew: [] })
    expect(changed).toContain(lamp.bidFileId)

    const marked = await markedBids(drive, lamp.folderId)
    expect(marked.map((f) => f.id), 'same single marked bid.json').toEqual([lamp.bidFileId])
    const saved = await readBid(drive, lamp.bidFileId)
    expect(saved.archived).toBe(true)
    expect(isoDate(saved.archivedAt)).toBe(true)
    // Nothing else in the bid changed.
    expect(without(saved, 'archived', 'archivedAt', 'updatedAt')).toEqual(without(lamp.bid, 'updatedAt'))
    expect(await drive.readText(vase.bidFileId)).toBe(vaseBidText)
    expect(await metaFiles(drive, lamp.folderId)).toHaveLength(0)

    // Library: gone from the main view, archive count 1, shown under the archive.
    await user.click(navLink('ספרייה'))
    await waitFor(() => expect(hasCard('Vase')).toBe(true))
    expect(hasCard('Lamp')).toBe(false)
    expect(archiveCount()).toBe(1)
    expect(archiveLink().getAttribute('href')).toBe('/library?view=archive')
    await user.click(archiveLink())
    await screen.findByRole('heading', { level: 1, name: 'ארכיון' })
    await waitFor(() => expect(hasCard('Lamp')).toBe(true))
    expect(hasCard('Vase')).toBe(false)
    expect(within(card('Lamp').closest('li')!).getByRole('button', { name: new RegExp(RESTORE) })).toBeTruthy()

    // The archive state survives a fresh load (index + bid.json), both by URL and in the main view.
    await openLibrary(services, '/library?view=archive')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ארכיון')
    expect(cardNames()).toEqual(['Lamp'])
    await openLibrary(services, '/library')
    expect(cardNames()).toEqual(['Vase'])
    expect(archiveCount()).toBe(1)
  })

  it('AC39.needs-slicing: archiving a Founder folder without bid.json CREATES only a marked _rubedo-model.json {archived:true, archivedAt}; no bid.json; the Founder\'s files untouched; card moves to the archive', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const owl = needsSlicingFolder(drive, root, 'Owl lamp')
    await pricedModel(drive, root, 'Vase', 50)

    await openLibrary(services)
    await waitFor(() => expect(hasCard('Owl lamp') && hasCard('Vase')).toBe(true))
    await openModel(services, owl.folderId, 'Owl lamp')
    const before = await driveSnapshot(drive)
    const logStart = drive.writeLog.length

    await archiveViaUi(user)

    for (const w of drive.writeLog.slice(logStart)) expect(w).toMatch(/^(upload|update):(_rubedo-model\.json|_rubedo-index\.json)$/)
    await expectOnlyChanges(drive, before, { root, allowedFileIds: [], allowedNew: [{ parentId: owl.folderId, name: META }] })
    const metas = await metaFiles(drive, owl.folderId)
    expect(metas).toHaveLength(1)
    expect(metas[0].appCreated).toBe(true)
    const meta = JSON.parse(await drive.readText(metas[0].id))
    expect(meta.archived).toBe(true)
    expect(isoDate(meta.archivedAt)).toBe(true)
    expect(await drive.listChildren(owl.folderId, { name: 'bid.json' })).toHaveLength(0)

    await openLibrary(services)
    await waitFor(() => expect(hasCard('Vase')).toBe(true))
    expect(hasCard('Owl lamp')).toBe(false)
    expect(archiveCount()).toBe(1)
    await openLibrary(services, '/library?view=archive')
    expect(cardNames()).toEqual(['Owl lamp'])
  })

  it('AC39.needs-slicing (existing meta): a folder that already has _rubedo-model.json (cover + description) — archive UPDATES that same file, keeping cover and description', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const owl = needsSlicingFolder(drive, root, 'Owl lamp')
    const existing = await uploadJson(drive, owl.folderId, META, { schemaVersion: 1, coverFileId: owl.yId, description: 'ינשוף', updatedAt: '2026-10-01T10:00:00.000Z' })

    await openModel(services, owl.folderId, 'Owl lamp')
    const before = await driveSnapshot(drive)
    await archiveViaUi(user)
    await expectOnlyChanges(drive, before, { root, allowedFileIds: [existing.id], allowedNew: [] })
    const metas = await metaFiles(drive, owl.folderId)
    expect(metas.map((m) => m.id)).toEqual([existing.id])
    const meta = JSON.parse(await drive.readText(existing.id))
    expect(meta).toMatchObject({ coverFileId: owl.yId, description: 'ינשוף', archived: true })
    expect(isoDate(meta.archivedAt)).toBe(true)
  })

  it('AC39.pre-v0.4: archiving a legacy (unmarked) bid writes only a marked _rubedo-model.json; the old bid.json is byte-identical and never written; card moves to the archive', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const old = legacyModel(drive, root, 'Old Owl')
    await pricedModel(drive, root, 'Vase', 50)

    await openModel(services, old.folderId, 'Old Owl')
    expect(screen.getByTestId('legacy-bid-notice')).toBeTruthy()
    const before = await driveSnapshot(drive)
    const logStart = drive.writeLog.length

    await archiveViaUi(user)

    expect(drive.writeLog.slice(logStart).filter((w) => /bid\.json/.test(w))).toEqual([])
    for (const w of drive.writeLog.slice(logStart)) expect(w).toMatch(/^(upload|update):(_rubedo-model\.json|_rubedo-index\.json)$/)
    await expectOnlyChanges(drive, before, { root, allowedFileIds: [], allowedNew: [{ parentId: old.folderId, name: META }] })
    expect(await drive.readText(old.bidFileId)).toBe(old.text)
    expect(await markedBids(drive, old.folderId)).toHaveLength(0)
    const metas = await metaFiles(drive, old.folderId)
    expect(metas).toHaveLength(1)
    expect(metas[0].appCreated).toBe(true)
    expect(JSON.parse(await drive.readText(metas[0].id)).archived).toBe(true)

    await openLibrary(services)
    await waitFor(() => expect(hasCard('Vase')).toBe(true))
    expect(hasCard('Old Owl')).toBe(false)
    await openLibrary(services, '/library?view=archive')
    expect(cardNames()).toEqual(['Old Owl'])
  })

  it('AC39.search (A2): search filters within the current view — main library and archive', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const lamp = await pricedModel(drive, root, 'Lamp')
    await pricedModel(drive, root, 'Lamp shade', 40)
    await pricedModel(drive, root, 'Vase', 50)
    const owl = needsSlicingFolder(drive, root, 'Owl lamp')

    await openModel(services, lamp.folderId, 'Lamp')
    await archiveViaUi(user)
    await openModel(services, owl.folderId, 'Owl lamp')
    await archiveViaUi(user)

    await openLibrary(services)
    await waitFor(() => expect(cardNames().sort()).toEqual(['Lamp shade', 'Vase']))
    setValue(searchBox(), 'lamp')
    expect(cardNames()).toEqual(['Lamp shade'])
    setValue(searchBox(), 'owl')
    expect(cardNames()).toEqual([])

    await openLibrary(services, '/library?view=archive')
    expect(cardNames().sort()).toEqual(['Lamp', 'Owl lamp'])
    setValue(searchBox(), 'owl')
    expect(cardNames()).toEqual(['Owl lamp'])
    setValue(searchBox(), 'vase')
    expect(cardNames()).toEqual([])
    setValue(searchBox(), 'LAMP')
    expect(cardNames().sort()).toEqual(['Lamp', 'Owl lamp'])
  })

  it('AC39.dialog: the confirm is an accessible modal (role=dialog, aria-modal, named, described by the brief text, focus inside); Escape and "ביטול" cancel with NO write; focus returns to the button', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const lamp = await pricedModel(drive, root, 'Lamp')
    const owl = needsSlicingFolder(drive, root, 'Owl lamp')

    for (const target of [
      { folderId: lamp.folderId, title: 'Lamp' },
      { folderId: owl.folderId, title: 'Owl lamp' },
    ]) {
      await openModel(services, target.folderId, target.title)
      const before = await driveSnapshot(drive)
      const logStart = drive.writeLog.length

      // Escape
      const opener = archiveButton()
      await user.click(opener)
      const dialog = await screen.findByRole('dialog')
      expect(dialog.getAttribute('aria-modal')).toBe('true')
      const labelledBy = dialog.getAttribute('aria-labelledby')
      const label = dialog.getAttribute('aria-label') ?? (labelledBy ? document.getElementById(labelledBy)?.textContent : '')
      expect((label ?? '').trim().length, `${target.title}: dialog has an accessible name`).toBeGreaterThan(0)
      const describedBy = dialog.getAttribute('aria-describedby')
      expect(describedBy, `${target.title}: dialog is described by its message`).toBeTruthy()
      expect(document.getElementById(describedBy!)?.textContent).toBe(CONFIRM_TEXT)
      expect(dialog.contains(document.activeElement), `${target.title}: focus moved into the dialog`).toBe(true)
      expect(within(dialog).getByRole('button', { name: ARCHIVE })).toBeTruthy()
      expect(within(dialog).getByRole('button', { name: 'ביטול' })).toBeTruthy()
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(document.activeElement, `${target.title}: focus back on "${ARCHIVE}"`).toBe(archiveButton())
      await new Promise((r) => setTimeout(r, 50))
      expect(drive.writeLog.slice(logStart), `${target.title}: Escape writes nothing`).toEqual([])
      expect(screen.queryByTestId('archived-banner')).toBeNull()

      // "ביטול"
      await user.click(archiveButton())
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'ביטול' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await new Promise((r) => setTimeout(r, 50))
      expect(drive.writeLog.slice(logStart), `${target.title}: cancel writes nothing`).toEqual([])
      await expectOnlyChanges(drive, before, { root, allowedFileIds: [], allowedNew: [] })
    }

    // Escape dispatched at the document level (not via userEvent focus) also cancels.
    await openModel(services, lamp.folderId, 'Lamp')
    const logStart = drive.writeLog.length
    await user.click(archiveButton())
    await screen.findByRole('dialog')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await new Promise((r) => setTimeout(r, 50))
    expect(drive.writeLog.slice(logStart)).toEqual([])
    expect((await readBid(drive, lamp.bidFileId)).archived).toBeUndefined()
  })
})

// =============================================================================================
describe('AC40 — restore brings the model back; data identical apart from archived/archivedAt/updatedAt', () => {
  it('AC40.priced (from the archive view): "שחזר לספרייה" → card back in the main library; bid.json identical apart from archived/archivedAt/updatedAt; only bid.json + index written', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const lamp = await pricedModel(drive, root, 'Lamp')
    await pricedModel(drive, root, 'Vase', 50)

    await openModel(services, lamp.folderId, 'Lamp')
    await archiveViaUi(user)

    await openLibrary(services, '/library?view=archive')
    expect(cardNames()).toEqual(['Lamp'])
    const before = await driveSnapshot(drive)
    const logStart = drive.writeLog.length
    await user.click(within(card('Lamp').closest('li')!).getByRole('button', { name: new RegExp(RESTORE) }))
    await waitFor(() => expect(hasCard('Lamp')).toBe(false))

    for (const w of drive.writeLog.slice(logStart)) expect(w).toMatch(/^(update:bid\.json|(upload|update):_rubedo-index\.json)$/)
    await expectOnlyChanges(drive, before, { root, allowedFileIds: [lamp.bidFileId], allowedNew: [] })
    expect((await markedBids(drive, lamp.folderId)).map((f) => f.id)).toEqual([lamp.bidFileId])
    const restored = await readBid(drive, lamp.bidFileId)
    expect(restored.archived === true).toBe(false)
    expect(without(restored, 'archived', 'archivedAt', 'updatedAt')).toEqual(without(lamp.bid, 'updatedAt'))

    await user.click(screen.getByRole('link', { name: 'חזרה לספרייה' }))
    await waitFor(() => expect(cardNames().sort()).toEqual(['Lamp', 'Vase']))
    expect(archiveCount()).toBe(0)
    // Fresh load agrees.
    await openLibrary(services)
    expect(cardNames().sort()).toEqual(['Lamp', 'Vase'])
    expect(archiveCount()).toBe(0)
    await openModel(services, lamp.folderId, 'Lamp')
    expect(screen.queryByTestId('archived-banner')).toBeNull()
    expect(archiveButton()).toBeTruthy()
  })

  it('AC40.needs-slicing (from the model page banner): restore rewrites only the same _rubedo-model.json; folder back in the library; archive again reuses that file', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const owl = needsSlicingFolder(drive, root, 'Owl lamp')

    await openModel(services, owl.folderId, 'Owl lamp')
    await archiveViaUi(user)
    const [metaFile] = await metaFiles(drive, owl.folderId)
    const archivedMeta = JSON.parse(await drive.readText(metaFile.id))

    const before = await driveSnapshot(drive)
    const banner = screen.getByTestId('archived-banner')
    await user.click(within(banner).getByRole('button', { name: RESTORE }))
    await waitFor(() => expect(screen.queryByTestId('archived-banner')).toBeNull())
    expect(archiveButton()).toBeTruthy()
    await expectOnlyChanges(drive, before, { root, allowedFileIds: [metaFile.id], allowedNew: [] })
    expect((await metaFiles(drive, owl.folderId)).map((f) => f.id)).toEqual([metaFile.id])
    const restoredMeta = JSON.parse(await drive.readText(metaFile.id))
    expect(restoredMeta.archived === true).toBe(false)
    expect(without(restoredMeta, 'archived', 'archivedAt', 'updatedAt')).toEqual(without(archivedMeta, 'archived', 'archivedAt', 'updatedAt'))

    await openLibrary(services)
    await waitFor(() => expect(cardNames()).toEqual(['Owl lamp']))
    expect(archiveCount()).toBe(0)

    // Archive again → same meta file updated, no second file.
    await openModel(services, owl.folderId, 'Owl lamp')
    await archiveViaUi(user)
    expect((await metaFiles(drive, owl.folderId)).map((f) => f.id)).toEqual([metaFile.id])
  })

  it('AC40.pre-v0.4: restore of a legacy bid touches only _rubedo-model.json; the old bid.json stays byte-identical; model back in the library', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const old = legacyModel(drive, root, 'Old Owl')

    await openModel(services, old.folderId, 'Old Owl')
    await archiveViaUi(user)
    await openLibrary(services, '/library?view=archive')
    expect(cardNames()).toEqual(['Old Owl'])
    const [metaFile] = await metaFiles(drive, old.folderId)
    const before = await driveSnapshot(drive)
    await user.click(within(card('Old Owl').closest('li')!).getByRole('button', { name: new RegExp(RESTORE) }))
    await waitFor(() => expect(hasCard('Old Owl')).toBe(false))
    await expectOnlyChanges(drive, before, { root, allowedFileIds: [metaFile.id], allowedNew: [] })
    expect(await drive.readText(old.bidFileId)).toBe(old.text)
    expect(JSON.parse(await drive.readText(metaFile.id)).archived === true).toBe(false)
    await openLibrary(services)
    expect(cardNames()).toEqual(['Old Owl'])
  })

  it('AC40.direct-open (A3): opening an archived model\'s page directly works — content shown, banner "המודל בארכיון" with restore, no "הסר מהספרייה"', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const lamp = await pricedModel(drive, root, 'Lamp')
    const owl = needsSlicingFolder(drive, root, 'Owl lamp')
    const old = legacyModel(drive, root, 'Old Owl')
    for (const t of [
      { id: lamp.folderId, title: 'Lamp' },
      { id: owl.folderId, title: 'Owl lamp' },
      { id: old.folderId, title: 'Old Owl' },
    ]) {
      await openModel(services, t.id, t.title)
      await archiveViaUi(user)
    }

    // Fresh render straight to each URL.
    renderAgain(services, `/model/${lamp.folderId}`)
    await screen.findByRole('heading', { level: 1, name: 'Lamp' }, { timeout: 4000 })
    let banner = await screen.findByTestId('archived-banner')
    expect(banner.textContent).toContain(BANNER)
    expect(within(banner).getByRole('button', { name: RESTORE })).toBeTruthy()
    expect(screen.queryByRole('button', { name: ARCHIVE })).toBeNull()
    expect(screen.getByTestId('price-panel')).toBeTruthy()
    expect(screen.getByText('תיאור Lamp')).toBeTruthy()

    renderAgain(services, `/model/${owl.folderId}`)
    await screen.findByRole('heading', { level: 1, name: 'Owl lamp' }, { timeout: 4000 })
    banner = await screen.findByTestId('archived-banner')
    expect(banner.textContent).toContain(BANNER)
    expect(within(banner).getByRole('button', { name: RESTORE })).toBeTruthy()
    expect(screen.queryByRole('button', { name: ARCHIVE })).toBeNull()

    renderAgain(services, `/model/${old.folderId}`)
    await screen.findByRole('heading', { level: 1, name: 'Old Owl' }, { timeout: 4000 })
    banner = await screen.findByTestId('archived-banner')
    expect(banner.textContent).toContain(BANNER)
    expect(screen.getByTestId('legacy-bid-notice')).toBeTruthy()
    expect(screen.queryByRole('button', { name: ARCHIVE })).toBeNull()
  })
})

// =============================================================================================
describe('AC41 — archived models are absent from the customer page\'s "new quote" chooser; their quotes stay on customer pages', () => {
  const NOW = '2026-09-01T10:00:00.000Z'
  const SEED = [{ id: 'cust-dana-0001', name: 'דנה כהן', email: 'dana@example.com', createdAt: NOW, updatedAt: NOW }]

  function log(o: { date: string; model: string; price: number }) {
    return {
      schemaVersion: 1,
      date: o.date,
      draftId: `draft-${o.date}`,
      model: { bidId: `bid-${o.model}`, name: o.model, revision: 'V1' },
      customer: { name: 'דנה כהן', email: 'dana@example.com' },
      includedHardware: [],
      priceShown: o.price,
      landed: 10,
      price70: 33.33,
      savedBid: { landed: 10, price70: 33.33 },
      attachments: [],
      customerId: 'cust-dana-0001',
    }
  }

  it('AC41: after archiving "Owl lamp" (priced) and "Old Owl" (pre-v0.4), Dana\'s page still lists both quotes with their links, and the chooser offers only RootLab; after restore Owl lamp is offered again', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    await uploadJson(drive, root, CUSTOMERS_FILE, SEED)
    const a = await memoryQuoteModel(services, root)
    const owl = await pricedModel(drive, root, 'Owl lamp', 50)
    const old = legacyModel(drive, root, 'Old Owl')
    const qa = await drive.createFolder(a.folderId, 'quotes')
    const qb = await drive.createFolder(owl.folderId, 'quotes')
    await uploadJson(drive, qa.id, 'quote-20260920-1000.json', log({ date: '2026-09-20T10:00:00.000Z', model: MODEL_NAME, price: 101 }))
    await uploadJson(drive, qb.id, 'quote-20261001-0900.json', log({ date: '2026-10-01T09:00:00.000Z', model: 'Owl lamp', price: 77 }))

    // Before archiving, the chooser offers all three priced models.
    renderAgain(services, '/customers/cust-dana-0001')
    await screen.findByRole('heading', { level: 1, name: 'דנה כהן' })
    await user.click(screen.getByRole('button', { name: 'שליחת הצעה חדשה' }))
    let dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('button', { name: /RootLab/ })
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: /Owl lamp/ })).not.toBeNull())
    expect(within(dialog).queryByRole('button', { name: /Old Owl/ })).not.toBeNull()

    await openModel(services, owl.folderId, 'Owl lamp')
    await archiveViaUi(user)
    await openModel(services, old.folderId, 'Old Owl')
    await archiveViaUi(user)

    renderAgain(services, '/customers/cust-dana-0001')
    await screen.findByRole('heading', { level: 1, name: 'דנה כהן' })
    await waitFor(() => expect(screen.queryAllByTestId('customer-quote')).toHaveLength(2))
    const [first, second] = screen.getAllByTestId('customer-quote')
    expect(first.textContent).toContain('Owl lamp')
    expect(first.textContent).toContain('77')
    expect(within(first).getByRole('link', { name: 'Owl lamp' }).getAttribute('href')).toBe(`/model/${owl.folderId}`)
    expect(second.textContent).toContain(MODEL_NAME)

    await user.click(screen.getByRole('button', { name: 'שליחת הצעה חדשה' }))
    dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('button', { name: /RootLab/ })
    const choices = within(within(dialog).getByRole('list')).queryAllByRole('button').map((b) => b.textContent ?? '')
    expect(choices.some((c) => c.includes('Owl lamp')), 'archived priced model not offered').toBe(false)
    expect(choices.some((c) => c.includes('Old Owl')), 'archived pre-v0.4 model not offered').toBe(false)
    // Searching by name does not bring it back either.
    setValue(within(dialog).getByRole('searchbox'), 'owl')
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: /RootLab/ })).toBeNull())
    expect(within(dialog).queryByRole('button', { name: /Owl/ })).toBeNull()

    // The quote's link still opens the archived model (with the banner).
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(within(screen.getAllByTestId('customer-quote')[0]).getByRole('link', { name: 'Owl lamp' }))
    await screen.findByRole('heading', { level: 1, name: 'Owl lamp' }, { timeout: 4000 })
    await screen.findByTestId('archived-banner')

    // Restore → offered again.
    await user.click(within(screen.getByTestId('archived-banner')).getByRole('button', { name: RESTORE }))
    await waitFor(() => expect(screen.queryByTestId('archived-banner')).toBeNull())
    renderAgain(services, '/customers/cust-dana-0001')
    await screen.findByRole('heading', { level: 1, name: 'דנה כהן' })
    await user.click(screen.getByRole('button', { name: 'שליחת הצעה חדשה' }))
    dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('button', { name: /Owl lamp/ })
    expect(within(dialog).queryByRole('button', { name: /Old Owl/ })).toBeNull()
  })
})
