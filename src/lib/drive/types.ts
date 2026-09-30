/**
 * The ONLY way the app talks to storage. `googleDrive.ts` implements it against Drive REST v3;
 * `memoryDrive.ts` implements it in memory for tests and demo mode.
 *
 * Deliberately has no delete/move operation: the app never deletes or moves anything in the Founder's Drive.
 * Reads may target any file (drive.readonly); writes only create new files or update files the app created
 * (drive.file). `updateFileContent` refuses files the app did not create (AC17).
 */

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  /** Drive-generated preview (short-lived URL; needs the bearer token for private files). Absent if none. */
  thumbnailLink?: string
  /**
   * Drive `isAppAuthorized`: true when this app created (or was given, via Picker) the file.
   * Undefined when unknown.
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
  createFolder(parentId: string, name: string): Promise<DriveFile>
  uploadFile(parentId: string, name: string, data: Blob, mimeType: string): Promise<DriveFile>
  /** Replaces the content of a file the app created (bid.json, index, settings). */
  updateFileContent(fileId: string, data: Blob, mimeType: string): Promise<void>
  readText(fileId: string): Promise<string>
  /** Downloads the content of any file (alt=media). */
  readBlob(fileId: string): Promise<Blob>
  /** Metadata of one file or folder (name, mimeType, thumbnailLink, appCreated). */
  getFile(fileId: string): Promise<DriveFile>
  /** Downloads a `thumbnailLink` image (authenticated) as a blob. */
  readThumbnail(thumbnailLink: string): Promise<Blob>
  /** URL that opens the folder in the Drive UI. */
  folderUrl(folderId: string): string
  /** URL that opens a file in the Drive UI. */
  fileUrl(fileId: string): string
}

/** Message used when a write would touch a file the app did not create (never allowed). */
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
