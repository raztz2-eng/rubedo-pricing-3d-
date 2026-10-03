import { DESCRIPTION_MAX_LENGTH, DESCRIPTION_TOO_LONG_MESSAGE, MODEL_META_FILE_NAME } from '../bid'
import { findFile, InvalidJsonError, readJson, writeJsonFile } from './jsonFiles'
import { DriveError, type DriveFile, type DriveStore } from './types'

/**
 * `<model folder>/_rubedo-model.json` (brief v0.6 E2/E3): the cover and description of a model folder that has NO
 * bid.json yet ("needs slicing"). App-owned: created marked, rewritten only through the marker-guarded write path.
 * When a bid is later created from the folder, these values prefill it.
 */

export interface ModelMeta {
  schemaVersion: 1
  coverFileId?: string
  description?: string
  /**
   * v0.7 A1: removed from the library. Used for folders without a marked bid.json (needs-slicing, or a pre-v0.4 bid
   * whose old bid.json is never touched).
   */
  archived?: boolean
  archivedAt?: string
  updatedAt: string
}

export type ModelMetaPatch = { coverFileId?: string; description?: string; archived?: boolean; archivedAt?: string }

/**
 * Validates the content of a `_rubedo-model.json`; null when it is not one. Unknown fields are dropped.
 * An `archived` / `archivedAt` of the wrong type makes the whole file invalid (never dropped and written back).
 */
export function parseModelMeta(raw: unknown): ModelMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.archived !== undefined && typeof r.archived !== 'boolean') return null
  if (r.archivedAt !== undefined && typeof r.archivedAt !== 'string') return null
  const meta: ModelMeta = { schemaVersion: 1, updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '' }
  if (typeof r.coverFileId === 'string' && r.coverFileId !== '') meta.coverFileId = r.coverFileId
  if (typeof r.description === 'string') meta.description = r.description
  if (typeof r.archived === 'boolean') meta.archived = r.archived
  if (typeof r.archivedAt === 'string') meta.archivedAt = r.archivedAt
  return meta
}

export const INVALID_META_MESSAGE = `הקובץ ${MODEL_META_FILE_NAME} פגום — התמונה הראשית והתיאור שנשמרו לדגם לא נטענו.`

/** The meta file was read but is not valid (as opposed to a Drive/network failure). */
export class InvalidModelMetaError extends DriveError {
  constructor() {
    super(`${MODEL_META_FILE_NAME} invalid`, INVALID_META_MESSAGE)
    this.name = 'InvalidModelMetaError'
  }
}

/** Reads a meta file found in a folder listing. Invalid content → InvalidModelMetaError; Drive errors are rethrown. */
export async function readModelMeta(store: DriveStore, file: DriveFile): Promise<ModelMeta> {
  let raw: unknown
  try {
    raw = await readJson(store, file.id, MODEL_META_FILE_NAME)
  } catch (e) {
    if (e instanceof InvalidJsonError) throw new InvalidModelMetaError()
    throw e
  }
  const meta = parseModelMeta(raw)
  if (!meta) throw new InvalidModelMetaError()
  return meta
}

export function assertDescriptionLength(description: string): void {
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw new DriveError('description too long', DESCRIPTION_TOO_LONG_MESSAGE, 400)
  }
}

/**
 * The folder's meta file as it is NOW (null = none). A damaged one throws InvalidModelMetaError: it is never
 * replaced (I3) — the Founder sees the problem instead.
 */
export async function readCurrentModelMeta(store: DriveStore, folderId: string): Promise<ModelMeta | null> {
  const file = await findFile(store, folderId, MODEL_META_FILE_NAME)
  return file ? readModelMeta(store, file) : null
}

/**
 * Re-reads the folder's meta file, merges `patch` into it and writes it (creates it marked the first time).
 * Only the patched fields change; a value saved meanwhile (e.g. the cover from another tab) is kept.
 */
export async function writeModelMeta(
  store: DriveStore,
  folderId: string,
  patch: ModelMetaPatch,
  now: Date = new Date(),
): Promise<ModelMeta> {
  const current = await readCurrentModelMeta(store, folderId)
  if (patch.description !== undefined && patch.description !== (current?.description ?? '')) assertDescriptionLength(patch.description)
  const next: ModelMeta = { ...(current ?? { schemaVersion: 1 }), ...patch, schemaVersion: 1, updatedAt: now.toISOString() }
  if (!next.coverFileId) delete next.coverFileId
  // A restore clears the archive time (archived:false is kept, so the file says it was restored).
  if (next.archivedAt === undefined || next.archived !== true) delete next.archivedAt
  await writeJsonFile(store, folderId, MODEL_META_FILE_NAME, next)
  return next
}
