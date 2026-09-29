import { describe, expect, it } from 'vitest'
import { DEFAULT_MATERIALS } from '../../src/lib/bid'
import {
  applySlicedFile,
  canSave,
  draftToContent,
  draftToPricingInput,
  editPartValue,
  emptyDraft,
  emptyPart,
  filesToUpload,
  invalidFields,
} from '../../src/lib/bidForm'
import { computePrice, DEFAULT_PRICING_SETTINGS } from '../../src/lib/pricing'
import type { SlicedFileInfo } from '../../src/lib/threemf'

const info: SlicedFileInfo = {
  plates: [
    {
      index: 1,
      objectNames: ['Rooting stand.stl'],
      name: 'Rooting stand.stl',
      grams: 55.94,
      seconds: 9312,
      hours: 9312 / 3600,
      materialType: 'PETG',
      picture: new Blob(['png'], { type: 'image/png' }),
    },
  ],
}

describe('applySlicedFile', () => {
  it('adds one 3mf part per plate, the sliced file, the plate picture and pre-selects the material', () => {
    const d = applySlicedFile(emptyDraft(DEFAULT_MATERIALS), info, { name: 'rs.gcode.3mf', blob: new Blob(['z']) }, DEFAULT_MATERIALS)
    expect(d.parts).toHaveLength(1)
    expect(d.parts[0]).toMatchObject({ name: 'Rooting stand.stl', grams: '55.94', hours: '2.587', source: '3mf' })
    expect(d.parts[0].hoursExact).toBe(9312 / 3600)
    expect(d.materialName).toBe('PETG')
    expect(d.files.map((f) => [f.kind, f.origin, f.include])).toEqual([
      ['image', 'plate', true],
      ['sliced', 'sliced', true],
    ])
    expect(d.parts[0].slicedLocalKey).toBe(d.files[1].key)
  })

  it('pricing uses exact hours from the file (T2)', () => {
    const d = applySlicedFile(emptyDraft(DEFAULT_MATERIALS), info, { name: 'x', blob: new Blob() }, DEFAULT_MATERIALS)
    const r = computePrice(draftToPricingInput(d), DEFAULT_PRICING_SETTINGS)
    expect(r.machine).toBeCloseTo((9312 / 3600) * 0.66498, 4)
  })

  it('leaves the material alone when the type is not in Settings', () => {
    const d = applySlicedFile(
      emptyDraft(DEFAULT_MATERIALS),
      { plates: [{ ...info.plates[0], materialType: 'ASA' }] },
      { name: 'x', blob: new Blob() },
      DEFAULT_MATERIALS,
    )
    expect(d.materialName).toBe('PLA')
  })
})

describe('editing parts', () => {
  it('editing grams or hours switches source to manual; hours edit drops exact value', () => {
    const d = applySlicedFile(emptyDraft(DEFAULT_MATERIALS), info, { name: 'x', blob: new Blob() }, DEFAULT_MATERIALS)
    const g = editPartValue(d.parts[0], 'grams', '60')
    expect(g).toMatchObject({ grams: '60', source: 'manual', hoursExact: 9312 / 3600 })
    const h = editPartValue(d.parts[0], 'hours', '3')
    expect(h.source).toBe('manual')
    expect(h.hoursExact).toBeUndefined()
  })
})

describe('canSave / validation', () => {
  it('requires a name and a part with grams or hours > 0', () => {
    const d = emptyDraft(DEFAULT_MATERIALS)
    expect(canSave(d)).toBe(false)
    const withPart = { ...d, parts: [{ ...emptyPart(), grams: '10' }] }
    expect(canSave(withPart)).toBe(false)
    expect(canSave({ ...withPart, name: 'x' })).toBe(true)
    expect(canSave({ ...d, name: 'x', parts: [emptyPart()] })).toBe(false)
    expect(canSave({ ...d, name: 'x', parts: [{ ...emptyPart(), hours: '1' }] })).toBe(true)
  })

  it('non-numeric input blocks save and is reported', () => {
    const d = { ...emptyDraft(DEFAULT_MATERIALS), name: 'x', parts: [{ ...emptyPart(), grams: 'abc' }] }
    expect(invalidFields(d)).toContain('חלק 1 — גרמים')
    expect(canSave(d)).toBe(false)
  })
})

describe('draftToContent / filesToUpload', () => {
  it('drops packaging when shipping is off and names plate pictures after the model', () => {
    let d = applySlicedFile(emptyDraft(DEFAULT_MATERIALS), info, { name: 'rs.gcode.3mf', blob: new Blob() }, DEFAULT_MATERIALS)
    d = {
      ...d,
      name: 'Stand',
      packaging: [{ key: 'p', name: 'box', qty: '1', unitCost: '3' }],
      shippingCost: '20',
      hasShipping: false,
    }
    const r = computePrice(draftToPricingInput(d), DEFAULT_PRICING_SETTINGS)
    const c = draftToContent(d, DEFAULT_PRICING_SETTINGS, r)
    expect(c.packaging).toEqual([])
    expect(c.shippingCost).toBe(0)
    expect(c.result.packaging).toBe(0)
    expect(filesToUpload(d).map((f) => f.name)).toEqual(['Stand-plate-1.png', 'rs.gcode.3mf'])
    const unticked = { ...d, files: d.files.map((f) => (f.origin === 'plate' ? { ...f, include: false } : f)) }
    expect(filesToUpload(unticked).map((f) => f.name)).toEqual(['rs.gcode.3mf'])
  })
})

describe('invalidFields — malformed and negative numbers', () => {
  it('flags malformed text and negative values; comma decimals are valid', () => {
    const base = { ...emptyDraft(DEFAULT_MATERIALS), name: 'x' }
    const d = {
      ...base,
      laborMinutes: '-5',
      parts: [{ ...emptyPart(), grams: '1,5,2', hours: '1,5' }],
      hardware: [{ key: 'h', name: 'screw', qty: '2', unitCost: '-1' }],
    }
    const bad = invalidFields(d)
    expect(bad).toEqual(expect.arrayContaining(['דקות עבודה', 'חלק 1 — גרמים', 'חומרה 1 — מחיר']))
    expect(bad).not.toContain('חלק 1 — שעות')
    expect(canSave(d)).toBe(false)
    const ok = { ...base, parts: [{ ...emptyPart(), grams: '1,5' }] }
    expect(invalidFields(ok)).toEqual([])
    expect(draftToPricingInput(ok).parts[0].grams).toBe(1.5)
  })
})
