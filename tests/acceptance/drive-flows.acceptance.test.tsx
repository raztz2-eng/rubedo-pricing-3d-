import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newSaveSession, saveNewBid, type BidContent } from '../../src/lib/drive/bidRepository'
import { computePrice, DEFAULT_PRICING_SETTINGS } from '../../src/lib/pricing'
import {
  addManualPart,
  fixtureFile,
  moneyIn,
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

async function folderByName(drive: Drive, root: string, name: string) {
  const f = (await drive.listChildren(root, { foldersOnly: true })).find((x) => x.name === name)
  if (!f) throw new Error(`folder ${name} not found`)
  return f
}

async function readBid(drive: Drive, folderId: string) {
  const file = (await drive.listChildren(folderId, { name: 'bid.json' }))[0]
  if (!file) throw new Error('bid.json missing')
  return { text: await drive.readText(file.id), json: JSON.parse(await drive.readText(file.id)) }
}

/** Fills the New model form with T1 inputs (100 g / 3.5 h / 10 min). */
async function fillT1(user: ReturnType<typeof userEvent.setup>, name: string) {
  setValue(await screen.findByLabelText(/^שם \*$/), name)
  await addManualPart(user, '100', '3.5')
  setValue(screen.getByLabelText('זמן עבודה'), '10')
}

function content(name: string, grams: number, hours: number, description = ''): BidContent {
  const s = { ...DEFAULT_PRICING_SETTINGS }
  const input = { pricePerKg: 85, parts: [{ qty: 1, grams, hours }], laborMinutes: 0, hardware: [], hasShipping: false, packaging: [], shippingCost: 0 }
  return {
    name,
    revision: 'V1',
    description,
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

// ---------------------------------------------------------------------------------------------
describe('AC7 — save creates <models>/<name>/ with bid.json + all files; bid.json last', () => {
  it('AC7.ui: picture + model file + sliced file → folder with all of them and bid.json written last', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    renderApp(services, '/new')
    setValue(await screen.findByLabelText(/^שם \*$/), 'Stand')
    setValue(screen.getByLabelText('תיאור'), 'desc')
    await user.upload(screen.getByLabelText('העלאת קובץ פרוס'), fixtureFile('rooting-stand.gcode.3mf'))
    await screen.findAllByTestId('part-row')
    await user.upload(screen.getByLabelText('הוספת תמונות'), pngFile('photo.png'))
    await user.upload(screen.getByLabelText('הוספת קבצי דגם'), new File(['solid x'], 'part.stl'))

    const logStart = services.drive.writeLog.length
    await user.click(saveButton())
    await screen.findByRole('heading', { name: 'Stand' })

    const folders = await services.drive.listChildren(root, { foldersOnly: true })
    expect(folders.map((f) => f.name)).toEqual(['Stand'])
    const names = (await services.drive.listChildren(folders[0].id)).map((f) => f.name).sort()
    expect(names).toEqual(['Stand-plate-1.png', 'bid.json', 'part.stl', 'photo.png', 'rooting-stand.gcode.3mf'].sort())

    // bid.json written after every file of the folder (and never rewritten before a file upload).
    const log = services.drive.writeLog.slice(logStart)
    const bidIdx = log.indexOf('upload:bid.json')
    expect(bidIdx).toBeGreaterThan(-1)
    for (const n of ['Stand-plate-1.png', 'part.stl', 'photo.png', 'rooting-stand.gcode.3mf']) {
      const i = log.indexOf(`upload:${n}`)
      expect(i, `upload of ${n}`).toBeGreaterThan(-1)
      expect(i, `${n} must be uploaded before bid.json`).toBeLessThan(bidIdx)
    }
    expect(log.indexOf('folder:Stand')).toBeLessThan(bidIdx)

    // bid.json references every uploaded file with the right kind, and follows the schema.
    const { json: bid } = await readBid(services.drive, folders[0].id)
    expect(bid.schemaVersion).toBe(2) // v0.5 Q1
    expect(bid.name).toBe('Stand')
    expect(bid.revision).toBe('V1')
    expect(bid.description).toBe('desc')
    const byName = Object.fromEntries(bid.files.map((f: { name: string; kind: string }) => [f.name, f.kind]))
    expect(byName).toEqual({
      'photo.png': 'image',
      'Stand-plate-1.png': 'image',
      'part.stl': 'model',
      'rooting-stand.gcode.3mf': 'sliced',
    })
    const childIds = (await services.drive.listChildren(folders[0].id)).map((f) => f.id)
    for (const f of bid.files) expect(childIds).toContain(f.id)
    for (const k of ['efficiency', 'laborRate', 'printerCost', 'upgrades', 'maintenancePerYear', 'lifeYears', 'uptime', 'powerW', 'kwhPrice', 'buffer']) {
      expect(bid.settingsSnapshot, `settingsSnapshot.${k}`).toHaveProperty(k)
    }
    expect(bid.result.price70.toFixed(2)).toBe('23.17')
  })

  it('AC7.retry (§5): an upload failure shows a Hebrew error, keeps the form, retry reuses the folder and skips uploaded files', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    renderApp(services, '/new')
    setValue(await screen.findByLabelText(/^שם \*$/), 'Retry')
    await user.upload(screen.getByLabelText('העלאת קובץ פרוס'), fixtureFile('rooting-stand.gcode.3mf'))
    await screen.findAllByTestId('part-row')
    services.drive.failNext('uploadFile', (n) => n === 'rooting-stand.gcode.3mf')

    await user.click(saveButton())
    const alert = await screen.findByText(/נסו שוב|נכשל|שגיאה/)
    expect(alert.textContent).toMatch(/[֐-׿]/)
    expect(nameInput().value).toBe('Retry')
    expect(screen.getAllByTestId('part-row')).toHaveLength(1)
    const partial = await folderByName(services.drive, root, 'Retry')
    expect((await services.drive.listChildren(partial.id, { name: 'bid.json' })).length).toBe(0)

    await user.click(saveButton())
    await screen.findByRole('heading', { name: 'Retry' })
    const folders = await services.drive.listChildren(root, { foldersOnly: true })
    expect(folders.map((f) => f.name)).toEqual(['Retry'])
    const names = (await services.drive.listChildren(folders[0].id)).map((f) => f.name).sort()
    expect(names).toEqual(['Retry-plate-1.png', 'bid.json', 'rooting-stand.gcode.3mf'].sort())
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC8 — saving an existing name never overwrites; offers V2 or rename', () => {
  it('AC8.v2: second "Stand" → dialog; nothing written until a choice; V2 → "Stand V2" folder, original bid.json unchanged', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    renderApp(services, '/new')
    await fillT1(user, 'Stand')
    await user.click(saveButton())
    await screen.findByRole('heading', { name: 'Stand' })
    const original = await folderByName(services.drive, root, 'Stand')
    const originalText = (await readBid(services.drive, original.id)).text

    await user.click(navLink('דגם חדש'))
    setValue(await screen.findByLabelText(/^שם \*$/), 'Stand')
    await addManualPart(user, '10', '1')
    const logBefore = services.drive.writeLog.length
    await user.click(saveButton())
    const dialog = await screen.findByRole('dialog')
    expect(services.drive.writeLog.length).toBe(logBefore)
    expect(within(dialog).getByRole('button', { name: /גרסה חדשה.*V2/ })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: /שם אחר/ })).toBeTruthy()

    await user.click(within(dialog).getByRole('button', { name: /גרסה חדשה.*V2/ }))
    await screen.findByText(/גרסה V2/)
    const names = (await services.drive.listChildren(root, { foldersOnly: true })).map((f) => f.name)
    expect(names).toEqual(['Stand', 'Stand V2'])
    expect((await readBid(services.drive, original.id)).text).toBe(originalText)
    const v2 = await folderByName(services.drive, root, 'Stand V2')
    expect((await readBid(services.drive, v2.id)).json.revision).toBe('V2')

    // Third time → V3.
    await user.click(navLink('דגם חדש'))
    setValue(await screen.findByLabelText(/^שם \*$/), 'Stand')
    await addManualPart(user, '10', '1')
    await user.click(saveButton())
    const d3 = await screen.findByRole('dialog')
    expect(within(d3).getByRole('button', { name: /גרסה חדשה.*V3/ })).toBeTruthy()
  })

  it('AC8.rename: "choose another name" closes the dialog, writes nothing, and a new name saves to its own folder', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    renderApp(services, '/new')
    await fillT1(user, 'Stand')
    await user.click(saveButton())
    await screen.findByRole('heading', { name: 'Stand' })
    const original = await folderByName(services.drive, root, 'Stand')
    const originalText = (await readBid(services.drive, original.id)).text

    await user.click(navLink('דגם חדש'))
    await fillT1(user, 'Stand')
    await user.click(saveButton())
    const dialog = await screen.findByRole('dialog')
    const logBefore = services.drive.writeLog.length
    await user.click(within(dialog).getByRole('button', { name: /שם אחר/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(services.drive.writeLog.length).toBe(logBefore)

    setValue(nameInput(), 'Stand B')
    await user.click(saveButton())
    await screen.findByRole('heading', { name: 'Stand B' })
    const names = (await services.drive.listChildren(root, { foldersOnly: true })).map((f) => f.name)
    expect(names).toEqual(['Stand', 'Stand B'])
    expect((await readBid(services.drive, original.id)).text).toBe(originalText)
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC9 — Library lists every saved model (cover, name, 70% price); folders without bid.json ignored', () => {
  let restore: () => void
  beforeEach(() => {
    restore = stubObjectUrls()
  })
  afterEach(() => restore())

  it('AC9.list: two bids (one with a picture) + an orphan folder → two cards, newest first, cover/placeholder, 70% price', async () => {
    const { services, root } = newServices()
    const drive = services.drive
    await saveNewBid(
      drive,
      root,
      { folderName: 'Alpha', content: content('Alpha', 100, 3.5), files: [{ key: 'img', name: 'a.png', kind: 'image', mimeType: 'image/png', blob: pngFile('a.png') }], now: new Date('2026-01-01T00:00:00Z') },
      newSaveSession(),
    )
    await saveNewBid(drive, root, { folderName: 'Beta', content: content('Beta', 55.94, 9312 / 3600), files: [], now: new Date('2026-02-01T00:00:00Z') }, newSaveSession())
    const orphan = await drive.createFolder(root, 'Orphan')
    await drive.uploadFile(orphan.id, 'photo.png', pngFile('photo.png'), 'image/png')

    const user = userEvent.setup()
    renderApp(services, '/library')
    const cards = await screen.findAllByTestId('library-card')
    expect(cards).toHaveLength(2)
    expect(cards[0].textContent).toContain('Beta')
    expect(cards[1].textContent).toContain('Alpha')
    // T2 → 23.17; Alpha: 100 g / 3.5 h / 0 min → 9.35 + 3.5 × 0.664983 = 11.6774 → ÷0.3 = 38.9248 → 38.92
    expect(cards[0].textContent).toContain('₪23.17')
    expect(cards[1].textContent).toContain('₪38.92')
    await waitFor(() => expect(within(cards[1]).getByRole('img', { name: 'Alpha' })).toBeTruthy())
    expect(within(cards[0]).queryByRole('img', { name: 'Beta' })).toBeNull()
    expect(screen.queryByText('Orphan')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'רענון ספרייה' }))
    await waitFor(() => expect(screen.getAllByTestId('library-card')).toHaveLength(2))
    expect(screen.queryByText('Orphan')).toBeNull()

    await user.type(screen.getByLabelText('חיפוש לפי שם'), 'alp')
    await waitFor(() => expect(screen.getAllByTestId('library-card')).toHaveLength(1))
    expect(screen.getByTestId('library-card').textContent).toContain('Alpha')
  })

  it('AC9.partial: a save that failed before bid.json leaves a folder that never appears in the Library', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    renderApp(services, '/new')
    await fillT1(user, 'Broken')
    services.drive.failNext('uploadFile', (n) => n === 'bid.json')
    await user.click(saveButton())
    await screen.findByText(/נסו שוב|נכשל|שגיאה/)

    await user.click(navLink('ספרייה'))
    await screen.findByRole('button', { name: 'רענון ספרייה' })
    await waitFor(() => expect(screen.getByText(/אין עדיין דגמים שמורים/)).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'רענון ספרייה' }))
    await waitFor(() => expect(screen.queryAllByTestId('library-card')).toHaveLength(0))
  })

  it('AC9.ui: a bid saved through the form appears in the Library with its 70% price', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    renderApp(services, '/new')
    await fillT1(user, 'T1 model')
    await user.click(saveButton())
    await screen.findByRole('heading', { name: 'T1 model' })
    await user.click(navLink('ספרייה'))
    const cards = await screen.findAllByTestId('library-card')
    expect(cards).toHaveLength(1)
    expect(cards[0].textContent).toContain('T1 model')
    expect(cards[0].textContent).toContain('₪83.37')
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC10 — Model page', () => {
  let restore: () => void
  beforeEach(() => {
    restore = stubObjectUrls()
  })
  afterEach(() => {
    restore()
    vi.restoreAllMocks()
  })

  it('AC10.full: description, breakdown, 50/60/70, pictures, Drive folder link, Bambu download of the sliced file', async () => {
    const clicks: { download: string; href: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ download: this.download, href: this.href })
    })
    const user = userEvent.setup()
    const { services, root } = newServices()
    renderApp(services, '/new')
    setValue(await screen.findByLabelText(/^שם \*$/), 'Stand')
    setValue(screen.getByLabelText('תיאור'), 'A small rooting stand')
    await user.upload(screen.getByLabelText('העלאת קובץ פרוס'), fixtureFile('rooting-stand.gcode.3mf'))
    await screen.findAllByTestId('part-row')
    await user.upload(screen.getByLabelText('הוספת תמונות'), pngFile('photo.png'))
    await user.click(saveButton())
    await screen.findByRole('heading', { name: 'Stand' })

    expect(screen.getByText('A small rooting stand')).toBeTruthy()
    expect(panel()).toMatchObject({
      filament: '₪5.23',
      labor: '₪0.00',
      machine: '₪1.72',
      landed: '₪6.95',
      p50: '₪13.90',
      p60: '₪17.38',
      p70: '₪23.17',
    })
    expect(moneyIn('price-70')).toBe('₪23.17')

    const gallery = within(screen.getByRole('region', { name: 'תמונות' }))
    await waitFor(() => expect(gallery.getAllByRole('img')).toHaveLength(2))

    const folder = await folderByName(services.drive, root, 'Stand')
    const link = screen.getByRole('link', { name: /פתיחת התיקייה ב-Drive/ }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(services.drive.folderUrl(folder.id))

    const dl = screen.getByRole('button', { name: 'הורדה ל-Bambu Studio' })
    expect(dl.getAttribute('title') ?? '').toMatch(/Bambu Studio/)
    await user.click(dl)
    await waitFor(() => expect(clicks).toHaveLength(1))
    expect(clicks[0].download).toBe('rooting-stand.gcode.3mf')
  })

  it('AC10.no-sliced: a bid without a sliced file shows no Bambu download button', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    renderApp(services, '/new')
    await fillT1(user, 'Manual only')
    await user.click(saveButton())
    await screen.findByRole('heading', { name: 'Manual only' })
    expect(screen.getByRole('link', { name: /פתיחת התיקייה ב-Drive/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'הורדה ל-Bambu Studio' })).toBeNull()
    expect(panel().p70).toBe('₪83.37')
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC11 — Settings affect new bids only; existing bids keep their snapshot', () => {
  it('AC11.ui: T1 saved at 80 ₪/h; laborRate→20; old bid stays 83.37 (page, library, edit, re-save); new bid is 50.04', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    renderApp(services, '/new')
    await fillT1(user, 'Old')
    await user.click(saveButton())
    await screen.findByRole('heading', { name: 'Old' })
    expect(panel().p70).toBe('₪83.37')
    const oldFolder = await folderByName(services.drive, root, 'Old')

    await user.click(navLink('הגדרות'))
    setValue(await screen.findByLabelText('תעריף עבודה'), '20')
    await user.click(screen.getByRole('button', { name: 'שמירת הגדרות' }))
    await screen.findByText(/^נשמר\./)

    // Existing bid: bid.json snapshot unchanged.
    const saved = (await readBid(services.drive, oldFolder.id)).json
    expect(saved.settingsSnapshot.laborRate).toBe(80)
    expect(saved.result.price70.toFixed(2)).toBe('83.37')

    // Library still shows the old price.
    await user.click(navLink('ספרייה'))
    const cards = await screen.findAllByTestId('library-card')
    expect(cards[0].textContent).toContain('₪83.37')

    // Model page still shows the old values.
    await user.click(cards[0])
    await screen.findByRole('heading', { name: 'Old' })
    expect(panel()).toMatchObject({ labor: '₪13.33', p70: '₪83.37' })

    // Edit keeps the snapshot; saving without "recalculate" keeps laborRate 80.
    await user.click(screen.getByRole('link', { name: 'עריכה' }))
    await screen.findByRole('heading', { name: /עריכת Old/ })
    expect(panel()).toMatchObject({ labor: '₪13.33', p70: '₪83.37' })
    setValue(screen.getByLabelText('תיאור'), 'edited')
    await user.click(saveButton())
    await screen.findByRole('heading', { name: 'Old' })
    const edited = (await readBid(services.drive, oldFolder.id)).json
    expect(edited.description).toBe('edited')
    expect(edited.settingsSnapshot.laborRate).toBe(80)
    expect(edited.result.price70.toFixed(2)).toBe('83.37')

    // New bid uses the new settings (T0).
    await user.click(navLink('דגם חדש'))
    await fillT1(user, 'New')
    expect(panel()).toMatchObject({ labor: '₪3.33', landed: '₪15.01', p70: '₪50.04' })
    await user.click(saveButton())
    await screen.findByRole('heading', { name: 'New' })
    const newBid = (await readBid(services.drive, (await folderByName(services.drive, root, 'New')).id)).json
    expect(newBid.settingsSnapshot.laborRate).toBe(20)
  })
})
