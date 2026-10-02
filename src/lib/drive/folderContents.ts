import { BID_FILE_NAME, FOLDER_MIME, MODEL_META_FILE_NAME } from '../bid'
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

/** The app's own bookkeeping files ("_rubedo-…"): never shown as model files or pictures. */
export function isAppInternalFileName(name: string): boolean {
  return name.trim().startsWith('_rubedo-')
}

export interface FolderContents {
  bidFile?: DriveFile
  /** v0.6: `_rubedo-model.json` (cover/description of a folder without bid.json); the marked one is preferred. */
  metaFile?: DriveFile
  /** All images, sorted by name. */
  images: DriveFile[]
  /** All other files (no folders, no bid.json), sorted by name. */
  files: DriveFile[]
  /** Sliced .gcode.3mf files, sorted by name. */
  sliced: DriveFile[]
}

/** Native Google Docs/Sheets/… files: no binary content, cannot be downloaded as is (M2). */
export function isGoogleNativeFile(f: Pick<DriveFile, 'mimeType'>): boolean {
  return f.mimeType !== FOLDER_MIME && f.mimeType.startsWith('application/vnd.google-apps.')
}

/**
 * Of several files with the same name, the one carrying the app marker wins (M3); otherwise the first.
 * Used for bid.json, the settings file and the index.
 */
export function preferAppFile(files: DriveFile[]): DriveFile | undefined {
  const plain = files.filter((f) => f.mimeType !== FOLDER_MIME)
  return plain.find((f) => f.appCreated === true) ?? plain[0]
}

export function classifyFolder(children: DriveFile[]): FolderContents {
  const bidFile = preferAppFile(children.filter((c) => c.name === BID_FILE_NAME))
  const metaFile = preferAppFile(children.filter((c) => c.name === MODEL_META_FILE_NAME))
  const plain = children.filter((c) => c.mimeType !== FOLDER_MIME && c !== bidFile && !isAppInternalFileName(c.name))
  const images = plain.filter(isImageFile).sort(byName)
  const files = plain.filter((c) => !isImageFile(c)).sort(byName)
  const sliced = files.filter((f) => isSlicedFileName(f.name))
  const contents: FolderContents = { bidFile, images, files, sliced }
  if (metaFile) contents.metaFile = metaFile
  return contents
}

/** Cover = the bid's cover if set, else the first image by name (not a plate picture), else a plate picture. */
export function pickCover(images: DriveFile[], bidCoverFileId?: string): string | undefined {
  if (bidCoverFileId) return bidCoverFileId
  const sorted = [...images].sort(byName)
  return (sorted.find((i) => !isPlatePictureName(i.name)) ?? sorted[0])?.id
}
