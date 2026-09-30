import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../src/App'
import { defaultAppSettings, INDEX_FILE_NAME, SETTINGS_FILE_NAME } from '../../src/lib/bid'
import {
  loadModelFolder,
  loadSettingsWithStatus,
  newSaveSession,
  rebuildIndex,
  requireModelFolder,
  saveNewBid,
  saveSettings,
  updateBid,
  type BidContent,
} from '../../src/lib/drive/bidRepository'
import { classifyFolder } from '../../src/lib/drive/folderContents'
import { MemoryDrive } from '../../src/lib/drive/memoryDrive'
import { DriveError } from '../../src/lib/drive/types'
import { computePrice, DEFAULT_PRICING_SETTINGS } from '../../src/lib/pricing'
import { createMemoryServices, type AppServices } from '../../src/state/services'

function renderApp(services: AppServices, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App services={services} />
    </MemoryRouter>,
  )
}

function codeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? codeFiles(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })
}

function content(name: string, grams = 100, hours = 3.5): BidContent {
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

const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 1])], { type: 'image/jpeg' })
const png = (name: string) => ({ key: name, name, kind: 'image' as const, mimeType: 'image/png', blob: new Blob([new Uint8Array([0x89, 1])], { type: 'image/png' }) })

// ---------------------------------------------------------------------------------------------
describe('AC22 — static: no code path can delete/trash/move/rename or change permissions', () => {
  const files = [...codeFiles(resolve(process.cwd(), 'src')), ...codeFiles(resolve(process.cwd(), 'api'))]

  it('src/ and api/ contain no such Drive request', () => {
    const offenders: string[] = []
    for (const f of files) {
      const code = readFileSync(f, 'utf8')
      if (/method:\s*['"`](DELETE|PUT)['"`]/i.test(code)) offenders.push(`${f}: DELETE/PUT`)
      if (/addParents|removeParents|emptyTrash|\/trash\b|trashed['"]?\s*:\s*true/.test(code)) offenders.push(`${f}: trash/move`)
      if (/\/permissions\b|permissionId|transferOwnership/.test(code)) offenders.push(`${f}: permissions`)
      if (/\/files\/[^'"`]*\/copy/.test(code)) offenders.push(`${f}: copy`)
    }
    expect(offenders).toEqual([])
  })

  it('PATCH is sent from exactly one place (updateFileContent) and its metadata can only be appProperties', () => {
    const patches = files.flatMap((f) => (readFileSync(f, 'utf8').match(/method:\s*['"`]PATCH['"`]/g) ?? []).map(() => f))
    expect(patches.map((f) => f.replace(process.cwd(), ''))).toEqual(['/src/lib/drive/googleDrive.ts'])
    const code = readFileSync(resolve(process.cwd(), 'src/lib/drive/googleDrive.ts'), 'utf8')
    const update = code.slice(code.indexOf('async updateFileContent'), code.indexOf('async readText'))
    expect(update).toContain('decideUpdate(await this.getFile(fileId), options)')
    expect(update).toMatch(/multipart\(\{ appProperties: \{ \.\.\.APP_PROPERTIES \} \}/)
    expect(update).not.toMatch(/\bname\b\s*:|parents\s*:/)
  })

  it('the DriveStore interface has no delete/trash/move/rename/copy/permission operation', () => {
    const types = readFileSync(resolve(process.cwd(), 'src/lib/drive/types.ts'), 'utf8')
    const start = types.indexOf('export interface DriveStore')
    const iface = types.slice(start, types.indexOf('\n}', start))
    expect(iface).not.toMatch(/\b(delete|remove|trash|move|rename|copy|share|permission)\w*\s*\(/i)
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC22 — write guard on the in-memory drive (same rules as the real store)', () => {
  it('everything the app creates is marked; foreign and legacy files are refused', async () => {
    const d = new MemoryDrive()
    const root = d.createRootFolder('models')
    const folder = await d.createFolder(root, 'M')
    const file = await d.uploadFile(folder.id, 'bid.json', new Blob(['{}']), 'application/json')
    expect(folder.appCreated).toBe(true)
    expect(file.appCreated).toBe(true)
    await d.updateFileContent(file.id, new Blob(['{"a":1}']), 'application/json')

    const foreign = d.addForeignFile(folder.id, 'photo.jpg', jpeg(), 'image/jpeg')
    const legacyBid = d.addLegacyAppFile(folder.id, 'bid.json', new Blob(['{}']), 'application/json')
    for (const id of [foreign, legacyBid, folder.id]) {
      await expect(d.updateFileContent(id, new Blob(['x']), 'application/json')).rejects.toBeInstanceOf(DriveError)
    }
    // Claiming the legacy exception for a bid.json does not work (settings/index only).
    await expect(
      d.updateFileContent(legacyBid, new Blob(['x']), 'application/json', { adoptLegacy: { modelsFolderId: folder.id, name: 'bid.json' } }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('legacy settings + index (pre-v0.4, no marker) in the models folder root: rewritten once and marked', async () => {
    const d = new MemoryDrive()
    const root = d.createRootFolder('models')
    const settingsId = d.addLegacyAppFile(root, SETTINGS_FILE_NAME, new Blob([JSON.stringify(defaultAppSettings())]), 'application/json')
    const indexId = d.addLegacyAppFile(root, INDEX_FILE_NAME, new Blob(['[]']), 'application/json')

    await saveSettings(d, root, { ...defaultAppSettings(), pricing: { ...DEFAULT_PRICING_SETTINGS, laborRate: 95 } })
    await rebuildIndex(d, root)
    expect((await d.getFile(settingsId)).appCreated).toBe(true)
    expect((await d.getFile(indexId)).appCreated).toBe(true)
    expect(JSON.parse(await d.readText(settingsId)).pricing.laborRate).toBe(95)
    // No duplicate files were created.
    expect((await d.listChildren(root)).map((f) => f.name).sort()).toEqual([INDEX_FILE_NAME, SETTINGS_FILE_NAME].sort())
  })

  it('a settings-named file in a SUBFOLDER is not covered by the exception', async () => {
    const d = new MemoryDrive()
    const root = d.createRootFolder('models')
    const sub = d.addForeignFolder(root, 'Sub')
    const id = d.addLegacyAppFile(sub, SETTINGS_FILE_NAME, new Blob(['{}']), 'application/json')
    await expect(
      d.updateFileContent(id, new Blob(['x']), 'application/json', { adoptLegacy: { modelsFolderId: root, name: SETTINGS_FILE_NAME } }),
    ).rejects.toMatchObject({ status: 403 })
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC21 — bid.json is created inside an existing Founder folder (drive scope: create children anywhere)', () => {
  it('N2 save writes a marked bid.json into the foreign folder; later edits rewrite only that file', async () => {
    const d = new MemoryDrive()
    const root = d.createRootFolder('models')
    const folder = d.addForeignFolder(root, 'Owl lamp')
    const photo = d.addForeignFile(folder, 'owl.jpg', jpeg(), 'image/jpeg')
    const session = newSaveSession()
    const saved = await saveNewBid(d, root, { folderName: 'Owl lamp', existingFolderId: folder, content: content('Owl lamp'), files: [] }, session)
    expect(saved.folderId).toBe(folder)
    const bidFile = (await d.listChildren(folder, { name: 'bid.json' }))[0]
    expect(bidFile.appCreated).toBe(true)
    await updateBid(d, root, { folderId: folder, existing: saved.bid, content: { ...content('Owl lamp'), laborMinutes: 10 }, newFiles: [] }, newSaveSession())
    const updates = d.writeTargets.filter((w) => w.op === 'updateFileContent').map((w) => w.targetId)
    expect(updates).toContain(bidFile.id)
    expect(updates).not.toContain(photo)
    expect(updates).not.toContain(folder)
  })
})

// ---------------------------------------------------------------------------------------------
describe('M3 — the bid.json with the app marker wins', () => {
  it('classifyFolder / loadModelFolder prefer the marked bid.json over a foreign one listed first', async () => {
    const d = new MemoryDrive()
    const root = d.createRootFolder('models')
    const folder = d.addForeignFolder(root, 'Twin')
    // The Founder's own (foreign) bid.json is listed first; the app's marked one second.
    d.addForeignFile(folder, 'bid.json', new Blob(['{"not":"a bid"}']), 'application/json')
    await d.uploadFile(folder, 'bid.json', new Blob([JSON.stringify({ ...(await validBid(d, root)), name: 'Twin' })]), 'application/json')
    const children = await d.listChildren(folder)
    expect(children.filter((c) => c.name === 'bid.json')).toHaveLength(2)
    expect(classifyFolder(children).bidFile?.appCreated).toBe(true)
    expect((await loadModelFolder(d, folder)).bid?.name).toBe('Twin')
  })
})

async function validBid(d: MemoryDrive, root: string) {
  const r = await saveNewBid(d, root, { folderName: `tmp-${Math.random()}`, content: content('tmp'), files: [] }, newSaveSession())
  return r.bid
}

// ---------------------------------------------------------------------------------------------
describe('I3 — editing a bid never forces a plate picture as its permanent cover', () => {
  it('N2 bid (no explicit cover): an edit that adds a plate picture keeps the folder photo as cover', async () => {
    const d = new MemoryDrive()
    const root = d.createRootFolder('models')
    const folder = d.addForeignFolder(root, 'Vase')
    const photo = d.addForeignFile(folder, 'vase.jpg', jpeg(), 'image/jpeg')
    const saved = await saveNewBid(d, root, { folderName: 'Vase', existingFolderId: folder, content: content('Vase'), files: [] }, newSaveSession())
    expect(saved.bid.coverFileId).toBeUndefined()
    const edited = await updateBid(
      d,
      root,
      { folderId: folder, existing: saved.bid, content: content('Vase'), newFiles: [png('Vase-plate-1.png')] },
      newSaveSession(),
    )
    expect(edited.coverFileId).toBeUndefined()
    const index = JSON.parse(await d.readText((await d.listChildren(root, { name: INDEX_FILE_NAME }))[0].id))
    expect(index.entries.find((e: { id: string }) => e.id === folder).coverFileId).toBe(photo)
  })

  it('a newly added real photo still becomes the cover of a bid without one', async () => {
    const d = new MemoryDrive()
    const root = d.createRootFolder('models')
    const saved = await saveNewBid(d, root, { folderName: 'Bare', content: content('Bare'), files: [] }, newSaveSession())
    const edited = await updateBid(
      d,
      root,
      { folderId: saved.folderId, existing: saved.bid, content: content('Bare'), newFiles: [png('Bare-plate-1.png'), png('real.png')] },
      newSaveSession(),
    )
    const cover = (await d.listChildren(saved.folderId)).find((f) => f.name === 'real.png')
    expect(edited.coverFileId).toBe(cover?.id)
  })
})

// ---------------------------------------------------------------------------------------------
describe('I4 — create-bid only for a direct, non-skipped subfolder of the models folder', () => {
  it('requireModelFolder rejects nested, skipped, outside folders and files', async () => {
    const d = new MemoryDrive()
    const root = d.createRootFolder('models')
    const ok = d.addForeignFolder(root, 'Good')
    const nested = d.addForeignFolder(ok, 'Nested')
    const skipped = d.addForeignFolder(root, '_archive')
    const photos = d.addForeignFolder(root, 'Models photo')
    const outside = d.createRootFolder('elsewhere')
    const file = d.addForeignFile(root, 'x.txt', new Blob(['x']), 'text/plain')
    expect((await requireModelFolder(d, root, ok)).id).toBe(ok)
    for (const id of [nested, skipped, photos, outside, file, root]) {
      await expect(requireModelFolder(d, root, id)).rejects.toMatchObject({ status: 400 })
    }
  })

  it('saveNewBid refuses to write into a nested folder (nothing written)', async () => {
    const d = new MemoryDrive()
    const root = d.createRootFolder('models')
    const nested = d.addForeignFolder(d.addForeignFolder(root, 'Good'), 'Nested')
    const before = d.writeLog.length
    await expect(
      saveNewBid(d, root, { folderName: 'Nested', existingFolderId: nested, content: content('Nested'), files: [] }, newSaveSession()),
    ).rejects.toMatchObject({ status: 400 })
    expect(d.writeLog.length).toBe(before)
  })

  it('/model/:id/create for a nested folder shows a Hebrew error and no form', async () => {
    const services = createMemoryServices()
    const root = services.folderPointer.get() as string
    const nested = services.drive.addForeignFolder(services.drive.addForeignFolder(root, 'Good'), 'Nested')
    renderApp(services, `/model/${nested}/create`)
    expect((await screen.findByRole('alert')).textContent).toMatch(/אינה תיקיית דגם/)
    expect(screen.queryByRole('button', { name: 'שמירה' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
describe('I2 — a freshly created settings file shows a one-time Hebrew notice', () => {
  it('loadSettingsWithStatus reports creation only the first time', async () => {
    const d = new MemoryDrive()
    const root = d.createRootFolder('models')
    expect((await loadSettingsWithStatus(d, root)).created).toBe(true)
    expect((await loadSettingsWithStatus(d, root)).created).toBe(false)
  })

  it('UI: notice after creation, dismissible; no notice when the file already exists', async () => {
    const user = userEvent.setup()
    const services = createMemoryServices()
    const { unmount } = renderApp(services, '/settings')
    const notice = await screen.findByTestId('settings-created-notice')
    expect(notice.textContent).toMatch(/נוצר חדש עם ערכי ברירת המחדל/)
    await user.click(within(notice).getByRole('button', { name: 'הבנתי' }))
    expect(screen.queryByTestId('settings-created-notice')).toBeNull()
    unmount()

    renderApp(services, '/settings')
    await screen.findByLabelText('תעריף עבודה')
    expect(screen.queryByTestId('settings-created-notice')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
describe('M2 — no download button for native Google files', () => {
  it('a Google Doc in a model folder gets a Drive link but no download button', async () => {
    const services = createMemoryServices()
    const root = services.folderPointer.get() as string
    const folder = services.drive.addForeignFolder(root, 'Docs model')
    services.drive.addForeignFile(folder, 'notes', new Blob(['']), 'application/vnd.google-apps.document')
    services.drive.addForeignFile(folder, 'part.stl', new Blob(['solid']), 'model/stl')
    renderApp(services, `/model/${folder}`)
    const list = within(await screen.findByRole('list', { name: 'קבצי הדגם' }))
    const rows = list.getAllByRole('listitem')
    const doc = rows.find((r) => r.textContent?.includes('notes')) as HTMLElement
    const stl = rows.find((r) => r.textContent?.includes('part.stl')) as HTMLElement
    expect(within(doc).getByRole('link', { name: 'notes' })).toBeTruthy()
    expect(within(doc).queryByRole('button')).toBeNull()
    expect(within(stl).getByRole('button', { name: 'הורדה' })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------
describe('M4 — "try again" after a failed refresh re-runs the refresh', () => {
  it('refresh fails → retry rebuilds the index (not just re-reads the cache)', async () => {
    const user = userEvent.setup()
    const services = createMemoryServices()
    const root = services.folderPointer.get() as string
    renderApp(services, '/library')
    await screen.findByRole('button', { name: 'רענון ספרייה' })
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())

    services.drive.addForeignFolder(root, 'Added in Drive')
    services.drive.failNext('listChildren', (arg) => arg === root)
    await user.click(screen.getByRole('button', { name: 'רענון ספרייה' }))
    const alert = await screen.findByRole('alert')
    const rebuild = vi.spyOn(services.drive, 'listChildren')
    await user.click(within(alert).getByRole('button', { name: 'נסו שוב' }))
    await screen.findByText('Added in Drive')
    // A rebuild lists the models folder's subfolders (a plain load would only read the cached index).
    expect(rebuild.mock.calls.some(([id, o]) => id === root && o?.foldersOnly === true)).toBe(true)
  })
})
