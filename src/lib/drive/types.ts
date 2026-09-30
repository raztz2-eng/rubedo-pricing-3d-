import type { UpdateOptions } from './writeGuard'

/**
 * The ONLY way the app talks to storage. `googleDrive.ts` implements it against Drive REST v3;
 * `memoryDrive.ts` implements it in memory for tests and demo mode.
 *
 * Deliberately has no operation that deletes, trashes, moves, renames or changes sharing (brief v0.4 D-F). Reads may target any file.
 * Writes only create new files/folders (always marked `appProperties.rubedo="1"`) or update the content of files
 * carrying that marker — see `writeGuard.ts` (AC22).
 */

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  /** Drive-generated preview (short-lived URL). Absent if none. */
  thumbnailLink?: string
  /** Parent folder IDs (present when the store knows them). */
  parents?: string[]
  /**
   * True when the file carries the app marker `appProperties.rubedo = "1"` (= created by this app, v0.4+).
   * Files the app created before v0.4 and everything the Founder made himself are false.
   */
  appCreated?: boolean
}

export interface ListOptions {
  /** Exact name match. */
  name?: string
  /** Only folders. */
  foldersOnly?: boolean
}

export interface DriveStore {
  /** Lists non-trashed direct children of a folder. */
  listChildren(folderId: string, options?: ListOptions): Promise<DriveFile[]>
  /** Creates a folder (marked as the app's). */
  createFolder(parentId: string, name: string): Promise<DriveFile>
  /** Creates a file (marked as the app's). */
  uploadFile(parentId: string, name: string, data: Blob, mimeType: string): Promise<DriveFile>
  /** Replaces the content of a file carrying the app marker (bid.json, index, settings). Refuses anything else. */
  updateFileContent(fileId: string, data: Blob, mimeType: string, options?: UpdateOptions): Promise<void>
  readText(fileId: string): Promise<string>
  /** Downloads the content of any file (alt=media). */
  readBlob(fileId: string): Promise<Blob>
  /** Metadata of one file or folder (name, mimeType, parents, thumbnailLink, appCreated). */
  getFile(fileId: string): Promise<DriveFile>
  /** Downloads a `thumbnailLink` image as a blob (in-memory store; the real store serves thumbnails by URL). */
  readThumbnail(thumbnailLink: string): Promise<Blob>
  /**
   * A same-origin URL an `<img>` can load directly (the real store: `/api/thumb`, works for HEIC; brief v0.4).
   * null → the UI loads the preview as a blob instead (in-memory store / demo mode).
   */
  thumbnailUrl(fileId: string, size: number): string | null
  /** URL that opens the folder in the Drive UI. */
  folderUrl(folderId: string): string
  /** URL that opens a file in the Drive UI. */
  fileUrl(fileId: string): string
}

/** Message used when a write would touch a file without the app marker (never allowed). */
export const NOT_APP_FILE_MESSAGE = 'האפליקציה לא יצרה את הקובץ הזה ולכן לא תשנה אותו.'

/** Error thrown by a DriveStore; `userMessage` is plain Hebrew. */
export class DriveError extends Error {
  readonly status?: number
  readonly userMessage: string

  constructor(message: string, userMessage: string, status?: number) {
    super(message)
    this.name = 'DriveError'
    this.status = status
    this.userMessage = userMessage
  }
}
