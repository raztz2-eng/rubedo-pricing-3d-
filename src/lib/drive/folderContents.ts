import { BID_FILE_NAME, FOLDER_MIME } from '../bid'
import type { DriveFile } from './types'

/**
 * Pure helpers that classify what is inside the models folder and a model folder (brief addendum v0.3, N1–N4).
 */

/** Library skips subfolders whose name starts with "_" and the folder "Models photo" (spaces trimmed). */
export function isSkippedFolderName(name: string): boolean {
  const n = name.trim()
  return n.startsWith('_') || n.toLocaleLowerCase() === 'models photo'
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif)$/i

export function isImageFile(f: DriveFile): boolean {
  if (f.mimeType === FOLDER_MIME) return false
  return f.mimeType.startsWith('image/') || IMAGE_EXT.test(f.name)
}

/** A Bambu Studio sliced file ("… .gcode.3mf"). */
export function isSlicedFileName(name: string): boolean {
  return /\.gcode\.3mf$/i.test(name.trim())
}

/** Plate picture saved by the app: "<name>-plate-<n>.png". */
export function isPlatePictureName(name: string): boolean {
  return /-plate-\d+\.png$/i.test(name.trim())
}

export function byName(a: DriveFile, b: DriveFile): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

export interface FolderContents {
  bidFile?: DriveFile
  /** All images, sorted by name. */
  images: DriveFile[]
  /** All other files (no folders, no bid.json), sorted by name. */
  files: DriveFile[]
  /** Sliced .gcode.3mf files, sorted by name. */
  sliced: DriveFile[]
}

export function classifyFolder(children: DriveFile[]): FolderContents {
  const bidFile = children.find((c) => c.name === BID_FILE_NAME && c.mimeType !== FOLDER_MIME)
  const plain = children.filter((c) => c.mimeType !== FOLDER_MIME && c !== bidFile)
  const images = plain.filter(isImageFile).sort(byName)
  const files = plain.filter((c) => !isImageFile(c)).sort(byName)
  const sliced = files.filter((f) => isSlicedFileName(f.name))
  return { bidFile, images, files, sliced }
}

/** Cover = the bid's cover if set, else the first image by name (not a plate picture), else a plate picture. */
export function pickCover(images: DriveFile[], bidCoverFileId?: string): string | undefined {
  if (bidCoverFileId) return bidCoverFileId
  const sorted = [...images].sort(byName)
  return (sorted.find((i) => !isPlatePictureName(i.name)) ?? sorted[0])?.id
}
