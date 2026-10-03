import { DESCRIPTION_MAX_LENGTH, DESCRIPTION_TOO_LONG_MESSAGE, FOLDER_MIME, MODEL_META_FILE_NAME } from '../bid'
import { preferAppFile } from './folderContents'
import { InvalidJsonError, JSON_MIME, jsonBlob, readJson } from './jsonFiles'
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

/** Several marked meta files in one folder (written from two tabs at once) are read as ONE meta (I2). */
export function mergeModelMetas(metas: readonly ModelMeta[]): ModelMeta | null {
  if (metas.length === 0) return null
  if (metas.length === 1) return metas[0]
  const newest = <K extends 'coverFileId' | 'description'>(key: K): ModelMeta[K] => {
    let best: ModelMeta | undefined
    for (const m of metas) if (m[key] !== undefined && (!best || m.updatedAt > best.updatedAt)) best = m
    return best?.[key]
  }
  // The archive flag: the newest decision wins — an archive counts from archivedAt, a restore from updatedAt.
  const archiveTime = (m: ModelMeta) => (m.archived === true ? (m.archivedAt ?? m.updatedAt) : m.updatedAt)
  let archive: ModelMeta | undefined
  for (const m of metas) if (m.archived !== undefined && (!archive || archiveTime(m) > archiveTime(archive))) archive = m
  const merged: ModelMeta = { schemaVersion: 1, updatedAt: metas.map((m) => m.updatedAt).sort().at(-1) ?? '' }
  const cover = newest('coverFileId')
  const description = newest('description')
  if (cover !== undefined) merged.coverFileId = cover
  if (description !== undefined) merged.description = description
  if (archive) {
    merged.archived = archive.archived
    if (archive.archived === true && archive.archivedAt !== undefined) merged.archivedAt = archive.archivedAt
  }
  return merged
}

/** The `_rubedo-model.json` files of a folder listing (files only, listing = creation order). */
export function metaFilesOf(children: readonly DriveFile[]): DriveFile[] {
  return children.filter((c) => c.name === MODEL_META_FILE_NAME && c.mimeType !== FOLDER_MIME)
}

interface MetaState {
  meta: ModelMeta | null
  /** The file a change is written to: the oldest marked one. undefined → a new marked file is created. */
  target?: DriveFile
}

/**
 * Reads the meta of a folder from its listing: every marked file, merged (newer wins per field); with no marked file,
 * an unmarked one is read (never rewritten). Any damaged file → InvalidModelMetaError (never replaced, I3).
 */
async function readMetaState(store: DriveStore, files: readonly DriveFile[]): Promise<MetaState> {
  const marked = files.filter((f) => f.appCreated === true)
  if (marked.length > 0) {
    const metas: ModelMeta[] = []
    for (const f of marked) metas.push(await readModelMeta(store, f))
    return { meta: mergeModelMetas(metas), target: marked[0] }
  }
  const foreign = preferAppFile([...files])
  return { meta: foreign ? await readModelMeta(store, foreign) : null }
}

/** The merged meta of a folder listing (null = no meta file). */
export async function readFolderModelMeta(store: DriveStore, children: readonly DriveFile[]): Promise<ModelMeta | null> {
  return (await readMetaState(store, metaFilesOf(children))).meta
}

/**
 * The folder's meta as it is NOW (null = none). A damaged file throws InvalidModelMetaError: it is never
 * replaced (I3) — the Founder sees the problem instead.
 */
export async function readCurrentModelMeta(store: DriveStore, folderId: string): Promise<ModelMeta | null> {
  return (await readMetaState(store, await store.listChildren(folderId, { name: MODEL_META_FILE_NAME }))).meta
}

export const MODEL_META_BUSY_MESSAGE = `הקובץ ${MODEL_META_FILE_NAME} שונה בו-זמנית במקום אחר ולא ניתן היה לשמור. נסו שוב.`
export const MAX_META_SAVE_ATTEMPTS = 3

function revision(f: Pick<DriveFile, 'modifiedTime' | 'version'>): string {
  return `${f.modifiedTime ?? ''}|${f.version ?? ''}`
}

const chains = new Map<string, Promise<unknown>>()

/** Runs `fn` after every earlier meta change of the same folder (in this tab) has finished. */
function serialised<T>(folderId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(folderId) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  chains.set(folderId, run.catch(() => undefined))
  return run
}

/**
 * Merges `patch` into the folder's meta as it is NOW and writes it (creates it marked the first time). Only the
 * patched fields change; a value saved meanwhile (e.g. the cover from another tab) is kept (I2):
 *  a) calls for one folder run one after another (so one tab never creates two files);
 *  b) the target's revision is checked again right before writing — changed → read again, re-merge, retry
 *     (3 attempts, then a Hebrew error);
 *  c) several marked files are read as one (merged) and written to the oldest; every file stays in place.
 */
export async function writeModelMeta(
  store: DriveStore,
  folderId: string,
  patch: ModelMetaPatch,
  now: Date = new Date(),
): Promise<ModelMeta> {
  return serialised(folderId, async () => {
    for (let attempt = 1; attempt <= MAX_META_SAVE_ATTEMPTS; attempt++) {
      const files = await store.listChildren(folderId, { name: MODEL_META_FILE_NAME })
      const { meta: current, target } = await readMetaState(store, metaFilesOf(files))
      // The revision seen BEFORE the content was read.
      const seen = target ? revision(target) : null
      if (patch.description !== undefined && patch.description !== (current?.description ?? '')) assertDescriptionLength(patch.description)
      const next: ModelMeta = { ...(current ?? { schemaVersion: 1 }), ...patch, schemaVersion: 1, updatedAt: now.toISOString() }
      if (!next.coverFileId) delete next.coverFileId
      // A restore clears the archive time (archived:false is kept, so the file says it was restored).
      if (next.archivedAt === undefined || next.archived !== true) delete next.archivedAt
      if (!target) {
        await store.uploadFile(folderId, MODEL_META_FILE_NAME, jsonBlob(next), JSON_MIME)
        return next
      }
      if (revision(await store.getFile(target.id)) !== seen) continue
      await store.updateFileContent(target.id, jsonBlob(next), JSON_MIME)
      return next
    }
    throw new DriveError(`${MODEL_META_FILE_NAME} kept changing`, MODEL_META_BUSY_MESSAGE, 409)
  })
}
