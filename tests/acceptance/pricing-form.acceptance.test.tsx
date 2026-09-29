import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { computePrice, computePrinterRate, DEFAULT_PRICING_SETTINGS } from '../../src/lib/pricing'
import { parseSlicedThreeMF, ThreeMFError } from '../../src/lib/threemf'
import { addManualPart, fixtureBytes, fixtureFile, navLink, newServices, panel, renderApp, saveButton, setValue } from './helpers'

const r2 = (v: number) => (Math.round((v + Number.EPSILON) * 100) / 100).toFixed(2)
const noParts = { hardware: [], hasShipping: false, packaging: [], shippingCost: 0 }

// ---------------------------------------------------------------------------------------------
describe('AC1 — T0 (labor rate 20) equals the spreadsheet', () => {
  it('AC1.ui: Settings laborRate=20, then 100 g / 3.5 h / 10 min → 9.35 / 3.33 / 2.33 / 15.01 / 30.02 / 37.53 / 50.04', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    renderApp(services, '/settings')

    const labor = await screen.findByLabelText('תעריף עבודה')
    setValue(labor, '20')
    await user.click(screen.getByRole('button', { name: 'שמירת הגדרות' }))
    await screen.findByText(/^נשמר\./)

    await user.click(navLink('דגם חדש'))
    await screen.findByRole('button', { name: /הוספת חלק ידנית/ })
    await addManualPart(user, '100', '3.5')
    setValue(screen.getByLabelText('זמן עבודה'), '10')

    expect(panel()).toMatchObject({
      filament: '₪9.35',
      labor: '₪3.33',
      machine: '₪2.33',
      landed: '₪15.01',
      p50: '₪30.02',
      p60: '₪37.53',
      p70: '₪50.04',
    })
  })

  it('AC1.pure: computePrice with laborRate 20 rounds to the spreadsheet values', () => {
    const r = computePrice(
      { pricePerKg: 85, parts: [{ qty: 1, grams: 100, hours: 3.5 }], laborMinutes: 10, ...noParts },
      { ...DEFAULT_PRICING_SETTINGS, laborRate: 20 },
    )
    expect([r.filament, r.labor, r.machine, r.landed, r.price50, r.price60, r.price70].map(r2)).toEqual([
      '9.35', '3.33', '2.33', '15.01', '30.02', '37.53', '50.04',
    ])
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC2 — T1–T3 with default settings match the brief table', () => {
  it('AC2.rate: printer rate with defaults is 0.66498 ₪/h (shown in Settings)', async () => {
    expect(computePrinterRate(DEFAULT_PRICING_SETTINGS).toFixed(5)).toBe('0.66498')
    const { services } = newServices()
    renderApp(services, '/settings')
    expect((await screen.findByTestId('printer-rate')).textContent).toContain('₪0.66498')
  })

  it('AC2.T1: manual 100 g / 3.5 h / 10 min → 9.35 / 13.33 / 2.33 / 25.01 / 50.02 / 62.53 / 83.37', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    renderApp(services, '/new')
    await screen.findByRole('button', { name: /הוספת חלק ידנית/ })
    await addManualPart(user, '100', '3.5')
    setValue(screen.getByLabelText('זמן עבודה'), '10')
    expect(panel()).toEqual({
      filament: '₪9.35',
      hardware: '₪0.00',
      labor: '₪13.33',
      packaging: '₪0.00',
      machine: '₪2.33',
      landed: '₪25.01',
      p50: '₪50.02',
      p60: '₪62.53',
      p70: '₪83.37',
    })
  })

  it('AC2.T2: rooting-stand.gcode.3mf → 5.23 / 0.00 / 1.72 / 6.95 / 13.90 / 17.38 / 23.17', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    renderApp(services, '/new')
    await user.upload(await screen.findByLabelText('העלאת קובץ פרוס'), fixtureFile('rooting-stand.gcode.3mf'))
    await screen.findAllByTestId('part-row')
    expect(panel()).toMatchObject({
      filament: '₪5.23',
      labor: '₪0.00',
      machine: '₪1.72',
      landed: '₪6.95',
      p50: '₪13.90',
      p60: '₪17.38',
      p70: '₪23.17',
    })
  })

  it('AC2.T3: untitled.gcode.3mf → 11.52 / 0.00 / 3.56 / 15.08 / 30.17 / 37.71 / 50.28', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    renderApp(services, '/new')
    await user.upload(await screen.findByLabelText('העלאת קובץ פרוס'), fixtureFile('untitled.gcode.3mf'))
    await screen.findAllByTestId('part-row')
    expect(panel()).toMatchObject({
      filament: '₪11.52',
      labor: '₪0.00',
      machine: '₪3.56',
      landed: '₪15.08',
      p50: '₪30.17',
      p60: '₪37.71',
      p70: '₪50.28',
    })
  })

  it('AC2.T3-data: untitled.gcode.3mf parses to 123.22 g and 19282 s', async () => {
    const info = await parseSlicedThreeMF(fixtureBytes('untitled.gcode.3mf'))
    const grams = info.plates.reduce((a, p) => a + p.grams, 0)
    const seconds = info.plates.reduce((a, p) => a + p.seconds, 0)
    expect(grams).toBeCloseTo(123.22, 6)
    expect(seconds).toBe(19282)
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC3 — several parts: totals = sum of parts × quantities', () => {
  it('AC3.ui: part A (100 g, 2 h) ×2 + part B (40 g, 1 h) ×3 → 320 g, 7 h', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    renderApp(services, '/new')
    await screen.findByRole('button', { name: /הוספת חלק ידנית/ })
    await addManualPart(user, '100', '2', '2')
    await addManualPart(user, '40', '1', '3')
    expect(screen.getAllByTestId('part-row')).toHaveLength(2)

    // Expected by hand from the brief formula: 320 g → 0.32 × 85 × 1.1 = 29.92; 7 h × 0.66498 = 4.65;
    // landed 34.57; ÷0.5 = 69.15; ÷0.4 = 86.44; ÷0.3 = 115.25.
    expect(panel()).toMatchObject({
      filament: '₪29.92',
      machine: '₪4.65',
      landed: '₪34.57',
      p50: '₪69.15',
      p60: '₪86.44',
      p70: '₪115.25',
    })
  })

  it('AC3.equiv: the multi-part result equals one part carrying the summed grams/hours', () => {
    const s = DEFAULT_PRICING_SETTINGS
    const multi = computePrice(
      { pricePerKg: 85, parts: [{ qty: 2, grams: 100, hours: 2 }, { qty: 3, grams: 40, hours: 1 }], laborMinutes: 0, ...noParts },
      s,
    )
    const single = computePrice({ pricePerKg: 85, parts: [{ qty: 1, grams: 320, hours: 7 }], laborMinutes: 0, ...noParts }, s)
    expect(multi.filament).toBeCloseTo(single.filament, 10)
    expect(multi.machine).toBeCloseTo(single.machine, 10)
    expect(multi.landed).toBeCloseTo(single.landed, 10)
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC4 — uploading rooting-stand.gcode.3mf', () => {
  it('AC4.ui: one part, 55.94 g, 2.587 h, PLA, name contains "Rooting stand", values editable', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    renderApp(services, '/new')
    await user.upload(await screen.findByLabelText('העלאת קובץ פרוס'), fixtureFile('rooting-stand.gcode.3mf'))

    const rows = await screen.findAllByTestId('part-row')
    expect(rows).toHaveLength(1)
    const row = within(rows[0])
    const grams = row.getByLabelText('משקל') as HTMLInputElement
    const hours = row.getByLabelText('זמן הדפסה') as HTMLInputElement
    const name = row.getByLabelText('שם החלק') as HTMLInputElement
    expect(grams.value).toBe('55.94')
    expect(hours.value).toBe('2.587')
    expect(name.value).toContain('Rooting stand')
    expect((screen.getByLabelText('חומר') as HTMLSelectElement).value).toBe('PLA')
    expect(row.getByTestId('part-source').textContent).toBe('מקובץ פרוס')

    // Editable: every value can be changed, and the source becomes manual.
    expect(grams.disabled || grams.readOnly).toBe(false)
    expect(hours.disabled || hours.readOnly).toBe(false)
    setValue(grams, '60')
    setValue(hours, '3')
    expect(grams.value).toBe('60')
    expect(hours.value).toBe('3')
    expect(row.getByTestId('part-source').textContent).toBe('ידני')
    await user.clear(name)
    await user.type(name, 'Renamed')
    expect(name.value).toBe('Renamed')
  })

  it('AC4.parser: 9312 s prediction → 2.587 h, 55.94 g, PLA', async () => {
    const info = await parseSlicedThreeMF(fixtureBytes('rooting-stand.gcode.3mf'))
    expect(info.plates).toHaveLength(1)
    const p = info.plates[0]
    expect(p.seconds).toBe(9312)
    expect(p.hours.toFixed(3)).toBe('2.587')
    expect(p.grams).toBeCloseTo(55.94, 6)
    expect(p.materialType).toBe('PLA')
    expect(p.name).toContain('Rooting stand')
  })
})

// ---------------------------------------------------------------------------------------------
async function unslicedProject(): Promise<File> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
  zip.file('3D/3dmodel.model', '<?xml version="1.0"?><model/>')
  zip.file('Metadata/plate_1.png', new Uint8Array([1, 2, 3]))
  return new File([await zip.generateAsync({ type: 'arraybuffer' })], 'project.3mf')
}

async function slicedWithoutWeight(): Promise<File> {
  const zip = new JSZip()
  zip.file(
    'Metadata/slice_info.config',
    '<?xml version="1.0"?><config><plate><metadata key="index" value="1"/><metadata key="prediction" value="3600"/>' +
      '<object name="X"/></plate></config>',
  )
  return new File([await zip.generateAsync({ type: 'arraybuffer' })], 'broken.gcode.3mf')
}

describe('AC5 — invalid / unsliced file shows an error and fills nothing', () => {
  it('AC5.garbage: a non-zip file → Hebrew error, no part, price stays ₪0.00, save disabled, manual entry available', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    renderApp(services, '/new')
    setValue(await screen.findByLabelText(/^שם \*$/), 'X')
    await user.upload(screen.getByLabelText('העלאת קובץ פרוס'), new File(['not a zip at all'], 'bad.3mf'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/[֐-׿]/)
    expect(screen.queryAllByTestId('part-row')).toHaveLength(0)
    expect(panel().p70).toBe('₪0.00')
    expect(saveButton().disabled).toBe(true)
    await addManualPart(user, '10', '1')
    expect(screen.getAllByTestId('part-row')).toHaveLength(1)
  })

  it('AC5.unsliced: a project .3mf without slice_info → "not a sliced file / Export plate sliced file" error, nothing filled', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    renderApp(services, '/new')
    await user.upload(await screen.findByLabelText('העלאת קובץ פרוס'), await unslicedProject())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/פרוס/)
    expect(alert.textContent).toMatch(/Export plate sliced file/)
    expect(screen.queryAllByTestId('part-row')).toHaveLength(0)
    expect(screen.queryByText(/להשתמש בתמונת הפלטה/)).toBeNull()
    expect(panel().p70).toBe('₪0.00')
  })

  it('AC5.no-silent-0: a sliced file missing the weight → error; an existing manual part is untouched, no 0-gram part added', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    renderApp(services, '/new')
    await screen.findByRole('button', { name: /הוספת חלק ידנית/ })
    await addManualPart(user, '100', '3.5')
    const before = panel()
    await user.upload(screen.getByLabelText('העלאת קובץ פרוס'), await slicedWithoutWeight())
    await screen.findByRole('alert')
    const rows = screen.getAllByTestId('part-row')
    expect(rows).toHaveLength(1)
    expect((within(rows[0]).getByLabelText('משקל') as HTMLInputElement).value).toBe('100')
    expect(panel()).toEqual(before)
  })

  it('AC5.parser: the parser rejects the unsliced file with a ThreeMFError (code not-sliced)', async () => {
    const f = await unslicedProject()
    await expect(parseSlicedThreeMF(f)).rejects.toBeInstanceOf(ThreeMFError)
    await expect(parseSlicedThreeMF(f)).rejects.toMatchObject({ code: 'not-sliced' })
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC6 — shipping toggle', () => {
  it('AC6.ui: off → section hidden & ₪0; on → packaging + shipping counted; off again → ₪0 and landed drops back', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    renderApp(services, '/new')
    const toggle = (await screen.findByLabelText('כולל אריזה ומשלוח')) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.queryByTestId('packaging-section')).toBeNull()
    await addManualPart(user, '100', '3.5')
    setValue(screen.getByLabelText('זמן עבודה'), '10')
    expect(panel().packaging).toBe('₪0.00')
    expect(panel().landed).toBe('₪25.01')

    await user.click(toggle)
    const section = within(screen.getByTestId('packaging-section'))
    await user.click(section.getByRole('button', { name: /הוספת פריט אריזה/ }))
    setValue(section.getByLabelText('פריט אריזה 1'), 'Box')
    setValue(section.getByLabelText('כמות'), '2')
    setValue(section.getByLabelText('מחיר ליחידה'), '5')
    setValue(section.getByLabelText('עלות משלוח'), '10')
    // 2 × 5 + 10 = 20; landed 25.01 + 20 = 45.01
    expect(panel().packaging).toBe('₪20.00')
    expect(panel().landed).toBe('₪45.01')

    await user.click(toggle)
    expect(screen.queryByTestId('packaging-section')).toBeNull()
    expect(panel().packaging).toBe('₪0.00')
    expect(panel().landed).toBe('₪25.01')
  })

  it('AC6.saved: a bid saved with the toggle off stores packaging cost 0', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    renderApp(services, '/new')
    setValue(await screen.findByLabelText(/^שם \*$/), 'NoShip')
    await addManualPart(user, '100', '3.5')
    // Enter packaging while on, then switch off before saving.
    await user.click(screen.getByLabelText('כולל אריזה ומשלוח'))
    setValue(within(screen.getByTestId('packaging-section')).getByLabelText('עלות משלוח'), '30')
    await user.click(screen.getByLabelText('כולל אריזה ומשלוח'))
    await user.click(saveButton())
    await screen.findByRole('heading', { name: 'NoShip' })
    const folder = (await services.drive.listChildren(root, { foldersOnly: true }))[0]
    const bidFile = (await services.drive.listChildren(folder.id, { name: 'bid.json' }))[0]
    const bid = JSON.parse(await services.drive.readText(bidFile.id))
    expect(bid.hasShipping).toBe(false)
    expect(bid.result.packaging).toBe(0)
    await waitFor(() => expect(screen.queryByTestId('packaging-section')).toBeNull())
  })
})
