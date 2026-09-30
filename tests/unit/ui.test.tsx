import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/App'
import { BID_FILE_NAME } from '../../src/lib/bid'
import { GoogleAuth } from '../../src/lib/auth/googleAuth'
import { DRIVE_SCOPE } from '../../src/lib/config'
import { MemoryDrive } from '../../src/lib/drive/memoryDrive'
import type { DriveFile, DriveStore, ListOptions } from '../../src/lib/drive/types'
import {
  createMemoryServices,
  createUnconfiguredServices,
  memoryFolderPointer,
  type AppServices,
} from '../../src/state/services'

function renderApp(services: AppServices, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App services={services} />
    </MemoryRouter>,
  )
}

function fixtureFile(name: string): File {
  return new File([readFileSync(resolve(process.cwd(), 'tests/fixtures', name))], name)
}

describe('Home', () => {
  it('shows brand, two buttons, and a Hebrew notice when Google is not configured', () => {
    renderApp(createUnconfiguredServices())
    expect(screen.getByText('RUBEDO')).toBeTruthy()
    const main = within(screen.getByRole('main'))
    expect(main.getByRole('link', { name: /^ספרייה/ })).toBeTruthy()
    expect(main.getByRole('link', { name: /^דגם חדש/ })).toBeTruthy()
    expect(screen.getByText(/האפליקציה עדיין לא מחוברת ל-Google/)).toBeTruthy()
  })
})

describe('New model form', () => {
  it('uploading rooting-stand creates one editable 3mf part and prices it (T2)', async () => {
    const user = userEvent.setup()
    renderApp(createMemoryServices(), '/new')
    const input = await screen.findByLabelText('העלאת קובץ פרוס')
    await user.upload(input, fixtureFile('rooting-stand.gcode.3mf'))

    const rows = await screen.findAllByTestId('part-row')
    expect(rows).toHaveLength(1)
    const row = within(rows[0])
    expect((row.getByLabelText('שם החלק') as HTMLInputElement).value).toContain('Rooting stand')
    expect((row.getByLabelText('משקל') as HTMLInputElement).value).toBe('55.94')
    expect((row.getByLabelText('זמן הדפסה') as HTMLInputElement).value).toBe('2.587')
    expect(row.getByTestId('part-source').textContent).toBe('מקובץ פרוס')
    expect(screen.getByTestId('price-70').textContent).toContain('₪23.17')
    expect((screen.getByLabelText('חומר') as HTMLSelectElement).value).toBe('PLA')
    expect(screen.getByText(/להשתמש בתמונת הפלטה 1/)).toBeTruthy()

    await user.clear(row.getByLabelText('משקל'))
    await user.type(row.getByLabelText('משקל'), '60')
    expect(row.getByTestId('part-source').textContent).toBe('ידני')
  })

  it('an invalid file shows a Hebrew error and fills nothing', async () => {
    const user = userEvent.setup()
    renderApp(createMemoryServices(), '/new')
    const input = await screen.findByLabelText('העלאת קובץ פרוס')
    await user.upload(input, new File(['not a zip'], 'bad.3mf'))
    expect(await screen.findByText(/לא ניתן לקרוא את הקובץ/)).toBeTruthy()
    expect(screen.queryAllByTestId('part-row')).toHaveLength(0)
    expect(screen.getByTestId('price-70').textContent).toContain('₪0.00')
  })

  it('shipping toggle shows/hides the packaging section', async () => {
    const user = userEvent.setup()
    renderApp(createMemoryServices(), '/new')
    const toggle = await screen.findByLabelText('כולל אריזה ומשלוח')
    expect(screen.queryByTestId('packaging-section')).toBeNull()
    await user.click(toggle)
    expect(screen.getByTestId('packaging-section')).toBeTruthy()
    await user.click(toggle)
    expect(screen.queryByTestId('packaging-section')).toBeNull()
  })

  it('saves, opens the model page, and a second save with the same name offers V2', async () => {
    const user = userEvent.setup()
    const services = createMemoryServices()
    const root = services.folderPointer.get() as string
    renderApp(services, '/new')

    const save = await screen.findByRole('button', { name: 'שמירה' })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    await user.type(screen.getByLabelText(/^שם/), 'Stand')
    await user.upload(screen.getByLabelText('העלאת קובץ פרוס'), fixtureFile('rooting-stand.gcode.3mf'))
    await screen.findAllByTestId('part-row')
    expect((save as HTMLButtonElement).disabled).toBe(false)
    await user.click(save)

    expect(await screen.findByRole('heading', { name: 'Stand' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'הורדה ל-Bambu Studio' })).toBeTruthy()
    const folders = await services.drive.listChildren(root, { foldersOnly: true })
    expect(folders.map((f) => f.name)).toEqual(['Stand'])
    const names = (await services.drive.listChildren(folders[0].id)).map((f) => f.name)
    expect(names).toEqual(['Stand-plate-1.png', 'rooting-stand.gcode.3mf', BID_FILE_NAME])

    // Second bid with the same name.
    await user.click(within(screen.getByRole('navigation')).getByRole('link', { name: 'דגם חדש' }))
    await user.type(await screen.findByLabelText(/^שם/), 'Stand')
    await user.click(screen.getByRole('button', { name: /הוספת חלק ידנית/ }))
    await user.type(screen.getByLabelText('משקל'), '10')
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /גרסה חדשה \(V2\)/ }))
    expect(await screen.findByText(/גרסה V2/)).toBeTruthy()
    const after = await services.drive.listChildren(root, { foldersOnly: true })
    expect(after.map((f) => f.name)).toEqual(['Stand', 'Stand V2'])
  })
})

describe('Library', () => {
  it('lists saved models with the 70% price; folders without bid.json are ignored', async () => {
    const services = createMemoryServices()
    const root = services.folderPointer.get() as string
    const { seedDemo } = await import('../../src/state/demoSeed')
    await seedDemo(services.drive, root)
    await services.drive.createFolder(root, 'no-bid-here')
    const user = userEvent.setup()
    renderApp(services, '/library')
    const cards = await screen.findAllByTestId('library-card')
    expect(cards).toHaveLength(1)
    expect(cards[0].textContent).toContain('₪83.37')
    await user.click(screen.getByRole('button', { name: 'רענון ספרייה' }))
    await waitFor(() => expect(screen.getAllByTestId('library-card')).toHaveLength(1))
  })
})

describe('Fix round 1 — form robustness', () => {
  it('number fields are text inputs with a decimal keyboard; "4,200" is 4200, "1,5" and "-3" are flagged', async () => {
    const user = userEvent.setup()
    renderApp(createMemoryServices(), '/new')
    await user.click(await screen.findByRole('button', { name: /הוספת חלק ידנית/ }))
    const grams = screen.getByLabelText('משקל') as HTMLInputElement
    expect(grams.type).toBe('text')
    expect(grams.inputMode).toBe('decimal')
    expect(grams.getAttribute('dir')).toBe('ltr')

    await user.type(screen.getByLabelText(/^שם\s*\*$/), 'X')
    await user.type(grams, '1,000')
    await user.type(screen.getByLabelText('זמן הדפסה'), '1.5')
    // filament 1000 g → 93.50; machine 1.5 h × 0.66498 = 0.99747 → landed 94.49747
    expect(screen.getByTestId('cost-landed').textContent).toContain('₪94.50')
    expect(screen.queryByText(/ערכים לא תקינים/)).toBeNull()

    await user.clear(grams)
    await user.type(grams, '1,5')
    expect(grams.value).toBe('1,5')
    expect(screen.getByText(/ערכים לא תקינים: .*חלק 1 — גרמים/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'שמירה' }) as HTMLButtonElement).disabled).toBe(true)

    await user.clear(grams)
    await user.type(grams, '-3')
    expect(screen.getByText(/ערכים לא תקינים: .*חלק 1 — גרמים/)).toBeTruthy()
  })

  it('after a failed save that created the folder, the name is locked with a Hebrew explanation; retry completes', async () => {
    const user = userEvent.setup()
    const services = createMemoryServices()
    const root = services.folderPointer.get() as string
    renderApp(services, '/new')
    await user.type(await screen.findByLabelText(/^שם\s*\*$/), 'Lock')
    await user.click(screen.getByRole('button', { name: /הוספת חלק ידנית/ }))
    await user.type(screen.getByLabelText('משקל'), '10')

    services.drive.failNext('uploadFile', (name) => name === BID_FILE_NAME)
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    await screen.findByText(/אפשר ללחוץ שוב על "שמירה"/)
    const name = screen.getByLabelText(/^שם\s*\*$/) as HTMLInputElement
    expect(name.disabled).toBe(true)
    expect(screen.getByText(/השם נעול/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    expect(await screen.findByRole('heading', { name: 'Lock' })).toBeTruthy()
    expect((await services.drive.listChildren(root, { foldersOnly: true })).map((f) => f.name)).toEqual(['Lock'])
  })

  it('renaming during edit to another bid’s name shows an error and overwrites nothing', async () => {
    const user = userEvent.setup()
    const services = createMemoryServices()
    const root = services.folderPointer.get() as string
    const { saveNewBid, newSaveSession, loadBid } = await import('../../src/lib/drive/bidRepository')
    const { computePrice, DEFAULT_PRICING_SETTINGS } = await import('../../src/lib/pricing')
    const mk = (name: string) => ({
      name,
      revision: 'V1',
      description: '',
      material: { name: 'PLA', pricePerKg: 85 },
      parts: [{ name: 'p', qty: 1, grams: 10, hours: 1, source: 'manual' as const }],
      laborMinutes: 0,
      hardware: [],
      hasShipping: false,
      packaging: [],
      shippingCost: 0,
      settingsSnapshot: { ...DEFAULT_PRICING_SETTINGS },
      result: computePrice(
        { pricePerKg: 85, parts: [{ qty: 1, grams: 10, hours: 1 }], laborMinutes: 0, hardware: [], hasShipping: false, packaging: [], shippingCost: 0 },
        DEFAULT_PRICING_SETTINGS,
      ),
    })
    const a = await saveNewBid(services.drive, root, { folderName: 'Alpha', content: mk('Alpha'), files: [] }, newSaveSession())
    const b = await saveNewBid(services.drive, root, { folderName: 'Beta', content: mk('Beta'), files: [] }, newSaveSession())

    renderApp(services, `/model/${a.folderId}/edit`)
    const name = (await screen.findByLabelText(/^שם\s*\*$/)) as HTMLInputElement
    await user.clear(name)
    await user.type(name, 'beta')
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    expect(await screen.findByText(/כבר קיים דגם אחר בשם/)).toBeTruthy()
    expect((await loadBid(services.drive, a.folderId)).bid.name).toBe('Alpha')
    expect((await loadBid(services.drive, b.folderId)).bid.name).toBe('Beta')

    // Keeping its own name (case change) is allowed.
    await user.clear(name)
    await user.type(name, 'ALPHA')
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    expect(await screen.findByRole('heading', { name: 'ALPHA' })).toBeTruthy()
  })
})

/** MemoryDrive that needs a token for every call, like the real Drive store (401 → refresh). */
class TokenGatedDrive implements DriveStore {
  /** When set, the upload of this file name first gets a 401 → auth.refresh(). */
  refreshBeforeUploadOf: string | null = null
  constructor(
    readonly inner: MemoryDrive,
    private readonly auth: GoogleAuth,
  ) {}
  private async token() {
    await this.auth.getToken()
  }
  async listChildren(id: string, o?: ListOptions): Promise<DriveFile[]> {
    await this.token()
    return this.inner.listChildren(id, o)
  }
  async createFolder(p: string, n: string) {
    await this.token()
    return this.inner.createFolder(p, n)
  }
  async uploadFile(p: string, n: string, d: Blob, m: string) {
    await this.token()
    if (this.refreshBeforeUploadOf === n) {
      this.refreshBeforeUploadOf = null
      await this.auth.refresh()
    }
    return this.inner.uploadFile(p, n, d, m)
  }
  async updateFileContent(id: string, d: Blob, m: string) {
    await this.token()
    return this.inner.updateFileContent(id, d, m)
  }
  async readText(id: string) {
    await this.token()
    return this.inner.readText(id)
  }
  async readBlob(id: string) {
    await this.token()
    return this.inner.readBlob(id)
  }
  async getFile(id: string) {
    await this.token()
    return this.inner.getFile(id)
  }
  async readThumbnail(link: string) {
    await this.token()
    return this.inner.readThumbnail(link)
  }
  folderUrl(id: string) {
    return this.inner.folderUrl(id)
  }
  fileUrl(id: string) {
    return this.inner.fileUrl(id)
  }
}

describe('Fix round 2 — lost Google connection during a save', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as Window).google
  })

  it('renewal fails mid-save → error + reconnect prompt, form kept; after reconnect the retry completes into the SAME folder', async () => {
    let gisMode: 'grant' | 'fail' = 'grant'
    let n = 0
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (c) => ({
            requestAccessToken: () =>
              setTimeout(() => {
                n += 1
                if (gisMode === 'grant') c.callback({ access_token: `T${n}`, expires_in: 3600, scope: DRIVE_SCOPE })
                else c.error_callback?.({ type: 'popup_failed_to_open' })
              }, 0),
          }),
          revoke: vi.fn(),
        },
      },
    }
    vi.spyOn(document.head, 'appendChild').mockImplementation((el) => {
      queueMicrotask(() => (el as HTMLScriptElement).onload?.(new Event('load')))
      return el
    })
    const auth = new GoogleAuth('cid')
    await auth.init()
    const mem = new MemoryDrive()
    const root = mem.createRootFolder('models')
    const drive = new TokenGatedDrive(mem, auth)
    const services: AppServices = {
      mode: 'google',
      drive,
      auth,
      folderPointer: memoryFolderPointer(root),
      pickFolder: async () => null,
    }
    const user = userEvent.setup()
    renderApp(services, '/new')
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'התחברות עם Google' }))
    await screen.findByText('מחובר ל-Google')

    const name = (await screen.findByLabelText(/^שם\s*\*$/)) as HTMLInputElement
    await user.type(name, 'Stand')
    await user.upload(screen.getByLabelText('העלאת קובץ פרוס'), fixtureFile('rooting-stand.gcode.3mf'))
    await screen.findAllByTestId('part-row')
    await user.type(screen.getByLabelText('זמן עבודה'), '15')

    // The token "expires" while uploading the sliced file; the silent renewal popup is blocked.
    drive.refreshBeforeUploadOf = 'rooting-stand.gcode.3mf'
    gisMode = 'fail'
    await user.click(screen.getByRole('button', { name: 'שמירה' }))

    expect(await screen.findByText(/החיבור ל-Google פג — לחצו 'התחבר מחדש'/)).toBeTruthy()
    const reconnect = screen.getByRole('button', { name: 'התחבר מחדש' })
    expect(screen.getByText('נדרש חיבור מחדש')).toBeTruthy()
    // Form is still mounted with everything in it.
    expect((screen.getByLabelText(/^שם\s*\*$/) as HTMLInputElement).value).toBe('Stand')
    expect((screen.getByLabelText(/^שם\s*\*$/) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('משקל') as HTMLInputElement).value).toBe('55.94')
    expect((screen.getByLabelText('זמן עבודה') as HTMLInputElement).value).toBe('15')
    expect(screen.getByText('rooting-stand.gcode.3mf')).toBeTruthy()
    expect(screen.getByText(/להשתמש בתמונת הפלטה 1/)).toBeTruthy()
    const foldersAfterFailure = await mem.listChildren(root, { foldersOnly: true })
    expect(foldersAfterFailure.map((f) => f.name)).toEqual(['Stand'])

    gisMode = 'grant'
    await user.click(reconnect)
    await screen.findByText('מחובר ל-Google')
    expect(screen.queryByRole('button', { name: 'התחבר מחדש' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    expect(await screen.findByRole('heading', { name: 'Stand' })).toBeTruthy()
    const folders = await mem.listChildren(root, { foldersOnly: true })
    expect(folders.map((f) => f.id)).toEqual([foldersAfterFailure[0].id])
    expect((await mem.listChildren(folders[0].id)).map((f) => f.name)).toEqual([
      'Stand-plate-1.png',
      'rooting-stand.gcode.3mf',
      BID_FILE_NAME,
    ])
  })
})

describe('Fix round 2 — Settings validation', () => {
  it('negative or malformed values are listed and block saving', async () => {
    const user = userEvent.setup()
    renderApp(createMemoryServices(), '/settings')
    const labor = await screen.findByLabelText('תעריף עבודה')
    const save = screen.getByRole('button', { name: 'שמירת הגדרות' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await user.clear(labor)
    await user.type(labor, '-80')
    expect(screen.getByTestId('settings-invalid').textContent).toContain('תעריף עבודה')
    expect(save.disabled).toBe(true)
    await user.clear(labor)
    await user.type(labor, '80')
    const price = screen.getAllByLabelText('מחיר')[0]
    await user.clear(price)
    await user.type(price, '1,5')
    expect(screen.getByTestId('settings-invalid').textContent).toContain('חומר 1')
    expect(save.disabled).toBe(true)
    await user.clear(price)
    await user.type(price, '4,200')
    expect(screen.queryByTestId('settings-invalid')).toBeNull()
    expect(save.disabled).toBe(false)
  })
})

describe('Fix round 3 — switching the models folder', () => {
  /** MemoryDrive whose reads of chosen files wait until released (to observe the in-between render). */
  class GatedDrive extends MemoryDrive {
    gated = new Set<string>()
    private waiters: (() => void)[] = []
    release() {
      this.gated.clear()
      for (const w of this.waiters.splice(0)) w()
    }
    async readText(fileId: string): Promise<string> {
      if (this.gated.has(fileId)) await new Promise<void>((r) => this.waiters.push(r))
      return super.readText(fileId)
    }
  }

  async function settingsFile(drive: MemoryDrive, folderId: string) {
    const { SETTINGS_FILE_NAME } = await import('../../src/lib/bid')
    const f = (await drive.listChildren(folderId, { name: SETTINGS_FILE_NAME }))[0]
    return f ? (JSON.parse(await drive.readText(f.id)) as { pricing: { laborRate: number } }) : null
  }

  it("the form shows the NEW folder's values (never the old ones) and nothing is written until Save", async () => {
    const { saveSettings } = await import('../../src/lib/drive/bidRepository')
    const { defaultAppSettings } = await import('../../src/lib/bid')
    const drive = new GatedDrive()
    const services = createMemoryServices(drive)
    const folderA = services.folderPointer.get() as string
    const folderB = drive.createRootFolder('models-B')
    const custom = (laborRate: number) => ({ ...defaultAppSettings(), pricing: { ...defaultAppSettings().pricing, laborRate } })
    await saveSettings(drive, folderA, custom(100))
    await saveSettings(drive, folderB, custom(120))
    const bSettingsId = (await drive.listChildren(folderB)).find((f) => f.name.startsWith('_rubedo-settings'))!.id
    services.pickFolder = async () => ({ id: folderB, name: 'models-B' })

    const user = userEvent.setup()
    renderApp(services, '/settings')
    expect(((await screen.findByLabelText('תעריף עבודה')) as HTMLInputElement).value).toBe('100')

    const writesBefore = drive.writeLog.length
    drive.gated.add(bSettingsId)
    await user.click(screen.getByRole('button', { name: 'החלפת תיקייה' }))
    // While B's settings are loading, the old folder's form must be gone (no stale values, no Save button).
    await waitFor(() => expect(screen.queryByLabelText('תעריף עבודה')).toBeNull())
    expect(screen.queryByRole('button', { name: 'שמירת הגדרות' })).toBeNull()
    expect(screen.getByRole('status').textContent).toMatch(/טוען/)

    drive.release()
    await waitFor(() => expect((screen.getByLabelText('תעריף עבודה') as HTMLInputElement).value).toBe('120'))
    expect(drive.writeLog.length).toBe(writesBefore) // nothing written by switching
    expect((await settingsFile(drive, folderB))?.pricing.laborRate).toBe(120)
    expect((await settingsFile(drive, folderA))?.pricing.laborRate).toBe(100)

    const labor = screen.getByLabelText('תעריף עבודה')
    await user.clear(labor)
    await user.type(labor, '130')
    await user.click(screen.getByRole('button', { name: 'שמירת הגדרות' }))
    await screen.findByText(/^נשמר\. ההגדרות/)
    expect((await settingsFile(drive, folderB))?.pricing.laborRate).toBe(130)
    expect((await settingsFile(drive, folderA))?.pricing.laborRate).toBe(100)
  })

  it("switching to an empty folder shows defaults there; the old folder's custom values are not copied", async () => {
    const { saveSettings } = await import('../../src/lib/drive/bidRepository')
    const { defaultAppSettings } = await import('../../src/lib/bid')
    const drive = new MemoryDrive()
    const services = createMemoryServices(drive)
    const folderA = services.folderPointer.get() as string
    const folderB = drive.createRootFolder('empty')
    await saveSettings(drive, folderA, { ...defaultAppSettings(), pricing: { ...defaultAppSettings().pricing, laborRate: 100 } })
    services.pickFolder = async () => ({ id: folderB, name: 'empty' })

    const user = userEvent.setup()
    renderApp(services, '/settings')
    expect(((await screen.findByLabelText('תעריף עבודה')) as HTMLInputElement).value).toBe('100')
    await user.click(screen.getByRole('button', { name: 'החלפת תיקייה' }))
    await waitFor(() => expect((screen.getByLabelText('תעריף עבודה') as HTMLInputElement).value).toBe('80'))
    // First run in B creates the defaults file (brief §4) — never folder A's values.
    expect((await settingsFile(drive, folderB))?.pricing.laborRate).toBe(80)
  })
})
