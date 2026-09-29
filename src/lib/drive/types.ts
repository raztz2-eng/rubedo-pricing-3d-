/**
 * The ONLY way the app talks to storage. `googleDrive.ts` implements it against Drive REST v3;
 * `memoryDrive.ts` implements it in memory for tests and demo mode.
 *
 * Deliberately has no delete operation: the app never deletes anything in the Founder's Drive.
 */

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
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
  readBlob(fileId: string): Promise<Blob>
  /** URL that opens the folder in the Drive UI. */
  folderUrl(folderId: string): string
}

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
