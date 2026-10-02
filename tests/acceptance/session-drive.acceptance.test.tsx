/**
 * Acceptance tests for brief Addendum v0.4 — the SPA side, from the outside: the whole App rendered with the
 * production objects (SessionAuth + GoogleDriveStore, or createGoogleServices itself) talking through a fake browser
 * to the real /api handlers and a fake Google (google-world.ts); plus the in-memory Drive where the brief asks for it.
 * AC18, AC21, AC22, AC23 (UI part). Expected numbers from the brief (T2 = ₪23.17).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAppSettings } from '../../src/lib/bid'
import { createGoogleServices } from '../../src/state/services'
import { Browser, bytes, FOLDER_MIME, GoogleWorld, type Recorded } from './google-world'
import { addManualPart, editBidLink, fixtureBytes, nameInput, navLink, newServices, panel, pngFile, renderApp, saveButton, setValue, stubObjectUrls } from './helpers'
import { sessionServices } from './session-helpers'

const MODELS_FOLDER_KEY = 'rubedo.modelsFolderId'
const SIGNED_IN = 'מחובר ל-Google'
const SIGN_IN = 'התחברות עם Google'
const CREATE_BID = 'צור הצעת מחיר'
const SLICED_MIME = 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
const HEBREW = /[֐-׿]/
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9])
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const HEIC = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])

function cards(): HTMLElement[] {
  return screen.queryAllByTestId('library-card')
}

function cardFor(name: string): HTMLElement {
  const card = cards().find((c) => (c.textContent ?? '').includes(name))
  if (!card) throw new Error(`no library card for ${name}`)
  return card
}

async function findCard(name: string): Promise<HTMLElement> {
  await waitFor(() => cardFor(name), { timeout: 4000 })
  return cardFor(name)
}

function expectNoErrorShown() {
  expect(screen.queryAllByRole('alert').map((a) => a.textContent)).toEqual([])
}

/** A Founder's Drive: models folder + his own model folders (nothing carries the app marker). */
function founderDrive() {
  const world = new GoogleWorld()
  const root = world.addFolder('founder-drive-root', 'models')
  localStorage.setItem(MODELS_FOLDER_KEY, root)
  return { world, root }
}

async function signedInBrowser(world: GoogleWorld): Promise<Browser> {
  const browser = new Browser(world)
  const cb = await browser.signInAtGoogle()
  expect(cb.status).toBe(302)
  return browser
}

function nodeByName(world: GoogleWorld, parent: string, name: string) {
  return world.children(parent).filter((n) => n.name === name)
}

let restoreUrls: () => void
beforeEach(() => {
  restoreUrls = stubObjectUrls()
})
afterEach(() => {
  restoreUrls()
  localStorage.clear()
  sessionStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------------------------
describe('AC18 — with a valid session cookie, opening the app signs in with NO click; reload keeps the user signed in', () => {
  it('AC18.silent: production wiring (createGoogleServices) + session cookie → signed in and the library loads from Drive without any click; reload → still signed in', async () => {
    const { world, root } = founderDrive()
    world.addFolder(root, 'Owl lamp')
    const browser = await signedInBrowser(world)
    vi.stubGlobal('fetch', browser.spaFetch)
    const loginsBefore = browser.exchanges.filter((e) => e.path.startsWith('/api/auth/login')).length

    renderApp(createGoogleServices(), '/library')
    await screen.findByText(SIGNED_IN)
    await findCard('Owl lamp')
    expect(screen.queryByRole('button', { name: SIGN_IN })).toBeNull()

    // Reload: a brand-new page (no token in memory), same cookie jar.
    cleanup()
    renderApp(createGoogleServices(), '/')
    await screen.findByText(SIGNED_IN)
    expect(screen.queryByRole('button', { name: SIGN_IN })).toBeNull()
    cleanup()
    renderApp(createGoogleServices(), '/library')
    await screen.findByText(SIGNED_IN)
    await findCard('Owl lamp')

    // Silent: the session was used via POST /api/auth/token; nobody went to the Google login again.
    expect(browser.exchanges.filter((e) => e.path.startsWith('/api/auth/login')).length).toBe(loginsBefore)
    expect(browser.exchanges.filter((e) => e.method === 'POST' && e.path === '/api/auth/token' && e.status === 200).length).toBeGreaterThanOrEqual(3)
    expect(browser.hasSession()).toBe(true)
  })

  it('AC18.cookie-lifetime: the session cookie is persistent for 180 days (survives browser restarts), HttpOnly, scoped to /api', async () => {
    const { world } = founderDrive()
    const browser = await signedInBrowser(world)
    const set = browser.exchanges.flatMap((e) => e.setCookies).filter((c) => c.startsWith('rubedo_session=') && !/Max-Age=0\b/.test(c))
    expect(set).toHaveLength(1)
    expect(set[0]).toMatch(/;\s*Max-Age=15552000(;|$)/)
    expect(set[0]).toMatch(/;\s*HttpOnly/)
    expect(set[0]).toMatch(/;\s*Path=\/api(;|$)/)
  })

  it('AC18.no-session: without a session cookie the app starts signed out (sign-in button), with no error', async () => {
    const { world } = founderDrive()
    const browser = new Browser(world)
    vi.stubGlobal('fetch', browser.spaFetch)
    renderApp(createGoogleServices(), '/')
    expect((await screen.findAllByRole('button', { name: SIGN_IN })).length).toBeGreaterThan(0)
    expect(screen.queryByText(SIGNED_IN)).toBeNull()
    expectNoErrorShown()
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC21 — bid.json can be created inside an existing Founder folder (N2)', () => {
  it('AC21.memory: memory drive with drive-scope permissions — Founder folder (photo + STL, no sliced file) → manual bid → bid.json (app-marked) inside THAT folder, no new folder', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const drive = services.drive
    const folder = drive.addForeignFolder(root, 'Owl lamp')
    drive.addForeignFile(folder, 'owl.jpg', new Blob([JPG], { type: 'image/jpeg' }), 'image/jpeg')
    drive.addForeignFile(folder, 'owl.stl', new Blob(['solid owl']), 'model/stl')
    const foldersBefore = (await drive.listChildren(root, { foldersOnly: true })).map((f) => f.id)

    renderApp(services, `/model/${folder}/create`)
    await screen.findByRole('button', { name: /הוספת חלק ידנית/ })
    expect(nameInput().value).toBe('Owl lamp')
    await addManualPart(user, '100', '3.5')
    setValue(screen.getByLabelText('זמן עבודה'), '10')
    expect(panel().p70).toBe('₪83.37') // T1
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Owl lamp' })

    const bid = (await drive.listChildren(folder, { name: 'bid.json' }))
    expect(bid).toHaveLength(1)
    expect(bid[0].appCreated).toBe(true)
    expect(bid[0].parents).toEqual([folder])
    expect(JSON.parse(await drive.readText(bid[0].id)).result.price70.toFixed(2)).toBe('83.37')
    expect((await drive.listChildren(root, { foldersOnly: true })).map((f) => f.id)).toEqual(foldersBefore)
    expect((await drive.getFile(folder)).appCreated).toBe(false) // still the Founder's folder
    expectNoErrorShown()
  })

  it('AC21.real-store: real GoogleDriveStore + session — Founder folder with rooting-stand.gcode.3mf → prefilled 55.94 g / 2.587 h → bid.json uploaded INTO that folder with the app marker, ₪23.17', async () => {
    const user = userEvent.setup()
    const { world, root } = founderDrive()
    const folder = world.addFolder(root, 'Rooting stand')
    const sliced = world.addFile(folder, 'rooting-stand.gcode.3mf', new Uint8Array(fixtureBytes('rooting-stand.gcode.3mf')), SLICED_MIME)
    world.addFile(folder, 'photo.jpg', JPG, 'image/jpeg', { thumbnail: { bytes: PNG, type: 'image/png' } })
    const foreign = [...world.nodes.keys()]
    const before = world.snapshot(foreign)
    const browser = await signedInBrowser(world)

    renderApp(sessionServices(browser), '/library')
    const card = await findCard('Rooting stand')
    await user.click(within(card.closest('li') as HTMLElement).getByRole('link', { name: CREATE_BID }))
    const rows = await screen.findAllByTestId('part-row', {}, { timeout: 4000 })
    expect(rows).toHaveLength(1)
    expect((within(rows[0]).getByLabelText('משקל') as HTMLInputElement).value).toBe('55.94')
    expect((within(rows[0]).getByLabelText('זמן הדפסה') as HTMLInputElement).value).toBe('2.587')
    expect(panel().p70).toBe('₪23.17')
    const writesBefore = world.driveWrites().length

    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Rooting stand' })
    expectNoErrorShown()

    const bids = nodeByName(world, folder, 'bid.json')
    expect(bids).toHaveLength(1)
    expect(bids[0].appProperties).toEqual({ rubedo: '1' })
    const json = JSON.parse(Buffer.from(bids[0].content).toString('utf8'))
    expect(json.result.price70.toFixed(2)).toBe('23.17')
    expect(json.parts[0].slicedFileId).toBe(sliced)

    const newWrites = world.driveWrites().slice(writesBefore)
    expect(newWrites.filter((w) => w.url.includes('/drive/v3/files') && !w.url.includes('/upload/') && w.method === 'POST'), 'no new folder').toEqual([])
    const bidUpload = newWrites.find((w) => w.method === 'POST' && (w.metadata as { name?: string })?.name === 'bid.json')
    expect(bidUpload?.metadata).toMatchObject({ parents: [folder], appProperties: { rubedo: '1' } })
    expect(newWrites.filter((w) => /rooting-stand\.gcode\.3mf|photo\.jpg/.test(String((w.metadata as { name?: string })?.name))), 'nothing re-uploaded').toEqual([])
    expect(world.snapshot(foreign)).toEqual(before)
  })

  it('AC21.guard (v0.4 fix I4): /model/:id/create refuses folders that are not direct, non-skipped children of the models folder — nothing is written', async () => {
    const { services, root } = newServices()
    const drive = services.drive
    const parent = drive.addForeignFolder(root, 'Parent')
    const nested = drive.addForeignFolder(parent, 'Nested')
    const archive = drive.addForeignFolder(root, '_archive')
    const photos = drive.addForeignFolder(root, 'Models photo')
    const elsewhere = drive.createRootFolder('Other stuff')
    for (const id of [nested, archive, photos, elsewhere]) {
      cleanup()
      const writes = drive.writeTargets.length
      renderApp(services, `/model/${id}/create`)
      await waitFor(() => expect(screen.queryAllByRole('alert').length).toBeGreaterThan(0))
      expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(HEBREW)
      expect(screen.queryByRole('button', { name: 'שמירה' })).toBeNull()
      expect(drive.writeTargets.slice(writes).filter((w) => w.targetId === id)).toEqual([])
      expect(await drive.listChildren(id, { name: 'bid.json' })).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------------------------
function codeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? codeFiles(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })
}

function checkWrite(world: GoogleWorld, w: Recorded, foreignIds: Set<string>) {
  const label = `${w.method} ${w.url}`
  expect(['POST', 'PATCH'], label).toContain(w.method)
  expect(w.url, `${label}: move/trash/copy parameters`).not.toMatch(/addParents|removeParents|trash|\/copy|\/permissions/i)
  const m = (w.metadata ?? {}) as Record<string, unknown>
  expect(JSON.stringify(m), `${label}: trashed flag`).not.toMatch(/"trashed"/)
  if (w.method === 'POST') {
    expect(m.appProperties, `${label}: create without app marker`).toEqual({ rubedo: '1' })
    for (const p of (m.parents as string[]) ?? []) expect(world.nodes.get(p)?.mimeType, `${label}: parent is a folder`).toBe(FOLDER_MIME)
  } else {
    const id = decodeURIComponent(new URL(w.url).pathname.split('/').pop() as string)
    expect(w.targetMarkedBefore, `${label}: content update of a file WITHOUT appProperties.rubedo="1" (${world.nodes.get(id)?.name})`).toBe(true)
    expect(foreignIds.has(id), `${label}: PATCH of a Founder file`).toBe(false)
    expect(Object.keys(m).filter((k) => k !== 'appProperties'), `${label}: metadata change (rename/move)`).toEqual([])
  }
}

describe('AC22 — no code path can delete/trash/move/rename, or update content of a file lacking appProperties.rubedo="1"', () => {
  it('AC22.ui-real-store: library + refresh, create-from-folder (sliced and manual), edit, new bid with photo, settings save → only marked creates and updates of marked files; Founder files untouched', async () => {
    const user = userEvent.setup()
    const { world, root } = founderDrive()
    const a = world.addFolder(root, 'Stand A')
    world.addFile(a, 'rooting-stand.gcode.3mf', new Uint8Array(fixtureBytes('rooting-stand.gcode.3mf')), SLICED_MIME)
    world.addFile(a, 'a.jpg', JPG, 'image/jpeg', { thumbnail: { bytes: PNG, type: 'image/png' } })
    const b = world.addFolder(root, 'Vase B')
    world.addFile(b, 'b.jpg', JPG, 'image/jpeg', { thumbnail: { bytes: PNG, type: 'image/png' } })
    world.addFile(b, 'b.stl', bytes('solid b'), 'model/stl')
    world.addFile(root, 'notes.txt', bytes('founder notes'), 'text/plain')
    world.addFile(root, 'Price list', new Uint8Array(), 'application/vnd.google-apps.spreadsheet')
    const foreignIds = new Set(world.nodes.keys())
    const before = world.snapshot(foreignIds)
    const browser = await signedInBrowser(world)
    const services = sessionServices(browser)

    renderApp(services, '/library')
    await findCard('Stand A')
    await user.click(screen.getByRole('button', { name: 'רענון ספרייה' }))
    await findCard('Vase B')

    await user.click(within(cardFor('Stand A').closest('li') as HTMLElement).getByRole('link', { name: CREATE_BID }))
    await screen.findAllByTestId('part-row', {}, { timeout: 4000 })
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Stand A' })

    await user.click(editBidLink())
    setValue(await screen.findByLabelText('זמן עבודה'), '10')
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Stand A' })

    cleanup()
    renderApp(services, `/model/${b}/create`)
    await screen.findByRole('button', { name: /הוספת חלק ידנית/ }, { timeout: 4000 })
    await addManualPart(user, '100', '3.5')
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Vase B' })

    await user.click(navLink('דגם חדש'))
    setValue(await screen.findByLabelText(/^שם \*$/), 'Brand new')
    await addManualPart(user, '10', '1')
    await user.upload(screen.getByLabelText('הוספת תמונות'), pngFile('new.png'))
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Brand new' })

    await user.click(navLink('הגדרות'))
    setValue(await screen.findByLabelText('תעריף עבודה'), '90')
    await user.click(screen.getByRole('button', { name: 'שמירת הגדרות' }))
    await screen.findByText(/^נשמר\./)
    await user.click(navLink('ספרייה'))
    await user.click(await screen.findByRole('button', { name: 'רענון ספרייה' }))
    await waitFor(() => expect(cardFor('Vase B').getAttribute('data-status')).toBe('priced'))
    expectNoErrorShown()

    const writes = world.driveWrites()
    expect(writes.filter((w) => w.method === 'PATCH').length, 'edit/settings/index really rewrote app files').toBeGreaterThan(0)
    expect(writes.filter((w) => w.method === 'POST').length).toBeGreaterThan(0)
    for (const w of writes) checkWrite(world, w, foreignIds)
    expect(world.calls.filter((c) => c.method === 'DELETE' || c.method === 'PUT')).toEqual([])
    expect(world.snapshot(foreignIds)).toEqual(before)
  })

  it('AC22.store-refuses: asking the store to update a Founder file (json, photo, sliced file, folder, Google Sheet) is refused before any write request', async () => {
    const { world, root } = founderDrive()
    const f = world.addFolder(root, 'Vase')
    const ids = [
      world.addFile(f, 'bid.json', bytes('{"not":"mine"}'), 'application/json'),
      world.addFile(f, 'photo.jpg', JPG, 'image/jpeg'),
      world.addFile(f, 'vase.gcode.3mf', bytes('zip'), SLICED_MIME),
      f,
      world.addFile(root, 'Price list', new Uint8Array(), 'application/vnd.google-apps.spreadsheet'),
    ]
    const before = world.snapshot(ids)
    const browser = await signedInBrowser(world)
    const services = sessionServices(browser)
    await services.auth.init()
    for (const id of ids) {
      const n = world.driveWrites().length
      await expect(services.drive.updateFileContent(id, new Blob(['x']), 'application/json'), id).rejects.toThrow()
      expect(world.driveWrites().length, `write request sent for ${id}`).toBe(n)
    }
    expect(world.snapshot(ids)).toEqual(before)
  })

  it('AC22.unmarked-settings-and-index: a Founder-side _rubedo-settings.json / _rubedo-index.json WITHOUT the marker in the models folder is never rewritten (settings save, library refresh)', async () => {
    const user = userEvent.setup()
    const { world, root } = founderDrive()
    world.addFolder(root, 'Owl lamp')
    const settings = world.addFile(root, '_rubedo-settings.json', bytes(JSON.stringify(defaultAppSettings())), 'application/json')
    const index = world.addFile(
      root,
      '_rubedo-index.json',
      bytes(JSON.stringify({ schemaVersion: 2, builtAt: '2026-01-01T00:00:00.000Z', entries: [] })),
      'application/json',
    )
    const before = world.snapshot([settings, index])
    const browser = await signedInBrowser(world)
    const services = sessionServices(browser)

    renderApp(services, '/library')
    await findCard('Owl lamp')
    await user.click(screen.getByRole('button', { name: 'רענון ספרייה' }))
    await findCard('Owl lamp')
    await user.click(navLink('הגדרות'))
    setValue(await screen.findByLabelText('תעריף עבודה'), '90')
    await user.click(screen.getByRole('button', { name: 'שמירת הגדרות' }))
    await waitFor(() => expect(screen.queryByText(/^נשמר\./) ?? screen.queryAllByRole('alert')[0]).toBeTruthy())

    const patched = world.driveWrites().filter((w) => w.method === 'PATCH' && w.targetMarkedBefore === false)
    expect(
      patched.map((w) => world.nodes.get(decodeURIComponent(new URL(w.url).pathname.split('/').pop() as string))?.name),
      'content updates of files lacking appProperties.rubedo="1"',
    ).toEqual([])
    expect(world.snapshot([settings, index])).toEqual(before)
  })

  it('AC22.static: src/ and api/ contain no delete/trash/move/copy/permission request; DriveStore exposes no such operation', () => {
    const offenders: string[] = []
    for (const f of [...codeFiles(resolve(process.cwd(), 'src')), ...codeFiles(resolve(process.cwd(), 'api'))]) {
      const code = readFileSync(f, 'utf8')
      if (/method:\s*['"`](DELETE|PUT)['"`]/i.test(code)) offenders.push(`${f}: DELETE/PUT request`)
      if (/addParents|removeParents|\/trash\b|emptyTrash|trashed['"]?\s*:\s*true/.test(code)) offenders.push(`${f}: move/trash`)
      if (/\/files\/[^'"`]*\/copy|\/permissions\b/.test(code)) offenders.push(`${f}: copy/permissions`)
      if (/\.delete\(\s*[`'"]https?:/.test(code)) offenders.push(`${f}: delete call`)
    }
    expect(offenders).toEqual([])
    const types = readFileSync(resolve(process.cwd(), 'src/lib/drive/types.ts'), 'utf8')
    const start = types.indexOf('export interface DriveStore')
    const iface = types.slice(start, types.indexOf('\n}', start))
    expect(iface).not.toMatch(/^\s*(delete|remove|trash|move|rename|copy|share|setPermission|update(?!FileContent))\w*\s*\(/im)
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC23 (UI) — Drive images incl. iPhone HEIC are shown through /api/thumb', () => {
  it('AC23.ui: a HEIC photo in a Founder folder → the model page and library card load it from /api/thumb, which answers with an image', async () => {
    const { world, root } = founderDrive()
    const folder = world.addFolder(root, 'Owl lamp')
    const heic = world.addFile(folder, 'IMG_0001.HEIC', HEIC, 'image/heic', { thumbnail: { bytes: PNG, type: 'image/png' } })
    const browser = await signedInBrowser(world)

    renderApp(sessionServices(browser), `/model/${folder}`)
    await screen.findByRole('heading', { level: 1, name: 'Owl lamp' }, { timeout: 4000 })
    const gallery = within(await screen.findByRole('region', { name: 'תמונות' }))
    const img = (await gallery.findByRole('img', { name: 'IMG_0001.HEIC' })) as HTMLImageElement
    const src = img.getAttribute('src') ?? ''
    expect(src).toMatch(new RegExp(`^/api/thumb\\?id=${heic}&s=\\d+$`))

    const res = await browser.spaFetch(src)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)

    cleanup()
    renderApp(sessionServices(browser), '/library')
    const card = await findCard('Owl lamp')
    await waitFor(() => expect(within(card).getByRole('img').getAttribute('src') ?? '').toMatch(new RegExp(`^/api/thumb\\?id=${heic}&`)))
  })
})
