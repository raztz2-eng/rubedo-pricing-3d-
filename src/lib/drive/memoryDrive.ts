import { FOLDER_MIME } from '../bid'
import { DriveError, type DriveFile, type DriveStore, type ListOptions } from './types'

interface MemoryNode extends DriveFile {
  parentId: string | null
  data?: Blob
  createdSeq: number
}

export type MemoryOperation = 'listChildren' | 'createFolder' | 'uploadFile' | 'updateFileContent' | 'readText' | 'readBlob'

/**
 * In-memory DriveStore — used by tests and by the `?demo=1` mode. No network.
 * `failNext(op)` makes the next call of that operation throw (to test retry flows).
 */
export class MemoryDrive implements DriveStore {
  private nodes = new Map<string, MemoryNode>()
  private seq = 0
  private failures: { op: MemoryOperation; predicate?: (arg: string) => boolean }[] = []
  /** Log of write operations, in order: e.g. `upload:bid.json`. */
  readonly writeLog: string[] = []

  /** Creates a root folder (as if picked by the user in Picker). */
  createRootFolder(name: string): string {
    const node = this.addNode({ name, mimeType: FOLDER_MIME, parentId: null })
    return node.id
  }

  failNext(op: MemoryOperation, predicate?: (arg: string) => boolean): void {
    this.failures.push({ op, predicate })
  }

  /** Test helper: all nodes (files and folders). */
  all(): (DriveFile & { parentId: string | null })[] {
    return [...this.nodes.values()].map(({ id, name, mimeType, parentId, modifiedTime }) => ({
      id,
      name,
      mimeType,
      parentId,
      modifiedTime,
    }))
  }

  async listChildren(folderId: string, options: ListOptions = {}): Promise<DriveFile[]> {
    this.maybeFail('listChildren', folderId)
    this.requireFolder(folderId)
    return [...this.nodes.values()]
      .filter((n) => n.parentId === folderId)
      .filter((n) => (options.name === undefined ? true : n.name === options.name))
      .filter((n) => (options.foldersOnly ? n.mimeType === FOLDER_MIME : true))
      .sort((a, b) => a.createdSeq - b.createdSeq)
      .map(({ id, name, mimeType, modifiedTime }) => ({ id, name, mimeType, modifiedTime }))
  }

  async createFolder(parentId: string, name: string): Promise<DriveFile> {
    this.maybeFail('createFolder', name)
    this.requireFolder(parentId)
    const n = this.addNode({ name, mimeType: FOLDER_MIME, parentId })
    this.writeLog.push(`folder:${name}`)
    return { id: n.id, name: n.name, mimeType: n.mimeType, modifiedTime: n.modifiedTime }
  }

  async uploadFile(parentId: string, name: string, data: Blob, mimeType: string): Promise<DriveFile> {
    this.maybeFail('uploadFile', name)
    this.requireFolder(parentId)
    const n = this.addNode({ name, mimeType, parentId, data })
    this.writeLog.push(`upload:${name}`)
    return { id: n.id, name: n.name, mimeType: n.mimeType, modifiedTime: n.modifiedTime }
  }

  async updateFileContent(fileId: string, data: Blob, mimeType: string): Promise<void> {
    this.maybeFail('updateFileContent', fileId)
    const n = this.nodes.get(fileId)
    if (!n || n.mimeType === FOLDER_MIME) throw new DriveError(`not found: ${fileId}`, 'הקובץ לא נמצא ב-Drive.', 404)
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

  folderUrl(folderId: string): string {
    return `#demo-folder-${folderId}`
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

  private addNode(init: { name: string; mimeType: string; parentId: string | null; data?: Blob }): MemoryNode {
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
