import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { App } from '../../src/App'
import { BID_FILE_NAME } from '../../src/lib/bid'
import { createMemoryServices, createUnconfiguredServices, type AppServices } from '../../src/state/services'

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
  it('number fields are text inputs with a decimal keyboard; "1,5" counts as 1.5 and "1,5,2" is flagged', async () => {
    const user = userEvent.setup()
    renderApp(createMemoryServices(), '/new')
    await user.click(await screen.findByRole('button', { name: /הוספת חלק ידנית/ }))
    const grams = screen.getByLabelText('משקל') as HTMLInputElement
    expect(grams.type).toBe('text')
    expect(grams.inputMode).toBe('decimal')
    expect(grams.getAttribute('dir')).toBe('ltr')

    await user.type(screen.getByLabelText(/^שם\s*\*$/), 'X')
    await user.type(grams, '1000')
    await user.type(screen.getByLabelText('זמן הדפסה'), '1,5')
    // filament 1000 g → 93.50; machine 1.5 h × 0.66498 = 0.99747 → landed 94.49747
    expect(screen.getByTestId('cost-landed').textContent).toContain('₪94.50')
    expect(screen.queryByText(/ערכים לא תקינים/)).toBeNull()

    await user.clear(grams)
    await user.type(grams, '1,5,2')
    expect(grams.value).toBe('1,5,2')
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
