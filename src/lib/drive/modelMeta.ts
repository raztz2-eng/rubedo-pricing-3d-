import { DESCRIPTION_MAX_LENGTH, DESCRIPTION_TOO_LONG_MESSAGE, MODEL_META_FILE_NAME } from '../bid'
import { InvalidJsonError, readJson, writeJsonFile } from './jsonFiles'
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
  updatedAt: string
}

/** Validates the content of a `_rubedo-model.json`; null when it is not one. Unknown fields are dropped. */
export function parseModelMeta(raw: unknown): ModelMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Partial<ModelMeta>
  const meta: ModelMeta = { schemaVersion: 1, updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '' }
  if (typeof r.coverFileId === 'string' && r.coverFileId !== '') meta.coverFileId = r.coverFileId
  if (typeof r.description === 'string') meta.description = r.description
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
 * Merges `patch` into the folder's meta file and writes it (creates it marked the first time).
 * `current`: the meta already loaded for this folder (null = none yet).
 */
export async function writeModelMeta(
  store: DriveStore,
  folderId: string,
  current: ModelMeta | null,
  patch: { coverFileId?: string; description?: string },
  now: Date = new Date(),
): Promise<ModelMeta> {
  if (patch.description !== undefined) assertDescriptionLength(patch.description)
  const next: ModelMeta = { ...(current ?? { schemaVersion: 1 }), ...patch, schemaVersion: 1, updatedAt: now.toISOString() }
  if (!next.coverFileId) delete next.coverFileId
  await writeJsonFile(store, folderId, MODEL_META_FILE_NAME, next)
  return next
}
