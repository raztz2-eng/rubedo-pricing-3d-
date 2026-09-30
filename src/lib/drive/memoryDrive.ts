import { FOLDER_MIME } from '../bid'
import { DriveError, type DriveFile, type DriveStore, type ListOptions } from './types'
import { assertUpdatable } from './writeGuard'

interface MemoryNode {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  parentId: string | null
  data?: Blob
  createdSeq: number
  /**
   * Carries the app marker (appProperties.rubedo="1"): created through the DriveStore API (= by the app, v0.4+).
   * Foreign nodes simulate the Founder's own files; legacy nodes simulate app files from before v0.4 (no marker).
   */
  appCreated: boolean
  /** Explicit preview; `null` = Drive has no thumbnail for this file. Undefined → derived from the data. */
  thumbnail?: Blob | null
}

export type MemoryOperation =
  | 'listChildren'
  | 'createFolder'
  | 'uploadFile'
  | 'updateFileContent'
  | 'readText'
  | 'readBlob'
  | 'getFile'
  | 'readThumbnail'

/** Image types Drive (and this fake) can render a thumbnail for from the bytes themselves. */
const AUTO_THUMB_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const THUMB_PREFIX = 'memory-thumb:'

export interface ForeignFileOptions {
  /** Thumbnail Drive would show (e.g. for HEIC). `null` = no thumbnail. Default: the file itself for jpg/png/webp. */
  thumbnail?: Blob | null
  modifiedTime?: string
}

/**
 * In-memory DriveStore — used by tests and by the `?demo=1` mode. No network.
 * `failNext(op)` makes the next call of that operation throw (to test retry flows).
 *
 * Permissions are realistic for the `drive` scope (brief v0.4): the app may create children in ANY folder, including
 * the Founder's own. Nodes created through the DriveStore API carry the app marker. `addForeignFolder` /
 * `addForeignFile` simulate files the Founder put in Drive himself; `addLegacyAppFile` simulates a file the app
 * created before v0.4 (no marker). `updateFileContent` applies the same write guard as the real store (AC22).
 */
export class MemoryDrive implements DriveStore {
  private nodes = new Map<string, MemoryNode>()
  private seq = 0
  private failures: { op: MemoryOperation; predicate?: (arg: string) => boolean }[] = []
  /** Log of write operations, in order: e.g. `upload:bid.json`. */
  readonly writeLog: string[] = []
  /** Every write attempt with its target: `{ op, targetId }` (parent folder for creates, the file for updates). */
  readonly writeTargets: { op: 'createFolder' | 'uploadFile' | 'updateFileContent'; targetId: string }[] = []

  /** Creates a root folder (as if picked by the user in Picker). */
  createRootFolder(name: string): string {
    const node = this.addNode({ name, mimeType: FOLDER_MIME, parentId: null, appCreated: false })
    return node.id
  }

  /** Test/demo helper: a folder the Founder created in Drive himself (not by the app). */
  addForeignFolder(parentId: string, name: string, options: { modifiedTime?: string } = {}): string {
    this.requireFolder(parentId)
    const n = this.addNode({ name, mimeType: FOLDER_MIME, parentId, appCreated: false })
    if (options.modifiedTime) n.modifiedTime = options.modifiedTime
    return n.id
  }

  /** Test/demo helper: a file the Founder put in Drive himself (not by the app). */
  addForeignFile(parentId: string, name: string, data: Blob, mimeType: string, options: ForeignFileOptions = {}): string {
    this.requireFolder(parentId)
    const n = this.addNode({ name, mimeType, parentId, data, appCreated: false })
    if (options.thumbnail !== undefined) n.thumbnail = options.thumbnail
    if (options.modifiedTime) n.modifiedTime = options.modifiedTime
    return n.id
  }

  /** Test helper: a file the app created before v0.4 (no appProperties marker). */
  addLegacyAppFile(parentId: string, name: string, data: Blob, mimeType: string): string {
    this.requireFolder(parentId)
    return this.addNode({ name, mimeType, parentId, data, appCreated: false }).id
  }

  failNext(op: MemoryOperation, predicate?: (arg: string) => boolean): void {
    this.failures.push({ op, predicate })
  }

  /** Test helper: all nodes (files and folders). */
  all(): (DriveFile & { parentId: string | null })[] {
    return [...this.nodes.values()].map((n) => ({ ...this.toFile(n), parentId: n.parentId }))
  }

  async listChildren(folderId: string, options: ListOptions = {}): Promise<DriveFile[]> {
    this.maybeFail('listChildren', folderId)
    this.requireFolder(folderId)
    return [...this.nodes.values()]
      .filter((n) => n.parentId === folderId)
      .filter((n) => (options.name === undefined ? true : n.name === options.name))
      .filter((n) => (options.foldersOnly ? n.mimeType === FOLDER_MIME : true))
      .sort((a, b) => a.createdSeq - b.createdSeq)
      .map((n) => this.toFile(n))
  }

  async getFile(fileId: string): Promise<DriveFile> {
    this.maybeFail('getFile', fileId)
    const n = this.nodes.get(fileId)
    if (!n) throw new DriveError(`not found: ${fileId}`, 'הקובץ לא נמצא ב-Drive.', 404)
    return this.toFile(n)
  }

  async createFolder(parentId: string, name: string): Promise<DriveFile> {
    this.maybeFail('createFolder', name)
    this.requireFolder(parentId)
    this.writeTargets.push({ op: 'createFolder', targetId: parentId })
    const n = this.addNode({ name, mimeType: FOLDER_MIME, parentId, appCreated: true })
    this.writeLog.push(`folder:${name}`)
    return this.toFile(n)
  }

  async uploadFile(parentId: string, name: string, data: Blob, mimeType: string): Promise<DriveFile> {
    this.maybeFail('uploadFile', name)
    this.requireFolder(parentId)
    this.writeTargets.push({ op: 'uploadFile', targetId: parentId })
    const n = this.addNode({ name, mimeType, parentId, data, appCreated: true })
    this.writeLog.push(`upload:${name}`)
    return this.toFile(n)
  }

  async updateFileContent(fileId: string, data: Blob, mimeType: string): Promise<void> {
    this.maybeFail('updateFileContent', fileId)
    this.writeTargets.push({ op: 'updateFileContent', targetId: fileId })
    const n = this.nodes.get(fileId)
    if (!n || n.mimeType === FOLDER_MIME) throw new DriveError(`not found: ${fileId}`, 'הקובץ לא נמצא ב-Drive.', 404)
    // Same guard as the real store.
    assertUpdatable(this.toFile(n))
    n.data = data
    n.mimeType = mimeType
    n.modifiedTime = new Date().toISOString()
    this.writeLog.push(`update:${n.name}`)
  }

  async readText(fileId: string): Promise<string> {
    this.maybeFail('readText', fileId)
    return (await this.readData(fileId)).text()
  }

  async readBlob(fileId: string): Promise<Blob> {
    this.maybeFail('readBlob', fileId)
    return this.readData(fileId)
  }

  async readThumbnail(thumbnailLink: string): Promise<Blob> {
    this.maybeFail('readThumbnail', thumbnailLink)
    const id = thumbnailLink.startsWith(THUMB_PREFIX) ? thumbnailLink.slice(THUMB_PREFIX.length).replace(/=s\d+$/, '') : ''
    const n = this.nodes.get(id)
    const thumb = n ? this.thumbnailOf(n) : null
    if (!thumb) throw new DriveError(`no thumbnail: ${thumbnailLink}`, 'התמונה לא נמצאה ב-Drive.', 404)
    return thumb
  }

  /** No image URL: the UI loads previews as blobs via readThumbnail/readBlob. */
  thumbnailUrl(): string | null {
    return null
  }

  folderUrl(folderId: string): string {
    return `#demo-folder-${folderId}`
  }

  fileUrl(fileId: string): string {
    return `#demo-file-${fileId}`
  }

  private thumbnailOf(n: MemoryNode): Blob | null {
    if (n.thumbnail !== undefined) return n.thumbnail
    if (n.data && AUTO_THUMB_MIMES.includes(n.mimeType)) return n.data
    return null
  }

  private toFile(n: MemoryNode): DriveFile {
    const f: DriveFile = {
      id: n.id,
      name: n.name,
      mimeType: n.mimeType,
      modifiedTime: n.modifiedTime,
      parents: n.parentId ? [n.parentId] : [],
      appCreated: n.appCreated,
    }
    if (this.thumbnailOf(n)) f.thumbnailLink = `${THUMB_PREFIX}${n.id}=s220`
    return f
  }

  private readData(fileId: string): Blob {
    const n = this.nodes.get(fileId)
    if (!n || !n.data) throw new DriveError(`not found: ${fileId}`, 'הקובץ לא נמצא ב-Drive.', 404)
    return n.data
  }

  private requireFolder(id: string): void {
    const n = this.nodes.get(id)
    if (!n || n.mimeType !== FOLDER_MIME) throw new DriveError(`folder not found: ${id}`, 'התיקייה לא נמצאה ב-Drive.', 404)
  }

  private maybeFail(op: MemoryOperation, arg: string): void {
    const i = this.failures.findIndex((f) => f.op === op && (!f.predicate || f.predicate(arg)))
    if (i >= 0) {
      this.failures.splice(i, 1)
      throw new DriveError(`simulated failure: ${op}(${arg})`, 'שגיאת רשת (מדומה). נסו שוב.', 503)
    }
  }

  private addNode(init: { name: string; mimeType: string; parentId: string | null; data?: Blob; appCreated: boolean }): MemoryNode {
    this.seq += 1
    const node: MemoryNode = {
      id: `mem-${this.seq}`,
      createdSeq: this.seq,
      modifiedTime: new Date().toISOString(),
      ...init,
    }
    this.nodes.set(node.id, node)
    return node
  }
}
