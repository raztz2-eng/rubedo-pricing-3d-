import type { DriveFile, DriveStore } from './types'

/**
 * Image previews for Drive files (brief v0.3 N3). Order: Drive thumbnail (sized, bearer token) → the file itself
 * for formats every browser shows (jpg/png/webp) → no preview (e.g. HEIC without a thumbnail → placeholder).
 */

const DIRECT_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const DIRECT_EXT = /\.(jpe?g|png|webp|gif)$/i

export const PREVIEW_SIZE = 800

/** The file can be shown by downloading it as is. */
export function isDirectlyViewable(f: Pick<DriveFile, 'name' | 'mimeType'>): boolean {
  return DIRECT_MIMES.includes(f.mimeType) || DIRECT_EXT.test(f.name)
}

/** Drive thumbnail links end in "=s220"; ask for a bigger size. Other links are used as they are. */
export function sizedThumbnailLink(link: string, size = PREVIEW_SIZE): string {
  return /=s\d+$/.test(link) ? link.replace(/=s\d+$/, `=s${size}`) : link
}

/** There is no way to show this file (not an error of Drive or the network). */
export class NoPreviewError extends Error {
  constructor(name: string) {
    super(`no preview for ${name}`)
    this.name = 'NoPreviewError'
  }
}

export async function loadPreviewBlob(drive: DriveStore, file: DriveFile, size = PREVIEW_SIZE): Promise<Blob> {
  let thumbError: unknown
  if (file.thumbnailLink) {
    try {
      return await drive.readThumbnail(sizedThumbnailLink(file.thumbnailLink, size))
    } catch (e) {
      thumbError = e
    }
  }
  if (isDirectlyViewable(file)) return drive.readBlob(file.id)
  if (thumbError) throw thumbError
  throw new NoPreviewError(file.name)
}
