import { mapLimit } from '../concurrency'
import { loadPreviewBlob } from '../drive/images'
import type { DriveFile, DriveStore } from '../drive/types'
import type { MimeAttachment } from './mime'

/**
 * Photos attached to the quote e-mail (brief v0.5 Q3): each selected image is fetched through the thumbnail proxy
 * at 1600 px (so iPhone HEIC works — Drive renders it as JPEG), checked by its content type and size-capped.
 */

export const ATTACHMENT_SIZE = 1600
/** Total attachments cap: 20 MB. */
export const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024
export const ATTACHMENT_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp']
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

export class AttachmentError extends Error {
  readonly userMessage: string
  constructor(message: string, userMessage: string) {
    super(message)
    this.name = 'AttachmentError'
    this.userMessage = userMessage
  }
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

export function tooLargeMessage(totalBytes: number): string {
  return `סך התמונות המצורפות (${mb(totalBytes)} MB) חורג מהמגבלה של 20 MB. בטלו סימון של חלק מהתמונות ונסו שוב.`
}

/** Throws a Hebrew AttachmentError when the attachments together exceed 20 MB. */
export function assertTotalSize(attachments: readonly { data: Uint8Array }[]): void {
  const total = attachments.reduce((acc, a) => acc + a.data.byteLength, 0)
  if (total > MAX_ATTACHMENTS_BYTES) throw new AttachmentError(`attachments ${total} bytes`, tooLargeMessage(total))
}

/** "IMG_0042.HEIC" + image/jpeg → "IMG_0042.jpg" (the file name matches what is really attached). */
export function attachmentFileName(name: string, mimeType: string): string {
  const base = name.trim().replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'photo'
  return `${base}.${EXT[mimeType] ?? 'jpg'}`
}

function baseType(contentType: string | null | undefined): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase()
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer())
  return new Uint8Array(await new Response(blob).arrayBuffer())
}

async function fetchImage(fetchImpl: typeof fetch, url: string, file: DriveFile): Promise<{ type: string; blob: Blob }> {
  let res: Response
  try {
    res = await fetchImpl(url, { credentials: 'same-origin' })
  } catch (e) {
    throw new AttachmentError(`attachment network error: ${String(e)}`, 'אין חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.')
  }
  if (res.status === 401) {
    throw new AttachmentError('attachment 401', 'פג תוקף ההתחברות ל-Google. התחברו מחדש ונסו שוב.')
  }
  if (res.status === 404) {
    throw new AttachmentError('attachment 404', `לתמונה „${file.name}” אין תצוגה ב-Drive, ולכן אי אפשר לצרף אותה. בטלו את הסימון שלה.`)
  }
  if (!res.ok) throw new AttachmentError(`attachment ${res.status}`, `טעינת התמונה „${file.name}” נכשלה. נסו שוב.`)
  return { type: baseType(res.headers.get('Content-Type')), blob: await res.blob() }
}

/** Loads one image as an attachment (JPEG/PNG/WEBP only, verified by content type). */
export async function loadAttachment(drive: DriveStore, file: DriveFile, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<MimeAttachment> {
  const url = drive.thumbnailUrl(file.id, ATTACHMENT_SIZE)
  let type: string
  let blob: Blob
  if (url) {
    ;({ type, blob } = await fetchImage(fetchImpl, url, file))
  } else {
    // In-memory drive (tests / demo): same preview the page shows.
    blob = await loadPreviewBlob(drive, file, ATTACHMENT_SIZE)
    type = baseType(blob.type) || baseType(file.mimeType)
  }
  if (!ATTACHMENT_TYPES.includes(type)) {
    throw new AttachmentError(
      `attachment type ${type || 'unknown'}`,
      `התמונה „${file.name}” אינה בפורמט שאפשר לצרף (JPEG / PNG / WEBP). בטלו את הסימון שלה ונסו שוב.`,
    )
  }
  return { filename: attachmentFileName(file.name, type), mimeType: type, data: await blobBytes(blob) }
}

/** Loads all selected images (in order) and enforces the 20 MB total. */
export async function loadAttachments(
  drive: DriveStore,
  files: readonly DriveFile[],
  fetchImpl?: typeof fetch,
): Promise<MimeAttachment[]> {
  let total = 0
  const loaded = await mapLimit(files, 3, async (f) => {
    const a = await loadAttachment(drive, f, fetchImpl)
    total += a.data.byteLength
    // Stop early: no point downloading more once the cap is exceeded.
    if (total > MAX_ATTACHMENTS_BYTES) throw new AttachmentError(`attachments ${total} bytes`, tooLargeMessage(total))
    return a
  })
  assertTotalSize(loaded)
  return loaded
}
