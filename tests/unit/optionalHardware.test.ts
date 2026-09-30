import { describe, expect, it } from 'vitest'
import { BID_FILE_NAME, bidPricingInput, parseBid, type Bid } from '../../src/lib/bid'
import { bidToDraft, draftToContent, draftToPricingInput, emptyDraft, emptyLine, type BidDraft } from '../../src/lib/bidForm'
import { loadBid, loadModelFolder, newSaveSession, rebuildIndex, saveNewBid, updateBid } from '../../src/lib/drive/bidRepository'
import { MemoryDrive } from '../../src/lib/drive/memoryDrive'
import { computePrice, DEFAULT_PRICING_SETTINGS } from '../../src/lib/pricing'

const S = DEFAULT_PRICING_SETTINGS

function input(hardware: { qty: number; unitCost: number; included?: boolean }[]) {
  return { pricePerKg: 85, parts: [{ qty: 1, grams: 100, hours: 3.5 }], laborMinutes: 10, hardware, hasShipping: false, packaging: [], shippingCost: 0 }
}

describe('Q2 pricing: hardware = Σ(qty × unitCost) over included rows', () => {
  it('AC25: unticking a row removes exactly its qty × unitCost from landed', () => {
    const all = computePrice(input([{ qty: 2, unitCost: 7.5 }, { qty: 3, unitCost: 4.2, included: true }]), S)
    const without = computePrice(input([{ qty: 2, unitCost: 7.5 }, { qty: 3, unitCost: 4.2, included: false }]), S)
    expect(all.landed - without.landed).toBeCloseTo(3 * 4.2, 12)
    expect(without.hardware).toBeCloseTo(15, 12)
    expect(without.price70).toBeCloseTo(without.landed / 0.3, 12)
  })

  it('AC26: rows without `included` price identically to v0.4 (all counted)', () => {
    const legacy = computePrice(input([{ qty: 2, unitCost: 7.5 }, { qty: 3, unitCost: 4.2 }]), S)
    const explicit = computePrice(input([{ qty: 2, unitCost: 7.5, included: true }, { qty: 3, unitCost: 4.2, included: true }]), S)
    expect(legacy).toEqual(explicit)
    expect(legacy.hardware).toBeCloseTo(27.6, 12)
    // T1 + 27.6 hardware
    expect(legacy.landed).toBeCloseTo(computePrice(input([]), S).landed + 27.6, 12)
    expect(computePrice(input([]), S).landed.toFixed(2)).toBe('25.01')
  })

  it('all rows unticked → hardware 0, same as a bid without hardware', () => {
    expect(computePrice(input([{ qty: 2, unitCost: 7.5, included: false }]), S)).toEqual(computePrice(input([]), S))
  })
})

/** A bid.json exactly as v0.4 wrote it (schemaVersion 1, no `included`). */
function v1Bid(): Record<string, unknown> {
  const hardware = [
    { name: 'Magnet', qty: 4, unitCost: 0.8 },
    { name: 'Screw', qty: 2, unitCost: 0.35 },
  ]
  const result = computePrice(input(hardware), S)
  return {
    schemaVersion: 1,
    id: 'old-1',
    name: 'Old',
    revision: 'V1',
    description: '',
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    material: { name: 'PLA', pricePerKg: 85 },
    parts: [{ name: 'p', qty: 1, grams: 100, hours: 3.5, source: 'manual' }],
    laborMinutes: 10,
    hardware,
    hasShipping: false,
    packaging: [],
    shippingCost: 0,
    settingsSnapshot: { ...S },
    result,
    files: [],
  }
}

describe('bid.json schemaVersion 2 (Q1)', () => {
  it('v1 files are read with included = true and reprice to exactly the saved result (AC26)', () => {
    const bid = parseBid(v1Bid()) as Bid
    expect(bid).not.toBeNull()
    expect(bid.schemaVersion).toBe(1)
    expect(bid.hardware.map((h) => h.included)).toEqual([true, true])
    expect(computePrice(bidPricingInput(bid), bid.settingsSnapshot)).toEqual(bid.result)
  })

  it('v2 files keep included=false; unknown versions are rejected', () => {
    const raw = { ...v1Bid(), schemaVersion: 2, hardware: [{ name: 'Plant', qty: 1, unitCost: 20, included: false }] }
    expect((parseBid(raw) as Bid).hardware[0].included).toBe(false)
    expect(parseBid({ ...v1Bid(), schemaVersion: 3 })).toBeNull()
    expect(parseBid(null)).toBeNull()
  })

  it('bidPricingInput override replaces the saved flags (quote screen)', () => {
    const bid = parseBid(v1Bid()) as Bid
    expect(bidPricingInput(bid, [false, true]).hardware.map((h) => h.included)).toEqual([false, true])
  })
})

describe('form ↔ bid (Q1)', () => {
  function draftWithHardware(): BidDraft {
    const d = emptyDraft([{ name: 'PLA', pricePerKg: 85 }])
    return {
      ...d,
      name: 'Station',
      parts: [{ key: 'p', name: 'p', qty: '1', grams: '100', hours: '3.5', source: 'manual' }],
      laborMinutes: '10',
      hardware: [
        { ...emptyLine(), name: 'Tubes', qty: '5', unitCost: '3' },
        { ...emptyLine(), name: 'Plant', qty: '1', unitCost: '20', included: false },
      ],
    }
  }

  it('new rows are included by default; live price counts included rows only', () => {
    expect(emptyLine().included).not.toBe(false)
    const r = computePrice(draftToPricingInput(draftWithHardware()), S)
    expect(r.hardware).toBeCloseTo(15, 12)
  })

  it('saved content keeps every row with its flag, and bidToDraft restores it', () => {
    const d = draftWithHardware()
    const c = draftToContent(d, S, computePrice(draftToPricingInput(d), S))
    expect(c.hardware).toEqual([
      { name: 'Tubes', qty: 5, unitCost: 3, included: true },
      { name: 'Plant', qty: 1, unitCost: 20, included: false },
    ])
    const back = bidToDraft({ ...(parseBid(v1Bid()) as Bid), hardware: c.hardware })
    expect(back.hardware.map((h) => h.included)).toEqual([true, false])
  })
})

describe('repository (AC25/AC26)', () => {
  it('saveNewBid writes schemaVersion 2 with the unticked row kept (included=false)', async () => {
    const drive = new MemoryDrive()
    const root = drive.createRootFolder('models')
    const hardware = [
      { name: 'Tubes', qty: 5, unitCost: 3, included: true },
      { name: 'Plant', qty: 1, unitCost: 20, included: false },
    ]
    const result = computePrice(input(hardware), S)
    const { folderId } = await saveNewBid(
      drive,
      root,
      {
        folderName: 'Station',
        content: {
          name: 'Station',
          revision: 'V1',
          description: '',
          material: { name: 'PLA', pricePerKg: 85 },
          parts: [{ name: 'p', qty: 1, grams: 100, hours: 3.5, source: 'manual' }],
          laborMinutes: 10,
          hardware,
          hasShipping: false,
          packaging: [],
          shippingCost: 0,
          settingsSnapshot: { ...S },
          result,
        },
        files: [],
      },
      newSaveSession(),
    )
    const file = (await drive.listChildren(folderId, { name: BID_FILE_NAME }))[0]
    const json = JSON.parse(await drive.readText(file.id))
    expect(json.schemaVersion).toBe(2)
    expect(json.hardware).toEqual(hardware)
    expect(json.result.hardware).toBeCloseTo(15, 12)
  })

  it('a v1 bid.json (app-marked) loads with included=true, lists at its saved price, and an edit rewrites it as v2', async () => {
    const drive = new MemoryDrive()
    const root = drive.createRootFolder('models')
    const folder = await drive.createFolder(root, 'Old')
    const raw = v1Bid()
    await drive.uploadFile(folder.id, BID_FILE_NAME, new Blob([JSON.stringify(raw)]), 'application/json')

    const { entries } = await rebuildIndex(drive, root)
    expect(entries[0].price70).toBe((raw.result as { price70: number }).price70)
    const page = await loadModelFolder(drive, folder.id)
    expect(page.bid?.hardware.every((h) => h.included)).toBe(true)

    const { bid } = await loadBid(drive, folder.id)
    const draft = bidToDraft(bid)
    draft.hardware[1] = { ...draft.hardware[1], included: false }
    const content = draftToContent(draft, bid.settingsSnapshot, computePrice(draftToPricingInput(draft), bid.settingsSnapshot))
    await updateBid(drive, root, { folderId: folder.id, existing: bid, content, newFiles: [] }, newSaveSession())
    const after = JSON.parse(await drive.readText((await drive.listChildren(folder.id, { name: BID_FILE_NAME }))[0].id))
    expect(after.schemaVersion).toBe(2)
    expect(after.hardware.map((h: { included: boolean }) => h.included)).toEqual([true, false])
    expect(after.id).toBe('old-1')
  })
})
