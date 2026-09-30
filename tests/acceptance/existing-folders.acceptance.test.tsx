/**
 * Acceptance tests for brief Addendum v0.3 (Founder decisions, 30 Sep 2026): AC14–AC17.
 * Outside-in: render the App on the in-memory Drive; the Founder's own Drive content is simulated with
 * addForeignFolder / addForeignFile (not created by the app). Expected numbers come from the brief (T2 = ₪23.17).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleAuth } from '../../src/lib/auth/googleAuth'
import { newSaveSession, rebuildIndex, saveNewBid, loadSettings, updateBid, type BidContent } from '../../src/lib/drive/bidRepository'
import { GoogleDriveStore } from '../../src/lib/drive/googleDrive'
import { computePrice, DEFAULT_PRICING_SETTINGS } from '../../src/lib/pricing'
import {
  addManualPart,
  fixtureBytes,
  nameInput,
  navLink,
  newServices,
  panel,
  pngFile,
  renderApp,
  saveButton,
  setValue,
  stubObjectUrls,
  type MemServices,
} from './helpers'

type Drive = MemServices['drive']

const NEEDS_SLICING = 'דורש סלייס'
const SLICED_FOUND = 'נמצא קובץ סלייס — צור הצעה'
const CREATE_BID = 'צור הצעת מחיר'
const SLICED_MIME = 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file'
const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly'

function jpeg(): Blob {
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' })
}

function sliced(): Blob {
  return new Blob([new Uint8Array(fixtureBytes('rooting-stand.gcode.3mf'))], { type: SLICED_MIME })
}

function cardFor(name: string): HTMLElement {
  const card = screen.getAllByTestId('library-card').find((c) => (c.textContent ?? '').includes(name))
  if (!card) throw new Error(`no library card for ${name}`)
  return card
}

async function findCard(name: string): Promise<HTMLElement> {
  await waitFor(() => cardFor(name))
  return cardFor(name)
}

async function childrenNames(drive: Drive, folderId: string): Promise<string[]> {
  return (await drive.listChildren(folderId)).map((c) => c.name).sort()
}

async function readBidIn(drive: Drive, folderId: string) {
  const f = (await drive.listChildren(folderId, { name: 'bid.json' }))[0]
  if (!f) throw new Error('bid.json missing')
  return { file: f, json: JSON.parse(await drive.readText(f.id)) }
}

/** Snapshot of everything the app did not create: metadata + the exact content object. */
async function foreignSnapshot(drive: Drive) {
  const out: Record<string, unknown> = {}
  for (const n of drive.all().filter((x) => !x.appCreated)) {
    let data: Blob | null
    try {
      data = await drive.readBlob(n.id)
    } catch {
      data = null // folders have no content
    }
    out[n.id] = { name: n.name, mimeType: n.mimeType, parentId: n.parentId, modifiedTime: n.modifiedTime, data }
  }
  return out
}

function expectNoErrorShown() {
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText(/נכשל|שגיאה|לא יצרה את הקובץ/)).toBeNull()
}

// ---------------------------------------------------------------------------------------------
describe('AC14 — a models-folder subfolder without bid.json appears as a needs-slicing card with its name', () => {
  let restore: () => void
  beforeEach(() => {
    restore = stubObjectUrls()
  })
  afterEach(() => restore())

  it('AC14.card: the Founder\'s own folder (photo + STL, no bid.json) → card with its name, badge "דורש סלייס", no price, cover photo', async () => {
    const { services, root } = newServices()
    const drive = services.drive
    const owl = drive.addForeignFolder(root, 'Owl lamp')
    drive.addForeignFile(owl, 'owl.jpg', jpeg(), 'image/jpeg')
    drive.addForeignFile(owl, 'owl.stl', new Blob(['solid owl']), 'model/stl')

    renderApp(services, '/library')
    const card = await findCard('Owl lamp')
    expect(card.getAttribute('data-status')).toBe('needs-slicing')
    expect(within(card).getByTestId('status-badge').textContent).toBe(NEEDS_SLICING)
    expect(card.textContent).not.toMatch(/₪/)
    await waitFor(() => expect(within(card).getByRole('img', { name: 'Owl lamp' })).toBeTruthy())
    // The card leads to its model page and offers "create bid".
    const li = card.closest('li') as HTMLElement
    expect(within(li).getByRole('link', { name: CREATE_BID }).getAttribute('href')).toBe(`/model/${owl}/create`)
  })

  it('AC14.mixed: priced bids and needs-slicing folders side by side; "_…" and "Models photo" folders are skipped (N1)', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    renderApp(services, '/new')
    setValue(await screen.findByLabelText(/^שם \*$/), 'Priced one')
    await addManualPart(user, '100', '3.5')
    setValue(screen.getByLabelText('זמן עבודה'), '10')
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Priced one' })

    drive.addForeignFolder(root, 'Old vase')
    drive.addForeignFolder(root, '_archive')
    const photos = drive.addForeignFolder(root, 'Models photo')
    drive.addForeignFile(photos, 'x.jpg', jpeg(), 'image/jpeg')

    await user.click(navLink('ספרייה'))
    await user.click(await screen.findByRole('button', { name: 'רענון ספרייה' }))
    const vase = await findCard('Old vase')
    expect(vase.getAttribute('data-status')).toBe('needs-slicing')
    expect(within(vase).getByTestId('status-badge').textContent).toBe(NEEDS_SLICING)
    const priced = cardFor('Priced one')
    expect(priced.getAttribute('data-status')).toBe('priced')
    expect(priced.textContent).toContain('₪83.37') // T1
    expect(screen.getAllByTestId('library-card')).toHaveLength(2)
    expect(screen.queryByText('_archive')).toBeNull()
    expect(screen.queryByText('Models photo')).toBeNull()
  })

  it('AC14.stale-index: a folder added in Drive after the index was built shows up on open once the index is > 10 min old (N5)', async () => {
    const { services, root } = newServices()
    const drive = services.drive
    await rebuildIndex(drive, root, new Date(Date.now() - 11 * 60 * 1000))
    drive.addForeignFolder(root, 'Added later')

    renderApp(services, '/library')
    const card = await findCard('Added later')
    expect(card.getAttribute('data-status')).toBe('needs-slicing')
  })

  it('AC14.model-page: opening a needs-slicing card shows its name, the badge and a "create bid" button', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const f = drive.addForeignFolder(root, 'Owl lamp')
    drive.addForeignFile(f, 'owl.jpg', jpeg(), 'image/jpeg')
    renderApp(services, '/library')
    await user.click(await findCard('Owl lamp'))
    await screen.findByRole('heading', { level: 1, name: 'Owl lamp' })
    expect(screen.getByTestId('status-badge').textContent).toBe(NEEDS_SLICING)
    expect(screen.getByRole('link', { name: CREATE_BID })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC15 — folder with rooting-stand.gcode.3mf: "sliced file found", create bid prefills, saves into the SAME folder', () => {
  let restore: () => void
  beforeEach(() => {
    restore = stubObjectUrls()
  })
  afterEach(() => restore())

  it('AC15.flow: badge → create bid (55.94 g / 2.587 h) → bid.json in the same folder, nothing re-uploaded → priced card ₪23.17', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const folder = drive.addForeignFolder(root, 'Rooting stand')
    const slicedId = drive.addForeignFile(folder, 'rooting-stand.gcode.3mf', sliced(), SLICED_MIME)
    drive.addForeignFile(folder, 'photo.jpg', jpeg(), 'image/jpeg')

    renderApp(services, '/library')
    const card = await findCard('Rooting stand')
    expect(card.getAttribute('data-status')).toBe('needs-slicing')
    expect(within(card).getByTestId('status-badge').textContent).toBe(SLICED_FOUND)

    await user.click(within(card.closest('li') as HTMLElement).getByRole('link', { name: CREATE_BID }))

    // Prefilled from the folder and its sliced file.
    const rows = await screen.findAllByTestId('part-row')
    expect(rows).toHaveLength(1)
    expect((within(rows[0]).getByLabelText('משקל') as HTMLInputElement).value).toBe('55.94')
    expect((within(rows[0]).getByLabelText('זמן הדפסה') as HTMLInputElement).value).toBe('2.587')
    expect(nameInput().value).toBe('Rooting stand')
    expect(panel().p70).toBe('₪23.17')

    const foldersBefore = (await drive.listChildren(root, { foldersOnly: true })).map((f) => f.id).sort()
    const childrenBefore = await childrenNames(drive, folder)
    const writesBefore = drive.writeTargets.length

    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Rooting stand' })
    // No name-conflict dialog for its own folder.
    expect(screen.queryByText('השם כבר קיים')).toBeNull()
    expect(panel().p70).toBe('₪23.17')

    // Same folder: no new model folder, bid.json written inside it.
    expect((await drive.listChildren(root, { foldersOnly: true })).map((f) => f.id).sort()).toEqual(foldersBefore)
    const newWrites = drive.writeTargets.slice(writesBefore)
    expect(newWrites.filter((w) => w.op === 'createFolder')).toEqual([])
    const childrenAfter = await childrenNames(drive, folder)
    expect(childrenAfter).toContain('bid.json')
    // Nothing already present was uploaded again (no duplicate names, one sliced file only).
    const added = [...childrenAfter]
    for (const n of childrenBefore) added.splice(added.indexOf(n), 1)
    for (const n of added) expect(childrenBefore, `re-uploaded ${n}`).not.toContain(n)
    expect(childrenAfter.filter((n) => /\.gcode\.3mf$/i.test(n))).toEqual(['rooting-stand.gcode.3mf'])
    expect(drive.writeLog.filter((l) => l === 'upload:rooting-stand.gcode.3mf' || l === 'upload:photo.jpg')).toEqual([])

    // bid.json references the existing sliced file and has the T2 price.
    const { json } = await readBidIn(drive, folder)
    expect(json.parts).toHaveLength(1)
    expect(json.parts[0].source).toBe('3mf')
    expect(json.parts[0].slicedFileId).toBe(slicedId)
    expect(json.files.some((f: { id: string; kind: string }) => f.id === slicedId && f.kind === 'sliced')).toBe(true)
    expect(json.result.price70.toFixed(2)).toBe('23.17')

    // The card is now priced (and there is only one card for that folder).
    await user.click(navLink('ספרייה'))
    await waitFor(() => expect(cardFor('Rooting stand').getAttribute('data-status')).toBe('priced'))
    expect(cardFor('Rooting stand').textContent).toContain('₪23.17')
    expect(screen.getAllByTestId('library-card')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'רענון ספרייה' }))
    await waitFor(() => expect(cardFor('Rooting stand').getAttribute('data-status')).toBe('priced'))
    expect(cardFor('Rooting stand').textContent).toContain('₪23.17')
    expect(screen.getAllByTestId('library-card')).toHaveLength(1)
    expectNoErrorShown()
  })

  it('AC15.model-page: the needs-slicing page of such a folder shows the "sliced file found" badge and the Bambu download', async () => {
    const { services, root } = newServices()
    const drive = services.drive
    const folder = drive.addForeignFolder(root, 'Rooting stand')
    drive.addForeignFile(folder, 'rooting-stand.gcode.3mf', sliced(), SLICED_MIME)
    renderApp(services, `/model/${folder}`)
    await screen.findByRole('heading', { level: 1, name: 'Rooting stand' })
    expect(screen.getByTestId('status-badge').textContent).toBe(SLICED_FOUND)
    expect(screen.getByRole('button', { name: 'הורדה ל-Bambu Studio' })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC16 — an image added to a priced model\'s folder after saving appears on its model page', () => {
  let restore: () => void
  beforeEach(() => {
    restore = stubObjectUrls()
  })
  afterEach(() => restore())

  it('AC16.added-later: bid saved with one photo; a jpg and an iPhone HEIC added in Drive later → all three on the model page', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const { unmount } = renderApp(services, '/new')
    setValue(await screen.findByLabelText(/^שם \*$/), 'Stand')
    await addManualPart(user, '100', '3.5')
    await user.upload(screen.getByLabelText('הוספת תמונות'), pngFile('saved.png'))
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Stand' })
    unmount()

    const folder = (await drive.listChildren(root, { foldersOnly: true })).find((f) => f.name === 'Stand')!
    const bidBefore = (await readBidIn(drive, folder.id)).json
    drive.addForeignFile(folder.id, 'later.jpg', jpeg(), 'image/jpeg')
    // HEIC from an iPhone: browsers cannot show the bytes; Drive provides a thumbnail.
    drive.addForeignFile(folder.id, 'IMG_0001.HEIC', new Blob([new Uint8Array([0, 0, 0, 24])]), 'image/heic', {
      thumbnail: pngFile('thumb.png'),
    })
    // Not in bid.json.
    expect(JSON.stringify(bidBefore.files)).not.toMatch(/later\.jpg|IMG_0001/)

    renderApp(services, `/model/${folder.id}`)
    await screen.findByRole('heading', { level: 1, name: 'Stand' })
    const gallery = within(screen.getByRole('region', { name: 'תמונות' }))
    await waitFor(() => expect(gallery.getByRole('img', { name: 'later.jpg' })).toBeTruthy())
    await waitFor(() => expect(gallery.getByRole('img', { name: 'IMG_0001.HEIC' })).toBeTruthy())
    expect(gallery.getByRole('img', { name: 'saved.png' })).toBeTruthy()
    expect(panel().p70).toBe('₪38.92') // unchanged bid (100 g / 3.5 h / 0 min at defaults)
    // Viewing never rewrote the bid.
    expect((await readBidIn(drive, folder.id)).json).toEqual(bidBefore)
  })

  it('AC16.no-photo-bid: a bid saved without pictures gets a gallery once a photo is added in Drive', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const { unmount } = renderApp(services, '/new')
    setValue(await screen.findByLabelText(/^שם \*$/), 'Bare')
    await addManualPart(user, '100', '3.5')
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Bare' })
    unmount()

    const folder = (await drive.listChildren(root, { foldersOnly: true })).find((f) => f.name === 'Bare')!
    drive.addForeignFile(folder.id, 'shot.jpg', jpeg(), 'image/jpeg')
    renderApp(services, `/model/${folder.id}`)
    await screen.findByRole('heading', { level: 1, name: 'Bare' })
    const gallery = within(await screen.findByRole('region', { name: 'תמונות' }))
    await waitFor(() => expect(gallery.getByRole('img', { name: 'shot.jpg' })).toBeTruthy())
  })
})

// ---------------------------------------------------------------------------------------------
function content(name: string, grams: number, hours: number): BidContent {
  const s = { ...DEFAULT_PRICING_SETTINGS }
  const input = { pricePerKg: 85, parts: [{ qty: 1, grams, hours }], laborMinutes: 0, hardware: [], hasShipping: false, packaging: [], shippingCost: 0 }
  return {
    name,
    revision: 'V1',
    description: '',
    material: { name: 'PLA', pricePerKg: 85 },
    parts: [{ name: 'p', qty: 1, grams, hours, source: 'manual' }],
    laborMinutes: 0,
    hardware: [],
    hasShipping: false,
    packaging: [],
    shippingCost: 0,
    settingsSnapshot: s,
    result: computePrice(input, s),
  }
}

interface RestNode {
  id: string
  name: string
  mimeType: string
  parents: string[]
  appAuthorized: boolean
  content: string
}

/** Minimal Drive REST v3 double: records every request; creates are app-authorized, seeded nodes are not. */
function fakeDriveRest(seed: Omit<RestNode, 'appAuthorized'>[]) {
  const nodes = new Map<string, RestNode>()
  for (const n of seed) nodes.set(n.id, { ...n, appAuthorized: false })
  const calls: { method: string; url: string; body: string }[] = []
  let seq = 0
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
  const meta = (n: RestNode) => ({ id: n.id, name: n.name, mimeType: n.mimeType, isAppAuthorized: n.appAuthorized })

  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = (init.method ?? 'GET').toUpperCase()
    const body = init.body instanceof Blob ? await init.body.text() : typeof init.body === 'string' ? init.body : ''
    calls.push({ method, url: url.toString(), body })
    const path = url.pathname
    const idMatch = path.match(/\/files\/([^/]+)$/)
    if (method === 'GET' && /^\/drive\/v3\/files$/.test(path)) {
      const q = url.searchParams.get('q') ?? ''
      const parent = q.match(/'([^']+)' in parents/)?.[1]
      const name = q.match(/name = '([^']+)'/)?.[1]
      const foldersOnly = q.includes("mimeType = 'application/vnd.google-apps.folder'")
      const files = [...nodes.values()].filter(
        (n) => n.parents.includes(parent ?? '') && (name === undefined || n.name === name) && (!foldersOnly || n.mimeType === 'application/vnd.google-apps.folder'),
      )
      return json({ files: files.map(meta) })
    }
    if (method === 'GET' && idMatch) {
      const n = nodes.get(decodeURIComponent(idMatch[1]))
      if (!n) return json({ error: 'nf' }, 404)
      return url.searchParams.get('alt') === 'media' ? new Response(n.content) : json(meta(n))
    }
    if (method === 'POST' && /^\/drive\/v3\/files$/.test(path)) {
      const m = JSON.parse(body) as { name: string; mimeType: string; parents: string[] }
      const n: RestNode = { id: `new-${++seq}`, name: m.name, mimeType: m.mimeType, parents: m.parents, appAuthorized: true, content: '' }
      nodes.set(n.id, n)
      return json(meta(n))
    }
    if (method === 'POST' && /\/upload\/drive\/v3\/files$/.test(path)) {
      const parts = body.split(/\r\n\r\n/)
      const m = JSON.parse(parts[1].split('\r\n--')[0]) as { name: string; mimeType: string; parents: string[] }
      const data = parts.slice(2).join('\r\n\r\n').replace(/\r\n--[^\r\n]*--$/, '')
      const n: RestNode = { id: `new-${++seq}`, name: m.name, mimeType: m.mimeType, parents: m.parents, appAuthorized: true, content: data }
      nodes.set(n.id, n)
      return json(meta(n))
    }
    if (method === 'PATCH' && idMatch) {
      const n = nodes.get(decodeURIComponent(idMatch[1]))
      if (!n) return json({ error: 'nf' }, 404)
      n.content = body // accepted here on purpose: the test checks the APP never sends it for foreign files
      return json({ id: n.id })
    }
    return json({ error: `unhandled ${method} ${path}` }, 400)
  }) as typeof fetch
  return { nodes, calls, fetchImpl }
}

function srcFiles(dir = resolve(process.cwd(), 'src')): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? srcFiles(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })
}

describe('AC17 — scopes exactly drive.file + drive.readonly; no write/delete targets a file the app did not create', () => {
  afterEach(() => {
    delete (window as Window).google
    vi.restoreAllMocks()
  })

  it('AC17.scopes: the token client is initialised with exactly drive.file + drive.readonly', async () => {
    const configs: GoogleTokenClientConfig[] = []
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (c: GoogleTokenClientConfig) => {
            configs.push(c)
            return {
              requestAccessToken: () =>
                setTimeout(() => c.callback({ access_token: 'tok', expires_in: 3600, scope: `${DRIVE_READONLY} ${DRIVE_FILE}` }), 0),
            }
          },
          revoke: vi.fn(),
        },
      },
    } as unknown as Window['google']
    // GIS script "loads" instantly (no network in tests).
    vi.spyOn(document.head, 'appendChild').mockImplementation((el) => {
      queueMicrotask(() => (el as HTMLScriptElement).onload?.(new Event('load')))
      return el
    })
    const auth = new GoogleAuth('cid')
    await auth.signIn()
    expect(configs.length).toBeGreaterThan(0)
    for (const c of configs) expect(c.scope.trim().split(/\s+/).sort()).toEqual([DRIVE_FILE, DRIVE_READONLY].sort())
    expect(await auth.getToken()).toBe('tok')
  })

  it('AC17.ui-flows: library, create-from-folder (sliced and manual), edit, new bid, settings, refresh → no write targets a foreign file; foreign files unchanged', async () => {
    const restore = stubObjectUrls()
    try {
      const user = userEvent.setup()
      const { services, root } = newServices()
      const drive = services.drive
      const a = drive.addForeignFolder(root, 'Stand A')
      drive.addForeignFile(a, 'rooting-stand.gcode.3mf', sliced(), SLICED_MIME)
      drive.addForeignFile(a, 'a.jpg', jpeg(), 'image/jpeg')
      const b = drive.addForeignFolder(root, 'Vase B')
      drive.addForeignFile(b, 'b.jpg', jpeg(), 'image/jpeg')
      drive.addForeignFile(b, 'b.stl', new Blob(['solid b']), 'model/stl')
      drive.addForeignFile(root, 'notes.txt', new Blob(['founder notes']), 'text/plain')
      const before = await foreignSnapshot(drive)

      // Library (index built), then refresh (index rewritten).
      renderApp(services, '/library')
      await findCard('Stand A')
      await user.click(screen.getByRole('button', { name: 'רענון ספרייה' }))
      await findCard('Vase B')

      // Create from folder A (sliced file present).
      await user.click(within(cardFor('Stand A').closest('li') as HTMLElement).getByRole('link', { name: CREATE_BID }))
      await screen.findAllByTestId('part-row')
      await user.click(saveButton())
      await screen.findByRole('heading', { level: 1, name: 'Stand A' })

      // Edit that bid (rewrites bid.json).
      await user.click(screen.getByRole('link', { name: 'עריכה' }))
      setValue(await screen.findByLabelText('זמן עבודה'), '10')
      await user.click(saveButton())
      await screen.findByRole('heading', { level: 1, name: 'Stand A' })

      // Create from folder B (no sliced file → manual part).
      cleanup()
      renderApp(services, `/model/${b}/create`)
      await screen.findByRole('button', { name: /הוספת חלק ידנית/ })
      await addManualPart(user, '100', '3.5')
      await user.click(saveButton())
      await screen.findByRole('heading', { level: 1, name: 'Vase B' })

      // A brand-new bid.
      await user.click(navLink('דגם חדש'))
      setValue(await screen.findByLabelText(/^שם \*$/), 'Brand new')
      await addManualPart(user, '10', '1')
      await user.click(saveButton())
      await screen.findByRole('heading', { level: 1, name: 'Brand new' })

      // Settings save (rewrites the settings file), then a library refresh.
      await user.click(navLink('הגדרות'))
      setValue(await screen.findByLabelText('תעריף עבודה'), '90')
      await user.click(screen.getByRole('button', { name: 'שמירת הגדרות' }))
      await screen.findByText(/^נשמר\./)
      await user.click(navLink('ספרייה'))
      await user.click(await screen.findByRole('button', { name: 'רענון ספרייה' }))
      await waitFor(() => expect(cardFor('Vase B').getAttribute('data-status')).toBe('priced'))
      expectNoErrorShown()

      const byId = new Map(drive.all().map((n) => [n.id, n]))
      const updates = drive.writeTargets.filter((w) => w.op === 'updateFileContent')
      expect(updates.length).toBeGreaterThan(0) // the flows above really rewrote app files
      for (const w of updates) {
        expect(byId.get(w.targetId)?.appCreated, `update of ${byId.get(w.targetId)?.name}`).toBe(true)
      }
      // Creates only ever add children to folders.
      for (const w of drive.writeTargets.filter((x) => x.op !== 'updateFileContent')) {
        expect(byId.get(w.targetId)?.mimeType).toBe('application/vnd.google-apps.folder')
      }
      // Every foreign file/folder still exists, same name/place/content.
      expect(await foreignSnapshot(drive)).toEqual(before)
      for (const [id, snap] of Object.entries(before)) {
        const now = (await foreignSnapshot(drive))[id] as { data: Blob | null }
        expect(now.data, `content object of ${id}`).toBe((snap as { data: Blob | null }).data)
      }
    } finally {
      restore()
    }
  })

  it('AC17.real-store: GoogleDriveStore through rebuild + create-in-existing-folder + edit + settings sends no DELETE/move and no write to a foreign file', async () => {
    const FOLDER = 'application/vnd.google-apps.folder'
    const rest = fakeDriveRest([
      { id: 'root', name: 'models', mimeType: FOLDER, parents: ['drive-root'], content: '' },
      { id: 'fA', name: 'Stand A', mimeType: FOLDER, parents: ['root'], content: '' },
      { id: 'slicedA', name: 'rooting-stand.gcode.3mf', mimeType: SLICED_MIME, parents: ['fA'], content: 'zip' },
      { id: 'photoA', name: 'a.jpg', mimeType: 'image/jpeg', parents: ['fA'], content: 'jpg' },
      { id: 'fB', name: 'Vase B', mimeType: FOLDER, parents: ['root'], content: '' },
      { id: 'notes', name: 'notes.txt', mimeType: 'text/plain', parents: ['root'], content: 'n' },
      // A foreign file named like an app file: the app must not rewrite it.
      { id: 'foreignBid', name: 'bid.json', mimeType: 'application/json', parents: ['fB'], content: '{"not":"a bid"}' },
    ])
    const store = new GoogleDriveStore({ getToken: async () => 't', refresh: async () => 't' }, rest.fetchImpl)
    const foreign = new Set([...rest.nodes.keys()])

    await loadSettings(store, 'root')
    await rebuildIndex(store, 'root')
    const session = newSaveSession()
    const c = content('Stand A', 55.94, 9312 / 3600)
    const saved = await saveNewBid(
      store,
      'root',
      {
        folderName: 'Stand A',
        existingFolderId: 'fA',
        existingFiles: [{ id: 'slicedA', name: 'rooting-stand.gcode.3mf', kind: 'sliced', mimeType: SLICED_MIME }],
        content: c,
        files: [],
      },
      session,
    )
    expect(saved.folderId).toBe('fA')
    await updateBid(store, 'root', { folderId: 'fA', existing: saved.bid, content: { ...c, laborMinutes: 10 }, newFiles: [] }, newSaveSession())
    await rebuildIndex(store, 'root')
    // Directly asking the store to rewrite a foreign file is refused before any write request is sent.
    const n = rest.calls.length
    await expect(store.updateFileContent('foreignBid', new Blob(['x']), 'application/json')).rejects.toThrow()
    expect(rest.calls.slice(n).filter((x) => x.method !== 'GET')).toEqual([])

    const writes = rest.calls.filter((x) => x.method !== 'GET')
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.some((w) => w.method === 'PATCH')).toBe(true) // the edit/index rewrite really went through PATCH
    for (const w of writes) {
      expect(['POST', 'PATCH'], `${w.method} ${w.url}`).toContain(w.method)
      expect(w.url, 'no move/trash parameters').not.toMatch(/addParents|removeParents|trash/i)
      expect(w.body, 'no trash/move in metadata').not.toMatch(/"trashed"\s*:\s*true|addParents|removeParents/)
      if (w.method === 'PATCH') {
        const id = decodeURIComponent(new URL(w.url).pathname.split('/').pop() as string)
        expect(foreign.has(id), `PATCH of foreign file ${id}`).toBe(false)
        expect(rest.nodes.get(id)?.appAuthorized).toBe(true)
      }
    }
    // Foreign content unchanged.
    expect(rest.nodes.get('foreignBid')?.content).toBe('{"not":"a bid"}')
    expect(rest.nodes.get('slicedA')?.content).toBe('zip')
    expect(rest.nodes.get('photoA')?.content).toBe('jpg')
  })

  it('AC17.static: src/ has no delete/trash/move operation against Drive and DriveStore exposes none', () => {
    const offenders: string[] = []
    for (const f of srcFiles()) {
      const code = readFileSync(f, 'utf8')
      if (/method:\s*['"`](DELETE|PUT)['"`]/.test(code)) offenders.push(`${f}: DELETE/PUT request`)
      if (/addParents|removeParents|\/trash\b|emptyTrash|trashed['"]?\s*:\s*true/.test(code)) offenders.push(`${f}: move/trash`)
      if (/\/files\/[^'"`]*\/copy/.test(code)) offenders.push(`${f}: copy`)
    }
    expect(offenders).toEqual([])
    const types = readFileSync(resolve(process.cwd(), 'src/lib/drive/types.ts'), 'utf8')
    const iface = types.slice(types.indexOf('export interface DriveStore'), types.indexOf('}', types.indexOf('export interface DriveStore')))
    expect(iface).not.toMatch(/\b(delete|remove|trash|move|rename|copy)\w*\s*\(/i)
  })
})
