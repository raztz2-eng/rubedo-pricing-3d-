import {
  BID_FILE_NAME,
  INDEX_FILE_NAME,
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
} from '../bid'
import { DriveError, type DriveFile, type DriveStore } from './types'

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

async function readJson(store: DriveStore, fileId: string, what: string): Promise<unknown> {
  const text = await store.readText(fileId)
  try {
    return JSON.parse(text)
  } catch {
    throw new DriveError(`${what}: invalid JSON`, `הקובץ ${what} פגום (JSON לא תקין).`)
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

export async function readIndex(store: DriveStore, modelsFolderId: string): Promise<IndexEntry[] | null> {
  const file = await findFile(store, modelsFolderId, INDEX_FILE_NAME)
  if (!file) return null
  const raw = await readJson(store, file.id, INDEX_FILE_NAME)
  if (!Array.isArray(raw)) return null
  return raw.filter(
    (e): e is IndexEntry => !!e && typeof e.id === 'string' && typeof e.name === 'string' && typeof e.price70 === 'number',
  )
}

export interface RebuildResult {
  entries: IndexEntry[]
  /** Folders whose bid.json could not be read (skipped, not shown). */
  skipped: string[]
}

/** Rebuilds the index from every `<model>/bid.json`. Folders without bid.json are ignored. */
export async function rebuildIndex(store: DriveStore, modelsFolderId: string): Promise<RebuildResult> {
  const folders = await store.listChildren(modelsFolderId, { foldersOnly: true })
  const entries: IndexEntry[] = []
  const skipped: string[] = []
  for (const folder of folders) {
    const bidFile = await findFile(store, folder.id, BID_FILE_NAME)
    if (!bidFile) continue
    try {
      const raw = await readJson(store, bidFile.id, BID_FILE_NAME)
      if (!isBid(raw)) {
        skipped.push(folder.name)
        continue
      }
      entries.push(indexEntryFromBid(folder.id, raw))
    } catch {
      skipped.push(folder.name)
    }
  }
  const sorted = sortIndex(entries)
  await writeJsonFile(store, modelsFolderId, INDEX_FILE_NAME, sorted)
  return { entries: sorted, skipped }
}

/** Library entries (newest first). Rebuilds the index if it does not exist yet. */
export async function loadLibrary(store: DriveStore, modelsFolderId: string): Promise<IndexEntry[]> {
  const index = await readIndex(store, modelsFolderId)
  if (index === null) return (await rebuildIndex(store, modelsFolderId)).entries
  return sortIndex(index)
}

async function upsertIndexEntry(store: DriveStore, modelsFolderId: string, entry: IndexEntry): Promise<void> {
  const index = await readIndex(store, modelsFolderId)
  if (index === null) {
    // No cache yet: rebuild from bid.json files (includes the bid just written).
    await rebuildIndex(store, modelsFolderId)
    return
  }
  const next = index.filter((e) => e.id !== entry.id)
  next.push(entry)
  await writeJsonFile(store, modelsFolderId, INDEX_FILE_NAME, sortIndex(next))
}

// ---------- Name check ----------

export interface NameCheck {
  taken: boolean
  /** Suggested free folder/revision for "Save as new revision". */
  nextRevision: { folderName: string; revision: string }
}

export async function checkName(store: DriveStore, modelsFolderId: string, name: string): Promise<NameCheck> {
  const [folders, index] = await Promise.all([
    store.listChildren(modelsFolderId, { foldersOnly: true }),
    readIndex(store, modelsFolderId),
  ])
  const folderNames = folders.map((f) => f.name)
  const taken = folderNames.some((n) => sameName(n, name)) || (index ?? []).some((e) => sameName(e.name, name))
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
  /** Folder to create under the models folder (the name, or "<name> V2" …). */
  folderName: string
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
  if (!session.folderId) {
    const folder = await store.createFolder(modelsFolderId, params.folderName)
    session.folderId = folder.id
  }
  const folderId = session.folderId

  await uploadMissing(store, folderId, params.files, session)

  const now = (params.now ?? new Date()).toISOString()
  session.bidId ??= newId()
  session.createdAt ??= now
  const files = params.files.map((f) => session.uploaded[f.key])
  const bid: Bid = {
    schemaVersion: 1,
    id: session.bidId,
    createdAt: session.createdAt,
    updatedAt: now,
    ...params.content,
    parts: resolveParts(params.content.parts, session),
    files,
    coverFileId: firstImage(files),
  }
  if (!bid.coverFileId) delete bid.coverFileId

  if (session.bidFileId) {
    await store.updateFileContent(session.bidFileId, jsonBlob(bid), JSON_MIME)
  } else {
    const created = await store.uploadFile(folderId, BID_FILE_NAME, jsonBlob(bid), JSON_MIME)
    session.bidFileId = created.id
  }

  await upsertIndexEntry(store, modelsFolderId, indexEntryFromBid(folderId, bid))
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

  await upsertIndexEntry(store, modelsFolderId, indexEntryFromBid(folderId, bid))
  return bid
}
