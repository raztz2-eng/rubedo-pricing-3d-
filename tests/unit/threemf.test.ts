import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseSlicedThreeMF, ThreeMFError } from '../../src/lib/threemf'

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(process.cwd(), 'tests/fixtures', name)))
}

async function expectThreeMFError(p: Promise<unknown>, code: ThreeMFError['code']) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ThreeMFError)
  expect((err as ThreeMFError).code).toBe(code)
  expect((err as ThreeMFError).userMessage.length).toBeGreaterThan(0)
}

describe('parseSlicedThreeMF — fixtures', () => {
  it('rooting-stand: one plate, 55.94 g, 9312 s, PLA, "Rooting stand.stl", plate picture', async () => {
    const info = await parseSlicedThreeMF(fixture('rooting-stand.gcode.3mf'))
    expect(info.plates).toHaveLength(1)
    const [p] = info.plates
    expect(p.grams).toBe(55.94)
    expect(p.seconds).toBe(9312)
    expect(p.hours).toBeCloseTo(2.587, 3)
    expect(p.materialType).toBe('PLA')
    expect(p.objectNames).toEqual(['Rooting stand.stl'])
    expect(p.name).toContain('Rooting stand')
    expect(p.picture).toBeInstanceOf(Blob)
    expect(p.picture?.type).toBe('image/png')
    expect(p.picture?.size).toBeGreaterThan(0)
    expect(info.slicerVersion).toBe('02.08.02.61')
  })

  it('untitled: one plate, 123.22 g, 19282 s, PLA, "jacket pancile storage.stl", plate picture', async () => {
    const info = await parseSlicedThreeMF(fixture('untitled.gcode.3mf'))
    expect(info.plates).toHaveLength(1)
    const [p] = info.plates
    expect(p.grams).toBe(123.22)
    expect(p.seconds).toBe(19282)
    expect(p.materialType).toBe('PLA')
    expect(p.objectNames).toEqual(['jacket pancile storage.stl'])
    expect(p.picture?.size).toBeGreaterThan(0)
  })

  it('accepts a Blob as input', async () => {
    const info = await parseSlicedThreeMF(new Blob([fixture('rooting-stand.gcode.3mf') as BlobPart]))
    expect(info.plates[0].grams).toBe(55.94)
  })
})

describe('parseSlicedThreeMF — errors (no values)', () => {
  it('not a zip → invalid-file', async () => {
    await expectThreeMFError(parseSlicedThreeMF(new TextEncoder().encode('hello, not a zip')), 'invalid-file')
  })

  it('zip without slice_info.config (unsliced project) → not-sliced', async () => {
    const zip = new JSZip()
    zip.file('3D/3dmodel.model', '<model/>')
    zip.file('Metadata/model_settings.config', '<config/>')
    const data = await zip.generateAsync({ type: 'uint8array' })
    await expectThreeMFError(parseSlicedThreeMF(data), 'not-sliced')
  })

  it('slice_info without weight → invalid-data', async () => {
    const zip = new JSZip()
    zip.file(
      'Metadata/slice_info.config',
      '<?xml version="1.0"?><config><plate><metadata key="index" value="1"/><metadata key="prediction" value="100"/></plate></config>',
    )
    const data = await zip.generateAsync({ type: 'uint8array' })
    await expectThreeMFError(parseSlicedThreeMF(data), 'invalid-data')
  })

  it('multi-plate file → one plate per <plate>', async () => {
    const zip = new JSZip()
    const plate = (i: number, g: number, s: number, name: string) =>
      `<plate><metadata key="index" value="${i}"/><metadata key="prediction" value="${s}"/><metadata key="weight" value="${g}"/><object name="${name}"/><filament type="PETG" used_g="${g}"/></plate>`
    zip.file('Metadata/slice_info.config', `<config>${plate(1, 10, 3600, 'a.stl')}${plate(2, 20, 7200, 'b.stl')}</config>`)
    const info = await parseSlicedThreeMF(await zip.generateAsync({ type: 'uint8array' }))
    expect(info.plates.map((p) => [p.index, p.grams, p.hours, p.name, p.materialType])).toEqual([
      [1, 10, 1, 'a.stl', 'PETG'],
      [2, 20, 2, 'b.stl', 'PETG'],
    ])
    expect(info.plates[0].picture).toBeUndefined()
  })
})
