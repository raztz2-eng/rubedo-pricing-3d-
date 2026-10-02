import { preferAppFile } from './folderContents'
import { DriveError, type DriveFile, type DriveStore } from './types'

/**
 * Shared helpers for the app's own JSON files (bid.json, settings, index, `_rubedo-model.json`,
 * `_rubedo-customers.json`). Every write goes through `writeJsonFile`: it rewrites ONLY a file carrying the app
 * marker, otherwise it creates a new (marked) file next to it (brief v0.4 D-F, AC22).
 */

export const JSON_MIME = 'application/json'

export function jsonBlob(value: unknown): Blob {
  return new Blob([JSON.stringify(value, null, 2)], { type: JSON_MIME })
}

/** A file with that exact name in the folder; one with the app marker is preferred (M3). */
export async function findFile(store: DriveStore, folderId: string, name: string): Promise<DriveFile | undefined> {
  return preferAppFile(await store.listChildren(folderId, { name }))
}

/** The file was read fine but its content is not valid JSON (as opposed to a Drive/network failure). */
export class InvalidJsonError extends DriveError {
  constructor(what: string) {
    super(`${what}: invalid JSON`, `הקובץ ${what} פגום (JSON לא תקין).`)
    this.name = 'InvalidJsonError'
  }
}

export async function readJson(store: DriveStore, fileId: string, what: string): Promise<unknown> {
  const text = await store.readText(fileId)
  try {
    return JSON.parse(text)
  } catch {
    throw new InvalidJsonError(what)
  }
}

/**
 * Creates or rewrites an app JSON file. Only a file carrying the app marker is rewritten. If the only file of that
 * name is unmarked (written before v0.4, or not by the app), it is left untouched and a NEW marked file is created
 * next to it — later lookups prefer the marked one (M3).
 */
export async function writeJsonFile(store: DriveStore, folderId: string, name: string, value: unknown): Promise<string> {
  const existing = await findFile(store, folderId, name)
  if (existing?.appCreated === true) {
    await store.updateFileContent(existing.id, jsonBlob(value), JSON_MIME)
    return existing.id
  }
  const created = await store.uploadFile(folderId, name, jsonBlob(value), JSON_MIME)
  return created.id
}
