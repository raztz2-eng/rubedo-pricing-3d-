/**
 * Addendum v0.5 — optional hardware (D-I, Q1, Q2). AC25, AC26.
 * Outside-in: the whole App on the in-memory Drive. Expected values: T1 (brief §7: landed ₪25.01, 70% ₪83.37) plus
 * hardware rows whose cost is qty × unitCost; old (schemaVersion 1) bids must price exactly as before v0.5.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computePrice, DEFAULT_PRICING_SETTINGS } from '../../src/lib/pricing'
import { addManualPart, moneyIn, newServices, panel, renderApp, saveButton, setValue, stubObjectUrls, type MemServices } from './helpers'
import { bidJson } from './v05-fixtures'

type Drive = MemServices['drive']

async function readBid(drive: Drive, folderId: string) {
  const f = (await drive.listChildren(folderId, { name: 'bid.json' }))[0]
  if (!f) throw new Error('bid.json missing')
  return JSON.parse(await drive.readText(f.id))
}

function hardwareSection(): HTMLElement {
  return screen.getByRole('region', { name: 'חומרה' })
}

function includeBoxes(): HTMLInputElement[] {
  return within(hardwareSection()).getAllByRole('checkbox', { name: /כלול במחיר/ }) as HTMLInputElement[]
}

/** Adds a hardware row via the form and fills it. */
async function addHardware(user: ReturnType<typeof userEvent.setup>, name: string, qty: string, unitCost: string) {
  await user.click(within(hardwareSection()).getByRole('button', { name: /הוספת רכיב/ }))
  const sec = within(hardwareSection())
  const n = sec.getAllByLabelText('כמות').length
  setValue(sec.getByLabelText(`רכיב ${n}`), name)
  setValue(sec.getAllByLabelText('כמות')[n - 1], qty)
  setValue(sec.getAllByLabelText('מחיר ליחידה')[n - 1], unitCost)
}

let restore: () => void
beforeEach(() => {
  restore = stubObjectUrls()
})
afterEach(() => restore())

// ---------------------------------------------------------------------------------------------
describe('AC25 — unticking a hardware row removes exactly its qty×unitCost from landed; the saved bid keeps the row with included=false', () => {
  it('AC25.ui: T1 + Plant (2×₪7.50) + Pot (1×₪4) → landed ₪44.01; untick Plant → ₪29.01 (−₪15.00 exactly); bid.json v2 keeps both rows with their flags', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    renderApp(services, '/new')
    setValue(await screen.findByLabelText(/^שם \*$/), 'Propagation Station')
    await addManualPart(user, '100', '3.5')
    setValue(screen.getByLabelText('זמן עבודה'), '10')
    expect(panel().landed).toBe('₪25.01') // T1 anchor
    expect(panel().p70).toBe('₪83.37')

    await addHardware(user, 'Plant cutting', '2', '7.5')
    await addHardware(user, 'Ceramic pot', '1', '4')
    // Q1: every row has the checkbox, default ON.
    expect(includeBoxes()).toHaveLength(2)
    expect(includeBoxes().map((b) => b.checked)).toEqual([true, true])
    expect(panel().hardware).toBe('₪19.00')
    expect(panel().landed).toBe('₪44.01')

    await user.click(includeBoxes()[0])
    expect(includeBoxes()[0].checked).toBe(false)
    // Row still in the form.
    expect((within(hardwareSection()).getByLabelText('רכיב 1') as HTMLInputElement).value).toBe('Plant cutting')
    const after = panel()
    expect(after.hardware).toBe('₪4.00')
    expect(after.landed).toBe('₪29.01')
    expect(after.p70).toBe('₪96.70')
    // Exactly its qty × unitCost (2 × 7.50 = 15.00) left the landed cost.
    expect((44.01 - Number(after.landed.slice(1))).toFixed(2)).toBe('15.00')

    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Propagation Station' })
    const folder = (await services.drive.listChildren(root, { foldersOnly: true })).find((f) => f.name === 'Propagation Station')!
    const bid = await readBid(services.drive, folder.id)
    expect(bid.schemaVersion).toBe(2)
    expect(bid.hardware).toEqual([
      { name: 'Plant cutting', qty: 2, unitCost: 7.5, included: false },
      { name: 'Ceramic pot', qty: 1, unitCost: 4, included: true },
    ])
    expect(bid.result.hardware).toBeCloseTo(4, 10)
    expect(bid.result.landed.toFixed(2)).toBe('29.01')
    expect(bid.result.price70.toFixed(2)).toBe('96.70')
  })

  it('AC25.edit: re-opening the bid shows the row unticked with the same price; saving the edit keeps included=false; re-ticking adds exactly ₪15.00 back', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    renderApp(services, '/new')
    setValue(await screen.findByLabelText(/^שם \*$/), 'Edit Station')
    await addManualPart(user, '100', '3.5')
    setValue(screen.getByLabelText('זמן עבודה'), '10')
    await addHardware(user, 'Plant cutting', '2', '7.5')
    await user.click(includeBoxes()[0])
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Edit Station' })
    const folder = (await services.drive.listChildren(root, { foldersOnly: true })).find((f) => f.name === 'Edit Station')!

    await user.click(screen.getByRole('link', { name: 'עריכה' }))
    await waitFor(() => expect(includeBoxes()).toHaveLength(1))
    expect(includeBoxes()[0].checked).toBe(false)
    expect(panel().landed).toBe('₪25.01')
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Edit Station' })
    let bid = await readBid(services.drive, folder.id)
    expect(bid.hardware).toEqual([{ name: 'Plant cutting', qty: 2, unitCost: 7.5, included: false }])
    expect(bid.result.landed.toFixed(2)).toBe('25.01')

    await user.click(screen.getByRole('link', { name: 'עריכה' }))
    await waitFor(() => expect(includeBoxes()).toHaveLength(1))
    await user.click(includeBoxes()[0])
    expect(panel().landed).toBe('₪40.01')
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'Edit Station' })
    bid = await readBid(services.drive, folder.id)
    expect(bid.hardware[0].included).toBe(true)
    expect(bid.result.landed.toFixed(2)).toBe('40.01')
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC26 — an old bid.json (no `included`) prices identically to before', () => {
  const OLD = {
    schemaVersion: 1 as const,
    name: 'Old Station',
    description: 'saved before v0.5',
    grams: 100,
    hours: 3.5,
    laborMinutes: 10,
    // v1 rows: no `included` key at all.
    hardware: [
      { name: 'Plant cutting', qty: 2, unitCost: 7.5 },
      { name: 'Ceramic pot', qty: 1, unitCost: 4 },
    ],
  }

  async function oldBidFolder(services: MemServices, root: string) {
    const folder = await services.drive.createFolder(root, OLD.name)
    const json = bidJson(OLD)
    expect(json.hardware.every((h) => !('included' in h))).toBe(true)
    await services.drive.uploadFile(folder.id, 'bid.json', new Blob([JSON.stringify(json)], { type: 'application/json' }), 'application/json')
    return folder.id
  }

  it('AC26.pricing: pricing.ts with v1 hardware lines (no `included`) counts every row — T1 + ₪19 → landed 44.01 / 70% 146.70', () => {
    const r = computePrice(
      {
        pricePerKg: 85,
        parts: [{ qty: 1, grams: 100, hours: 3.5 }],
        laborMinutes: 10,
        hardware: OLD.hardware,
        hasShipping: false,
        packaging: [],
        shippingCost: 0,
      },
      { ...DEFAULT_PRICING_SETTINGS },
    )
    expect(r.hardware.toFixed(2)).toBe('19.00')
    expect(r.landed.toFixed(2)).toBe('44.01')
    expect(r.price50.toFixed(2)).toBe('88.02')
    expect(r.price60.toFixed(2)).toBe('110.03')
    expect(r.price70.toFixed(2)).toBe('146.70')
  })

  it('AC26.ui: model page, edit form and quote screen of a v1 bid all show landed ₪44.01 / 70% ₪146.70 with every row ticked; saving the edit keeps the price', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const folderId = await oldBidFolder(services, root)

    renderApp(services, `/model/${folderId}`)
    await screen.findByRole('heading', { level: 1, name: OLD.name })
    expect(moneyIn('cost-landed')).toBe('₪44.01')
    expect(moneyIn('price-70')).toBe('₪146.70')
    expect(screen.queryByText('לא כלול במחיר')).toBeNull()

    await user.click(screen.getByRole('link', { name: 'עריכה' }))
    await waitFor(() => expect(includeBoxes()).toHaveLength(2))
    expect(includeBoxes().map((b) => b.checked)).toEqual([true, true])
    expect(panel().hardware).toBe('₪19.00')
    expect(panel().landed).toBe('₪44.01')
    expect(panel().p70).toBe('₪146.70')
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: OLD.name })
    const bid = await readBid(services.drive, folderId)
    expect(bid.hardware.map((h: { included?: boolean }) => h.included)).toEqual([true, true])
    expect(bid.result.landed.toFixed(2)).toBe('44.01')
    expect(bid.result.price70.toFixed(2)).toBe('146.70')
  })

  it('AC26.quote: the quote screen of a v1 bid pre-ticks every row and defaults to ceil(146.70) = 147', async () => {
    const { services, root } = newServices()
    const folderId = await oldBidFolder(services, root)
    renderApp(services, `/model/${folderId}/quote`)
    const priceField = (await screen.findByLabelText('מחיר ללקוח')) as HTMLInputElement
    const region = screen.getByRole('region', { name: 'חומרה בהצעה' })
    expect((within(region).getAllByRole('checkbox') as HTMLInputElement[]).map((c) => c.checked)).toEqual([true, true])
    expect(priceField.value).toBe('147')
  })
})
