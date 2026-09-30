import { mapLimit } from '../concurrency'
import {
  BID_FILE_NAME,
  INDEX_FILE_NAME,
  INDEX_MAX_AGE_MS,
  SETTINGS_FILE_NAME,
  defaultAppSettings,
  indexEntryFromBid,
  isBid,
  newId,
  normaliseSettings,
  sortIndex,
  type AppSettings,
  type Bid,
  type BidFile,
  type BidPart,
  type FileKind,
  type IndexEntry,
  type IndexFile,
} from '../bid'
import { classifyFolder, isPlatePictureName, isSkippedFolderName, pickCover, type FolderContents } from './folderContents'
import { DriveError, type DriveFile, type DriveStore } from './types'

/** How many model folders are listed in parallel when (re)building the library. */
export const FOLDER_SCAN_CONCURRENCY = 5

/**
 * Bid persistence on top of any DriveStore (brief §4–§5).
 * bid.json is the source of truth; _rubedo-index.json is a rebuildable cache.
 */

const JSON_MIME = 'application/json'

export interface LocalFile {
  /** Stable key within the form, used to skip already-uploaded files on retry. */
  key: string
  name: string
  kind: FileKind
  mimeType: string
  blob: Blob
}

export type DraftBidPart = BidPart & { slicedLocalKey?: string }

/** Everything in bid.json that the form controls. */
export type BidContent = Omit<Bid, 'schemaVersion' | 'id' | 'createdAt' | 'updatedAt' | 'files' | 'coverFileId' | 'parts'> & {
  parts: DraftBidPart[]
}

/**
 * Progress of one save attempt. Keep the same object between retries: the created folder is reused and
 * files already uploaded are skipped.
 */
export interface SaveSession {
  folderId?: string
  uploaded: Record<string, BidFile>
  bidFileId?: string
  /** Bid id/createdAt fixed on the first attempt so a retry writes the same bid. */
  bidId?: string
  createdAt?: string
}

export function newSaveSession(): SaveSession {
  return { uploaded: {} }
}

function jsonBlob(value: unknown): Blob {
  return new Blob([JSON.stringify(value, null, 2)], { type: JSON_MIME })
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()
}

export async function findFile(store: DriveStore, folderId: string, name: string): Promise<DriveFile | undefined> {
  const found = await store.listChildren(folderId, { name })
  return found[0]
}

/** The file was read fine but its content is not valid JSON (as opposed to a Drive/network failure). */
export class InvalidJsonError extends DriveError {
  constructor(what: string) {
    super(`${what}: invalid JSON`, `הקובץ ${what} פגום (JSON לא תקין).`)
    this.name = 'InvalidJsonError'
  }
}

async function readJson(store: DriveStore, fileId: string, what: string): Promise<unknown> {
  const text = await store.readText(fileId)
  try {
    return JSON.parse(text)
  } catch {
    throw new InvalidJsonError(what)
  }
}

async function writeJsonFile(store: DriveStore, folderId: string, name: string, value: unknown): Promise<string> {
  const existing = await findFile(store, folderId, name)
  if (existing) {
    await store.updateFileContent(existing.id, jsonBlob(value), JSON_MIME)
    return existing.id
  }
  const created = await store.uploadFile(folderId, name, jsonBlob(value), JSON_MIME)
  return created.id
}

// ---------- Settings ----------

/** Loads `_rubedo-settings.json`; creates it with defaults on first run. */
export async function loadSettings(store: DriveStore, modelsFolderId: string): Promise<AppSettings> {
  const file = await findFile(store, modelsFolderId, SETTINGS_FILE_NAME)
  if (!file) {
    const defaults = defaultAppSettings()
    await store.uploadFile(modelsFolderId, SETTINGS_FILE_NAME, jsonBlob(defaults), JSON_MIME)
    return defaults
  }
  return normaliseSettings(await readJson(store, file.id, SETTINGS_FILE_NAME))
}

export async function saveSettings(store: DriveStore, modelsFolderId: string, settings: AppSettings): Promise<void> {
  await writeJsonFile(store, modelsFolderId, SETTINGS_FILE_NAME, settings)
}

// ---------- Index / library ----------

export interface IndexData {
  entries: IndexEntry[]
  /** When the index was last fully rebuilt; undefined for pre-v0.3 index files (→ stale). */
  builtAt?: string
}

function isIndexEntry(e: unknown): e is IndexEntry {
  if (!e || typeof e !== 'object') return false
  const x = e as IndexEntry
  if (typeof x.id !== 'string' || typeof x.name !== 'string') return false
  return x.status === 'needs-slicing' || typeof x.price70 === 'number'
}

/**
 * Reads the index cache. Returns null (→ caller rebuilds) when it is missing, not valid JSON or malformed.
 * Accepts the pre-v0.3 format (bare array, no builtAt). Drive/network errors are rethrown.
 */
export async function readIndex(store: DriveStore, modelsFolderId: string): Promise<IndexData | null> {
  const file = await findFile(store, modelsFolderId, INDEX_FILE_NAME)
  if (!file) return null
  let raw: unknown
  try {
    raw = await readJson(store, file.id, INDEX_FILE_NAME)
  } catch (e) {
    if (e instanceof InvalidJsonError) return null
    throw e
  }
  if (Array.isArray(raw)) return { entries: raw.filter(isIndexEntry) }
  if (raw && typeof raw === 'object' && Array.isArray((raw as IndexFile).entries)) {
    const f = raw as IndexFile
    return { entries: f.entries.filter(isIndexEntry), builtAt: typeof f.builtAt === 'string' ? f.builtAt : undefined }
  }
  return null
}

async function writeIndex(store: DriveStore, modelsFolderId: string, entries: IndexEntry[], builtAt: string): Promise<void> {
  const file: IndexFile = { schemaVersion: 2, builtAt, entries: sortIndex(entries) }
  await writeJsonFile(store, modelsFolderId, INDEX_FILE_NAME, file)
}

/** True when the index was never fully rebuilt by v0.3 or is older than 10 minutes (N5). */
export function isIndexStale(builtAt: string | undefined, now: Date = new Date()): boolean {
  if (!builtAt) return true
  const t = Date.parse(builtAt)
  if (!Number.isFinite(t)) return true
  return now.getTime() - t > INDEX_MAX_AGE_MS
}

export interface RebuildResult {
  entries: IndexEntry[]
  /** Folders whose bid.json could not be read (skipped, not shown). */
  skipped: string[]
}

type FolderScan = { entry: IndexEntry } | { skipped: string } | null

async function scanModelFolder(store: DriveStore, folder: DriveFile): Promise<FolderScan> {
  const contents = classifyFolder(await store.listChildren(folder.id))
  if (!contents.bidFile) {
    // A folder the app created but never finished (save failed before bid.json) is not a model (brief §5).
    if (folder.appCreated === true) return null
    const entry: IndexEntry = {
      id: folder.id,
      name: folder.name.trim(),
      status: 'needs-slicing',
      revision: '',
      coverFileId: pickCover(contents.images),
      updatedAt: folder.modifiedTime ?? '',
    }
    if (!entry.coverFileId) delete entry.coverFileId
    if (contents.sliced[0]) entry.slicedFileId = contents.sliced[0].id
    return { entry }
  }
  let raw: unknown
  try {
    raw = await readJson(store, contents.bidFile.id, BID_FILE_NAME)
  } catch (e) {
    if (e instanceof InvalidJsonError) return { skipped: folder.name }
    throw e
  }
  if (!isBid(raw)) return { skipped: folder.name }
  const entry = indexEntryFromBid(folder.id, raw)
  entry.coverFileId = pickCover(contents.images, raw.coverFileId)
  if (!entry.coverFileId) delete entry.coverFileId
  return { entry }
}

/**
 * Rebuilds the index from every direct subfolder of the models folder (brief v0.3 N1): folders with bid.json →
 * priced; folders without → needs-slicing. Skips "_…" and "Models photo". Folders whose bid.json is corrupt are
 * reported in `skipped`. Any Drive error aborts the rebuild WITHOUT writing the index. Only reads model folders.
 */
export async function rebuildIndex(store: DriveStore, modelsFolderId: string, now: Date = new Date()): Promise<RebuildResult> {
  const folders = (await store.listChildren(modelsFolderId, { foldersOnly: true })).filter((f) => !isSkippedFolderName(f.name))
  const scans = await mapLimit(folders, FOLDER_SCAN_CONCURRENCY, (f) => scanModelFolder(store, f))
  const entries: IndexEntry[] = []
  const skipped: string[] = []
  for (const s of scans) {
    if (!s) continue
    if ('entry' in s) entries.push(s.entry)
    else skipped.push(s.skipped)
  }
  const sorted = sortIndex(entries)
  await writeIndex(store, modelsFolderId, sorted, now.toISOString())
  return { entries: sorted, skipped }
}

/** Library entries (newest first). Rebuilds the index if it does not exist yet. */
export async function loadLibrary(store: DriveStore, modelsFolderId: string): Promise<IndexEntry[]> {
  return (await loadLibraryState(store, modelsFolderId)).entries
}

/** Library entries plus whether the cached index is stale (→ the Library refreshes once, N5). */
export async function loadLibraryState(
  store: DriveStore,
  modelsFolderId: string,
  now: Date = new Date(),
): Promise<{ entries: IndexEntry[]; stale: boolean; rebuilt?: RebuildResult }> {
  const index = await readIndex(store, modelsFolderId)
  if (index === null) {
    const rebuilt = await rebuildIndex(store, modelsFolderId, now)
    return { entries: rebuilt.entries, stale: false, rebuilt }
  }
  return { entries: sortIndex(index.entries), stale: isIndexStale(index.builtAt, now) }
}

async function upsertIndexEntry(store: DriveStore, modelsFolderId: string, entry: IndexEntry): Promise<void> {
  const index = await readIndex(store, modelsFolderId)
  if (index === null) {
    // No cache yet: rebuild from the folders (includes the bid just written).
    await rebuildIndex(store, modelsFolderId)
    return
  }
  // Replaces any entry of the same folder (e.g. a needs-slicing card that just got its bid).
  const next = index.entries.filter((e) => e.id !== entry.id)
  next.push(entry)
  // Keep the original build time: an upsert is not a full rebuild (legacy index → still stale → rebuilt on open).
  await writeIndex(store, modelsFolderId, next, index.builtAt ?? new Date(0).toISOString())
}

// ---------- Model folder (page) ----------

export interface ModelFolder {
  folder: DriveFile
  contents: FolderContents
  /** Present when the folder has a valid bid.json. */
  bid?: Bid
}

/**
 * Everything the model page shows (N3/N4): the folder, all its files and its bid (if any). Read-only.
 * A bid.json that exists but is corrupt is an error (never shown as "needs slicing").
 */
export async function loadModelFolder(store: DriveStore, folderId: string): Promise<ModelFolder> {
  const [folder, children] = await Promise.all([store.getFile(folderId), store.listChildren(folderId)])
  const contents = classifyFolder(children)
  if (!contents.bidFile) return { folder, contents }
  const raw = await readJson(store, contents.bidFile.id, BID_FILE_NAME)
  if (!isBid(raw)) throw new DriveError('bid.json invalid', 'קובץ bid.json פגום או בגרסה לא נתמכת.')
  return { folder, contents, bid: raw }
}

// ---------- Name check ----------

export interface NameCheck {
  taken: boolean
  /** Suggested free folder/revision for "Save as new revision". */
  nextRevision: { folderName: string; revision: string }
}

/**
 * Is `name` used by another bid (folder name or bid name in the index)?
 * `excludeFolderId`: the bid being edited — its own folder/entry does not count.
 */
export async function checkName(
  store: DriveStore,
  modelsFolderId: string,
  name: string,
  excludeFolderId?: string,
): Promise<NameCheck> {
  const [folders, index] = await Promise.all([
    store.listChildren(modelsFolderId, { foldersOnly: true }),
    readIndex(store, modelsFolderId),
  ])
  const folderNames = folders.map((f) => f.name)
  const taken =
    folders.some((f) => f.id !== excludeFolderId && sameName(f.name, name)) ||
    (index?.entries ?? []).some((e) => e.id !== excludeFolderId && sameName(e.name, name))
  let n = 2
  while (folderNames.some((f) => sameName(f, `${name.trim()} V${n}`))) n += 1
  return { taken, nextRevision: { folderName: `${name.trim()} V${n}`, revision: `V${n}` } }
}

// ---------- Load ----------

export async function loadBid(store: DriveStore, folderId: string): Promise<{ bid: Bid; bidFileId: string }> {
  const file = await findFile(store, folderId, BID_FILE_NAME)
  if (!file) throw new DriveError('bid.json missing', 'לא נמצא קובץ bid.json בתיקיית הדגם.', 404)
  const raw = await readJson(store, file.id, BID_FILE_NAME)
  if (!isBid(raw)) throw new DriveError('bid.json invalid', 'קובץ bid.json פגום או בגרסה לא נתמכת.')
  return { bid: raw, bidFileId: file.id }
}

// ---------- Save / edit ----------

async function uploadMissing(store: DriveStore, folderId: string, files: LocalFile[], session: SaveSession): Promise<void> {
  for (const f of files) {
    if (session.uploaded[f.key]) continue
    const created = await store.uploadFile(folderId, f.name, f.blob, f.mimeType)
    session.uploaded[f.key] = { id: created.id, name: f.name, kind: f.kind, mimeType: f.mimeType }
  }
}

function resolveParts(parts: DraftBidPart[], session: SaveSession): BidPart[] {
  return parts.map(({ slicedLocalKey, ...p }) => {
    const uploaded = slicedLocalKey ? session.uploaded[slicedLocalKey] : undefined
    const part: BidPart = { ...p }
    if (uploaded) part.slicedFileId = uploaded.id
    return part
  })
}

function firstImage(files: BidFile[]): string | undefined {
  return files.find((f) => f.kind === 'image')?.id
}

export interface SaveNewParams {
  /** Folder to create under the models folder (the name, or "<name> V2" …). Ignored with `existingFolderId`. */
  folderName: string
  /**
   * N2: write the bid INTO this existing model folder (not created by the app) instead of creating a folder.
   * Only new files are created in it (uploads + bid.json); nothing already there is modified.
   */
  existingFolderId?: string
  /** Files already in that folder that the bid refers to (e.g. the sliced .gcode.3mf) — not re-uploaded. */
  existingFiles?: BidFile[]
  content: BidContent
  /** Files in display order; the first image becomes the cover. */
  files: LocalFile[]
  now?: Date
}

/**
 * Saves a new bid: create folder → upload files → write bid.json LAST → update index.
 * On failure the session keeps progress; call again with the same session to resume.
 */
export async function saveNewBid(
  store: DriveStore,
  modelsFolderId: string,
  params: SaveNewParams,
  session: SaveSession,
): Promise<{ folderId: string; bid: Bid }> {
  if (params.existingFolderId) {
    session.folderId = params.existingFolderId
    // Never overwrite a bid that is already there (e.g. saved meanwhile from another tab).
    if (!session.bidFileId && (await findFile(store, params.existingFolderId, BID_FILE_NAME))) {
      throw new DriveError('bid.json already exists', 'כבר קיימת הצעת מחיר בתיקייה הזו. רעננו את הספרייה ופתחו אותה משם.', 409)
    }
  }
  if (!session.folderId) {
    const folder = await store.createFolder(modelsFolderId, params.folderName)
    session.folderId = folder.id
  }
  const folderId = session.folderId

  await uploadMissing(store, folderId, params.files, session)

  const now = (params.now ?? new Date()).toISOString()
  session.bidId ??= newId()
  session.createdAt ??= now
  const uploadedFiles = params.files.map((f) => session.uploaded[f.key])
  const files = [...uploadedFiles, ...(params.existingFiles ?? [])]
  const bid: Bid = {
    schemaVersion: 1,
    id: session.bidId,
    createdAt: session.createdAt,
    updatedAt: now,
    ...params.content,
    parts: resolveParts(params.content.parts, session),
    files,
    // In an existing folder a plate picture must not hide the Founder's own photos: no explicit cover then,
    // so the cover rule (first photo by name, else plate picture) applies (N3).
    coverFileId: params.existingFolderId ? firstImage(uploadedFiles.filter((f) => !isPlatePictureName(f.name))) : firstImage(files),
  }
  if (!bid.coverFileId) delete bid.coverFileId

  if (session.bidFileId) {
    await store.updateFileContent(session.bidFileId, jsonBlob(bid), JSON_MIME)
  } else {
    const created = await store.uploadFile(folderId, BID_FILE_NAME, jsonBlob(bid), JSON_MIME)
    session.bidFileId = created.id
  }

  const entry = indexEntryFromBid(folderId, bid)
  if (params.existingFolderId && !entry.coverFileId) {
    entry.coverFileId = pickCover(classifyFolder(await store.listChildren(folderId)).images)
    if (!entry.coverFileId) delete entry.coverFileId
  }
  await upsertIndexEntry(store, modelsFolderId, entry)
  return { folderId, bid }
}

export interface UpdateParams {
  folderId: string
  existing: Bid
  content: BidContent
  /** Newly added files only (existing ones stay as they are). */
  newFiles: LocalFile[]
  now?: Date
}

/** Edit flow: upload new files → rewrite bid.json (id/createdAt kept) → update index. */
export async function updateBid(
  store: DriveStore,
  modelsFolderId: string,
  params: UpdateParams,
  session: SaveSession,
): Promise<Bid> {
  const { folderId, existing } = params
  await uploadMissing(store, folderId, params.newFiles, session)

  const files = [...existing.files, ...params.newFiles.map((f) => session.uploaded[f.key])]
  const existingParts = params.content.parts
  const bid: Bid = {
    ...existing,
    ...params.content,
    schemaVersion: 1,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: (params.now ?? new Date()).toISOString(),
    parts: resolveParts(existingParts, session),
    files,
    coverFileId: existing.coverFileId ?? firstImage(files),
  }
  if (!bid.coverFileId) delete bid.coverFileId

  const bidFile = await findFile(store, folderId, BID_FILE_NAME)
  if (!bidFile) throw new DriveError('bid.json missing', 'לא נמצא קובץ bid.json בתיקיית הדגם.', 404)
  await store.updateFileContent(bidFile.id, jsonBlob(bid), JSON_MIME)

  const entry = indexEntryFromBid(folderId, bid)
  if (!entry.coverFileId) {
    // Photos the Founder added to the folder later can be the cover (N3).
    entry.coverFileId = pickCover(classifyFolder(await store.listChildren(folderId)).images)
    if (!entry.coverFileId) delete entry.coverFileId
  }
  await upsertIndexEntry(store, modelsFolderId, entry)
  return bid
}
