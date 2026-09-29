import JSZip from 'jszip'

/**
 * Parser for Bambu Studio sliced .3mf files (`*.gcode.3mf`).
 * Reads ONLY `Metadata/slice_info.config` and `Metadata/plate_<n>.png`; never decompresses the G-code entry.
 */

export type ThreeMFErrorCode = 'invalid-file' | 'not-sliced' | 'invalid-data'

export class ThreeMFError extends Error {
  readonly code: ThreeMFErrorCode
  /** Plain-Hebrew message for the user. */
  readonly userMessage: string

  constructor(code: ThreeMFErrorCode, userMessage: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ThreeMFError'
    this.code = code
    this.userMessage = userMessage
  }
}

export const NOT_SLICED_MESSAGE =
  'זה לא קובץ פרוס (sliced). ב-Bambu Studio יש לבחור File → Export → Export plate sliced file ולהעלות את הקובץ שנוצר.'
export const INVALID_FILE_MESSAGE = 'לא ניתן לקרוא את הקובץ. ודאו שזה קובץ ‎.3mf‎ תקין שיוצא מ-Bambu Studio.'
export const INVALID_DATA_MESSAGE =
  'הקובץ נפתח, אבל חסרים בו נתוני משקל או זמן הדפסה. לא מולאו ערכים — אפשר להזין ידנית.'

export interface SlicedPlate {
  index: number
  /** Object names on the plate, in file order. */
  objectNames: string[]
  /** Display name for the part (object names joined). */
  name: string
  grams: number
  /** Estimated print time in seconds (`prediction`). */
  seconds: number
  hours: number
  /** Filament type of the first filament on the plate (e.g. "PLA"), if present. */
  materialType?: string
  /** `Metadata/plate_<index>.png` if present. */
  picture?: Blob
}

export interface SlicedFileInfo {
  plates: SlicedPlate[]
  slicerVersion?: string
}

type Input = ArrayBuffer | Uint8Array | Blob

function metadataValue(el: Element, key: string): string | undefined {
  for (const child of Array.from(el.children)) {
    if (child.tagName === 'metadata' && child.getAttribute('key') === key) {
      return child.getAttribute('value') ?? undefined
    }
  }
  return undefined
}

function toNumber(v: string | undefined): number {
  if (v === undefined || v.trim() === '') return NaN
  return Number(v)
}

export async function parseSlicedThreeMF(data: Input): Promise<SlicedFileInfo> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data)
  } catch (e) {
    throw new ThreeMFError('invalid-file', INVALID_FILE_MESSAGE, String(e))
  }

  const sliceInfo = zip.file('Metadata/slice_info.config')
  if (!sliceInfo) {
    throw new ThreeMFError('not-sliced', NOT_SLICED_MESSAGE, 'Metadata/slice_info.config missing')
  }

  const xml = await sliceInfo.async('string')
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new ThreeMFError('invalid-data', INVALID_DATA_MESSAGE, 'slice_info.config is not valid XML')
  }

  let slicerVersion: string | undefined
  for (const item of Array.from(doc.getElementsByTagName('header_item'))) {
    if (item.getAttribute('key') === 'X-BBL-Client-Version') slicerVersion = item.getAttribute('value') ?? undefined
  }

  const plateEls = Array.from(doc.getElementsByTagName('plate'))
  if (plateEls.length === 0) {
    throw new ThreeMFError('invalid-data', INVALID_DATA_MESSAGE, 'no <plate> elements')
  }

  const plates: SlicedPlate[] = []
  for (const [i, plateEl] of plateEls.entries()) {
    const indexRaw = toNumber(metadataValue(plateEl, 'index'))
    const index = Number.isInteger(indexRaw) && indexRaw > 0 ? indexRaw : i + 1
    const grams = toNumber(metadataValue(plateEl, 'weight'))
    const seconds = toNumber(metadataValue(plateEl, 'prediction'))
    if (!Number.isFinite(grams) || !Number.isFinite(seconds) || grams < 0 || seconds < 0) {
      throw new ThreeMFError('invalid-data', INVALID_DATA_MESSAGE, `plate ${index}: missing weight/prediction`)
    }

    const objectNames = Array.from(plateEl.getElementsByTagName('object'))
      .map((o) => o.getAttribute('name')?.trim() ?? '')
      .filter((n) => n !== '')
    const filament = plateEl.getElementsByTagName('filament')[0]
    const materialType = filament?.getAttribute('type')?.trim() || undefined

    const pictureEntry = zip.file(`Metadata/plate_${index}.png`)
    const picture = pictureEntry
      ? new Blob([await pictureEntry.async('arraybuffer')], { type: 'image/png' })
      : undefined

    plates.push({
      index,
      objectNames,
      name: objectNames.length > 0 ? objectNames.join(' + ') : `Plate ${index}`,
      grams,
      seconds,
      hours: seconds / 3600,
      materialType,
      picture,
    })
  }

  return { plates, slicerVersion }
}
