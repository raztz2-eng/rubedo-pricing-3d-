import { mapLimit } from '../concurrency'
import {
  BID_FILE_NAME,
  BID_SCHEMA_VERSION,
  FOLDER_MIME,
  INDEX_FILE_NAME,
  INDEX_MAX_AGE_MS,
  INDEX_SCHEMA_VERSION,
  SETTINGS_FILE_NAME,
  defaultAppSettings,
  indexEntryFromBid,
  newId,
  normaliseSettings,
  parseBid,
  sortIndex,
  type AppSettings,
  type Bid,
  type BidFile,
  type BidPart,
  type CustomerQuoteSummary,
  type FileKind,
  type IndexEntry,
  type IndexFile,
  type QuoteSummary,
} from '../bid'
import { byDateDesc, summariseQuotes } from '../customers'
import { logError } from '../errors'
import { classifyFolder, isGoogleNativeFile, isPlatePictureName, isSkippedFolderName, pickCover, type FolderContents } from './folderContents'
import { findFile, InvalidJsonError, JSON_MIME, jsonBlob, readJson, writeJsonFile } from './jsonFiles'
import { assertDescriptionLength, InvalidModelMetaError, readCurrentModelMeta, readModelMeta, writeModelMeta, type ModelMeta } from './modelMeta'
import { findQuotesFolder, isQuoteLogName, readQuoteSummary } from './quoteLog'
import { DriveError, type DriveFile, type DriveStore } from './types'

/** How many model folders are listed in parallel when (re)building the library. */
export const FOLDER_SCAN_CONCURRENCY = 5

/**
 * Bid persistence on top of any DriveStore (brief §4–§5).
 * bid.json is the source of truth; _rubedo-index.json is a rebuildable cache.
 */

export { findFile, InvalidJsonError } from './jsonFiles'

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
  /** Edit flow: the updatedAt this session wrote into bid.json (a retry after a later failure is not "changed elsewhere"). */
  writtenUpdatedAt?: string
}

export function newSaveSession(): SaveSession {
  return { uploaded: {} }
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()
}

// ---------- Settings ----------

/** Loads `_rubedo-settings.json`; creates it with defaults on first run. */
export async function loadSettings(store: DriveStore, modelsFolderId: string): Promise<AppSettings> {
  return (await loadSettingsWithStatus(store, modelsFolderId)).settings
}

/**
 * How the settings were obtained: `existing` (the app's marked file), `defaults` (no file → created with defaults),
 * `copied` (only an unmarked pre-v0.4 file → a NEW marked file seeded with its values; the old one is untouched).
 */
export type SettingsOrigin = 'existing' | 'defaults' | 'copied'

/** Like loadSettings, plus how they were obtained (a new file → one-time I2 notice). */
export async function loadSettingsWithStatus(
  store: DriveStore,
  modelsFolderId: string,
): Promise<{ settings: AppSettings; created: boolean; origin: SettingsOrigin }> {
  const file = await findFile(store, modelsFolderId, SETTINGS_FILE_NAME)
  if (file?.appCreated === true) {
    return { settings: normaliseSettings(await readJson(store, file.id, SETTINGS_FILE_NAME)), created: false, origin: 'existing' }
  }
  // Reading the old file is fine; a corrupt one is an error (never silently replaced by defaults).
  const settings = file ? normaliseSettings(await readJson(store, file.id, SETTINGS_FILE_NAME)) : defaultAppSettings()
  await store.uploadFile(modelsFolderId, SETTINGS_FILE_NAME, jsonBlob(settings), JSON_MIME)
  return { settings, created: true, origin: file ? 'copied' : 'defaults' }
}

export async function saveSettings(store: DriveStore, modelsFolderId: string, settings: AppSettings): Promise<void> {
  await writeJsonFile(store, modelsFolderId, SETTINGS_FILE_NAME, settings)
}

// ---------- Index / library ----------

export interface IndexData {
  entries: IndexEntry[]
  /**
   * When the index was last fully rebuilt; undefined (→ stale) for index files older than this version's schema
   * (pre-v0.3 bare arrays, v2 files without the quote history, v3 files without the archived flag).
   */
  builtAt?: string
  /** Quote logs of all models, newest first (v3; [] for older index files). */
  quotes: QuoteSummary[]
  /** Quotes per customer (v3; [] for older index files). */
  customers: CustomerQuoteSummary[]
}

function isIndexEntry(e: unknown): e is IndexEntry {
  if (!e || typeof e !== 'object') return false
  const x = e as IndexEntry
  if (typeof x.id !== 'string' || typeof x.name !== 'string') return false
  if (x.archived !== undefined && typeof x.archived !== 'boolean') return false
  return x.status === 'needs-slicing' || typeof x.price70 === 'number'
}

function isQuoteSummary(q: unknown): q is QuoteSummary {
  if (!q || typeof q !== 'object') return false
  const x = q as QuoteSummary
  return (
    typeof x.folderId === 'string' &&
    typeof x.fileId === 'string' &&
    typeof x.date === 'string' &&
    typeof x.email === 'string' &&
    typeof x.customerName === 'string' &&
    typeof x.modelName === 'string' &&
    typeof x.priceShown === 'number'
  )
}

/**
 * Reads the index cache. Returns null (→ caller rebuilds) when it is missing, not valid JSON or malformed.
 * Accepts older formats (bare array; schemaVersion 2 and 3) as stale. Drive/network errors are rethrown.
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
  if (Array.isArray(raw)) return { entries: raw.filter(isIndexEntry), quotes: [], customers: [] }
  if (raw && typeof raw === 'object' && Array.isArray((raw as IndexFile).entries)) {
    const f = raw as IndexFile
    const entries = f.entries.filter(isIndexEntry)
    if (f.schemaVersion !== INDEX_SCHEMA_VERSION) return { entries, quotes: [], customers: [] }
    const quotes = Array.isArray(f.quotes) ? f.quotes.filter(isQuoteSummary) : []
    return { entries, builtAt: typeof f.builtAt === 'string' ? f.builtAt : undefined, quotes, customers: summariseQuotes(quotes) }
  }
  return null
}

async function writeIndex(
  store: DriveStore,
  modelsFolderId: string,
  entries: IndexEntry[],
  builtAt: string,
  quotes: QuoteSummary[],
): Promise<void> {
  const sortedQuotes = [...quotes].sort(byDateDesc)
  const file: IndexFile = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    builtAt,
    entries: sortIndex(entries),
    quotes: sortedQuotes,
    customers: summariseQuotes(sortedQuotes),
  }
  await writeJsonFile(store, modelsFolderId, INDEX_FILE_NAME, file)
}

/** True when the index was never fully rebuilt by this version or is older than 10 minutes (N5). */
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
  /** Quote logs of all models, newest first (v0.6 E4). */
  quotes: QuoteSummary[]
  customers: CustomerQuoteSummary[]
  /** Quote log files that are not valid quote logs (left out of the customer history). */
  skippedQuotes: string[]
}

type FolderScan = { entry?: IndexEntry; skipped?: string; quotesFolder?: DriveFile } | null

/** What the library takes from a folder's `_rubedo-model.json`: the chosen cover (v0.6 E2) and the archive flag (v0.7). */
interface MetaInfo {
  /** Only if it is still one of the folder's pictures. */
  cover?: string
  archived: boolean
}

function metaInfoOf(meta: ModelMeta | null | undefined, contents: FolderContents): MetaInfo {
  const cover = meta?.coverFileId && contents.images.some((i) => i.id === meta.coverFileId) ? meta.coverFileId : undefined
  return { ...(cover ? { cover } : {}), archived: meta?.archived === true }
}

/** Reads `_rubedo-model.json` for the library. A damaged file is ignored here (not archived, default cover). */
async function readMetaInfo(store: DriveStore, contents: FolderContents): Promise<MetaInfo> {
  if (!contents.metaFile) return { archived: false }
  try {
    return metaInfoOf(await readModelMeta(store, contents.metaFile), contents)
  } catch (e) {
    // The model page shows the problem; the library falls back to the default cover rule.
    if (e instanceof InvalidModelMetaError) return { archived: false }
    throw e
  }
}

/** Library card of a folder without bid.json (N1); cover/archived from `_rubedo-model.json` (v0.6 E2, v0.7 A1). */
function needsSlicingEntry(folder: DriveFile, contents: FolderContents, meta: MetaInfo = { archived: false }): IndexEntry {
  const entry: IndexEntry = {
    id: folder.id,
    name: folder.name.trim(),
    status: 'needs-slicing',
    revision: '',
    coverFileId: pickCover(contents.images, meta.cover),
    updatedAt: folder.modifiedTime ?? '',
    archived: meta.archived,
  }
  if (!entry.coverFileId) delete entry.coverFileId
  if (contents.sliced[0]) entry.slicedFileId = contents.sliced[0].id
  return entry
}

async function scanModelFolder(store: DriveStore, folder: DriveFile): Promise<FolderScan> {
  const children = await store.listChildren(folder.id)
  const contents = classifyFolder(children)
  const quotesFolder = findQuotesFolder(children)
  const withQuotes = (scan: { entry?: IndexEntry; skipped?: string }): FolderScan => (quotesFolder ? { ...scan, quotesFolder } : scan)
  if (!contents.bidFile) {
    // A folder the app created but never finished (save failed before bid.json) is not a model (brief §5).
    if (folder.appCreated === true) return null
    return withQuotes({ entry: needsSlicingEntry(folder, contents, await readMetaInfo(store, contents)) })
  }
  let raw: unknown
  try {
    raw = await readJson(store, contents.bidFile.id, BID_FILE_NAME)
  } catch (e) {
    if (e instanceof InvalidJsonError) return withQuotes({ skipped: folder.name })
    throw e
  }
  const bid = parseBid(raw)
  if (!bid) return withQuotes({ skipped: folder.name })
  const entry = indexEntryFromBid(folder.id, bid)
  entry.coverFileId = pickCover(contents.images, bid.coverFileId)
  if (!entry.coverFileId) delete entry.coverFileId
  // A pre-v0.4 (unmarked) bid.json is never written: its archive flag lives in `_rubedo-model.json` (v0.7 A1).
  if (contents.bidFile.appCreated !== true) entry.archived = (await readMetaInfo(store, contents)).archived
  return withQuotes({ entry })
}

/**
 * Reads the quote logs of the given model folders (listing and reading both concurrency-limited). Logs already in
 * the previous index (same file id — logs are never rewritten) are reused, so only new logs are read. A log that
 * cannot be read or is not a quote log is reported in `skipped` and does not stop the refresh (I4).
 */
async function scanQuoteLogs(
  store: DriveStore,
  folders: { folder: DriveFile; quotesFolder: DriveFile }[],
  known: ReadonlyMap<string, QuoteSummary>,
): Promise<{ quotes: QuoteSummary[]; skipped: string[] }> {
  const listed = await mapLimit(folders, FOLDER_SCAN_CONCURRENCY, async ({ folder, quotesFolder }) =>
    (await store.listChildren(quotesFolder.id))
      .filter((f) => f.mimeType !== FOLDER_MIME && !isGoogleNativeFile(f) && isQuoteLogName(f.name))
      .map((file) => ({ file, model: { folderId: folder.id, folderName: folder.name.trim() } })),
  )
  const logs = listed.flat()
  const read = await mapLimit(logs, FOLDER_SCAN_CONCURRENCY, async (l): Promise<QuoteSummary | null> => {
    const cached = known.get(l.file.id)
    if (cached && cached.folderId === l.model.folderId) return cached
    try {
      return await readQuoteSummary(store, l.file, l.model)
    } catch (e) {
      logError(`read quote log ${l.file.name}`, e)
      return null
    }
  })
  const quotes: QuoteSummary[] = []
  const skipped: string[] = []
  read.forEach((q, i) => {
    if (q) quotes.push(q)
    else skipped.push(`${logs[i].model.folderName}/${logs[i].file.name}`)
  })
  return { quotes: quotes.sort(byDateDesc), skipped }
}

/**
 * Rebuilds the index from every direct subfolder of the models folder (brief v0.3 N1): folders with bid.json →
 * priced; folders without → needs-slicing. Skips "_…" and "Models photo". Folders whose bid.json is corrupt are
 * reported in `skipped`. Also collects the quote logs of every model (v0.6 E4 customer history).
 * Any Drive error aborts the rebuild WITHOUT writing the index. Only reads model folders.
 */
export async function rebuildIndex(store: DriveStore, modelsFolderId: string, now: Date = new Date()): Promise<RebuildResult> {
  const generation = quotesGeneration(store)
  const previous = await readIndex(store, modelsFolderId)
  const known = new Map((previous?.quotes ?? []).map((q) => [q.fileId, q]))
  const folders = (await store.listChildren(modelsFolderId, { foldersOnly: true })).filter((f) => !isSkippedFolderName(f.name))
  const scans = await mapLimit(folders, FOLDER_SCAN_CONCURRENCY, (f) => scanModelFolder(store, f))
  const entries: IndexEntry[] = []
  const skipped: string[] = []
  const withLogs: { folder: DriveFile; quotesFolder: DriveFile }[] = []
  scans.forEach((s, i) => {
    if (!s) return
    if (s.entry) entries.push(s.entry)
    if (s.skipped) skipped.push(s.skipped)
    if (s.quotesFolder) withLogs.push({ folder: folders[i], quotesFolder: s.quotesFolder })
  })
  const logs = await scanQuoteLogs(store, withLogs, known)
  const sorted = sortIndex(entries)
  await writeIndex(store, modelsFolderId, sorted, now.toISOString(), logs.quotes)
  // Only a successful rebuild clears "quotes changed" — and only up to the quotes it could have seen.
  quotesSeen.set(store, generation)
  return { entries: sorted, skipped, quotes: logs.quotes, customers: summariseQuotes(logs.quotes), skippedQuotes: logs.skipped }
}

/** Library entries (newest first). Rebuilds the index if it does not exist yet. */
export async function loadLibrary(store: DriveStore, modelsFolderId: string): Promise<IndexEntry[]> {
  return (await loadLibraryState(store, modelsFolderId)).entries
}

/** Library entries + quote history, plus whether the cached index is stale (→ the caller refreshes once, N5). */
export async function loadLibraryState(
  store: DriveStore,
  modelsFolderId: string,
  now: Date = new Date(),
): Promise<{ entries: IndexEntry[]; quotes: QuoteSummary[]; stale: boolean; rebuilt?: RebuildResult }> {
  const index = await readIndex(store, modelsFolderId)
  if (index === null) {
    const rebuilt = await rebuildIndex(store, modelsFolderId, now)
    return { entries: rebuilt.entries, quotes: rebuilt.quotes, stale: false, rebuilt }
  }
  return { entries: sortIndex(index.entries), quotes: index.quotes, stale: isIndexStale(index.builtAt, now) }
}

/**
 * Quote logs written in this browser session (a counter per store) and how many of them the last successful rebuild
 * covered. Kept in memory only — writing a quote never touches the index — so the customer pages rebuild once on open.
 */
const quotesWritten = new WeakMap<DriveStore, number>()
const quotesSeen = new WeakMap<DriveStore, number>()

function quotesGeneration(store: DriveStore): number {
  return quotesWritten.get(store) ?? 0
}

/** Called after a quote log was written: the cached quote history is out of date. */
export function markQuotesChanged(store: DriveStore): void {
  quotesWritten.set(store, quotesGeneration(store) + 1)
}

function quotesChangedSinceRebuild(store: DriveStore): boolean {
  return quotesGeneration(store) > (quotesSeen.get(store) ?? 0)
}

export interface QuoteHistory {
  entries: IndexEntry[]
  quotes: QuoteSummary[]
  /** Quote logs that could not be read (only known after a rebuild). */
  skippedQuotes: string[]
}

/**
 * Customer history (v0.6 E4): the quote logs of every model, from the index cache. Rebuilt when asked (`refresh`),
 * when the cache is missing/stale/older than this version, or when a quote was written in this session.
 */
export async function loadQuoteHistory(
  store: DriveStore,
  modelsFolderId: string,
  options: { refresh?: boolean; now?: Date } = {},
): Promise<QuoteHistory> {
  const now = options.now ?? new Date()
  if (!options.refresh) {
    const state = await loadLibraryState(store, modelsFolderId, now)
    if (state.rebuilt) return { entries: state.entries, quotes: state.quotes, skippedQuotes: state.rebuilt.skippedQuotes }
    if (!state.stale && !quotesChangedSinceRebuild(store)) return { entries: state.entries, quotes: state.quotes, skippedQuotes: [] }
  }
  const r = await rebuildIndex(store, modelsFolderId, now)
  return { entries: r.entries, quotes: r.quotes, skippedQuotes: r.skippedQuotes }
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
  // Keep the original build time: an upsert is not a full rebuild (older index → still stale → rebuilt on open).
  await writeIndex(store, modelsFolderId, next, index.builtAt ?? new Date(0).toISOString(), index.quotes)
}

// ---------- Model folder (page) ----------

export interface ModelFolder {
  folder: DriveFile
  contents: FolderContents
  /** Present when the folder has a valid bid.json. */
  bid?: Bid
  /** The bid.json shown has no app marker (saved before v0.4): read-only, can only be converted (E1). */
  legacyBid?: boolean
  /**
   * v0.6: `_rubedo-model.json` of a folder WITHOUT bid.json (cover + description + archived), or — v0.7 — of a folder
   * with a pre-v0.4 bid (only its archived flag is used then).
   */
  meta?: ModelMeta
  /** The meta file exists but could not be used (Hebrew); the page shows it, cover/description fall back. */
  metaError?: string
}

/** Shown on bids saved before v0.4 (bid.json without the app marker). */
export const LEGACY_BID_MESSAGE =
  'הצעה זו נשמרה בגרסה ישנה ולכן אינה ניתנת לעריכה. אפשר להמיר אותה להצעה ניתנת לעריכה — הקובץ הישן יישאר כפי שהוא.'

/** E1: the action that turns a pre-v0.4 (read-only) bid into an editable one (= the "create again" flow, prefilled). */
export const CONVERT_LEGACY_LABEL = 'המר להצעה ניתנת לעריכה'

/**
 * Everything the model page shows (N3/N4): the folder, all its files and its bid (if any). Read-only.
 * A bid.json that exists but is corrupt is an error (never shown as "needs slicing").
 */
export async function loadModelFolder(store: DriveStore, folderId: string): Promise<ModelFolder> {
  const [folder, children] = await Promise.all([store.getFile(folderId), store.listChildren(folderId)])
  const contents = classifyFolder(children)
  if (!contents.bidFile) {
    if (!contents.metaFile) return { folder, contents }
    try {
      return { folder, contents, meta: await readModelMeta(store, contents.metaFile) }
    } catch (e) {
      if (e instanceof InvalidModelMetaError) return { folder, contents, metaError: e.userMessage }
      throw e
    }
  }
  const bid = parseBid(await readJson(store, contents.bidFile.id, BID_FILE_NAME))
  if (!bid) throw new DriveError('bid.json invalid', 'קובץ bid.json פגום או בגרסה לא נתמכת.')
  if (contents.bidFile.appCreated === true) return { folder, contents, bid }
  // Pre-v0.4 bid: its archive flag (v0.7) is in `_rubedo-model.json`.
  if (!contents.metaFile) return { folder, contents, bid, legacyBid: true }
  try {
    return { folder, contents, bid, legacyBid: true, meta: await readModelMeta(store, contents.metaFile) }
  } catch (e) {
    if (e instanceof InvalidModelMetaError) return { folder, contents, bid, legacyBid: true, metaError: e.userMessage }
    throw e
  }
}

/** v0.7: is the model archived? A marked bid keeps the flag in bid.json; anything else in `_rubedo-model.json`. */
export function isModelArchived(model: Pick<ModelFolder, 'bid' | 'legacyBid' | 'meta'>): boolean {
  if (model.bid && !model.legacyBid) return model.bid.archived === true
  return model.meta?.archived === true
}

/** The cover the model page / library show: the chosen one (bid or `_rubedo-model.json`) if still in the folder, else the default rule. */
export function displayCover(model: Pick<ModelFolder, 'contents' | 'bid' | 'meta'>): string | undefined {
  const chosen = model.bid ? model.bid.coverFileId : model.meta?.coverFileId
  if (chosen && (model.bid || model.contents.images.some((i) => i.id === chosen))) return chosen
  return pickCover(model.contents.images)
}

// ---------- Existing model folder check (I4) ----------

export const NOT_MODEL_FOLDER_MESSAGE = 'התיקייה הזו אינה תיקיית דגם ישירות בתוך תיקיית הדגמים שנבחרה, ולכן לא תיצור בה הצעת מחיר.'

/**
 * A folder may receive a bid (N2) only if it is a direct, non-skipped subfolder of the models folder.
 * Returns its metadata; throws a Hebrew DriveError otherwise.
 */
export async function requireModelFolder(store: DriveStore, modelsFolderId: string, folderId: string): Promise<DriveFile> {
  const folder = await store.getFile(folderId)
  if (folder.mimeType !== FOLDER_MIME || !(folder.parents ?? []).includes(modelsFolderId) || isSkippedFolderName(folder.name)) {
    throw new DriveError(`not a model folder: ${folderId}`, NOT_MODEL_FOLDER_MESSAGE, 400)
  }
  return folder
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

export async function loadBid(store: DriveStore, folderId: string): Promise<{ bid: Bid; bidFileId: string; legacy: boolean }> {
  const file = await findFile(store, folderId, BID_FILE_NAME)
  if (!file) throw new DriveError('bid.json missing', 'לא נמצא קובץ bid.json בתיקיית הדגם.', 404)
  const bid = parseBid(await readJson(store, file.id, BID_FILE_NAME))
  if (!bid) throw new DriveError('bid.json invalid', 'קובץ bid.json פגום או בגרסה לא נתמכת.')
  return { bid, bidFileId: file.id, legacy: file.appCreated !== true }
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
  /**
   * Existing-folder saves only: a cover already chosen for this folder (v0.6 — `_rubedo-model.json`, or the cover of
   * a pre-v0.4 bid being converted). Wins over the uploads.
   */
  coverFileId?: string
  /** E1 conversion of a pre-v0.4 bid: the new bid.json keeps the old bid's id and createdAt. */
  keepIdentity?: { id: string; createdAt: string }
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
    if (!session.bidFileId) await requireModelFolder(store, modelsFolderId, params.existingFolderId)
    session.folderId = params.existingFolderId
    // Never overwrite a bid that is already there (e.g. saved meanwhile from another tab). An unmarked bid.json
    // (pre-v0.4, read-only) stays untouched: the new marked bid.json is written next to it (I2 "re-create").
    if (!session.bidFileId && (await findFile(store, params.existingFolderId, BID_FILE_NAME))?.appCreated === true) {
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
  session.bidId ??= params.keepIdentity?.id ?? newId()
  session.createdAt ??= params.keepIdentity?.createdAt ?? now
  const uploadedFiles = params.files.map((f) => session.uploaded[f.key])
  const files = [...uploadedFiles, ...(params.existingFiles ?? [])]
  const bid: Bid = {
    schemaVersion: BID_SCHEMA_VERSION,
    id: session.bidId,
    createdAt: session.createdAt,
    updatedAt: now,
    ...params.content,
    parts: resolveParts(params.content.parts, session),
    files,
    // In an existing folder a plate picture must not hide the Founder's own photos: no explicit cover then,
    // so the cover rule (first photo by name, else plate picture) applies (N3).
    coverFileId: params.existingFolderId
      ? (params.coverFileId ?? firstImage(uploadedFiles.filter((f) => !isPlatePictureName(f.name))))
      : firstImage(files),
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
  /** v0.6 E2: set this picture (already in the folder) as the cover. */
  coverFileId?: string
  /** v0.6 E2: the new upload with this key becomes the cover ("upload a new photo as cover"). */
  coverFromNewFileKey?: string
  now?: Date
}

/** Edit flow: upload new files → rewrite bid.json (id/createdAt kept) → update index. */
export const BID_CHANGED_MESSAGE = 'ההצעה שונתה בחלון אחר — טענו מחדש'

export async function updateBid(
  store: DriveStore,
  modelsFolderId: string,
  params: UpdateParams,
  session: SaveSession,
): Promise<Bid> {
  const { folderId, existing } = params
  // The limit applies to a description being changed (an older, longer text can still be saved as it is).
  if (params.content.description !== existing.description) assertDescriptionLength(params.content.description)
  // Checked before anything is written: a pre-v0.4 bid.json (no marker) is read-only (I2).
  const bidFile = await findFile(store, folderId, BID_FILE_NAME)
  if (!bidFile) throw new DriveError('bid.json missing', 'לא נמצא קובץ bid.json בתיקיית הדגם.', 404)
  if (bidFile.appCreated !== true) throw new DriveError('legacy bid.json is read-only', LEGACY_BID_MESSAGE, 403)
  // Validator I2: never overwrite a change made meanwhile (another tab/device) — the bid must be the one we started from.
  const fresh = parseBid(await readJson(store, bidFile.id, BID_FILE_NAME))
  if (!fresh) throw new DriveError('bid.json invalid', 'קובץ bid.json פגום או בגרסה לא נתמכת.')
  if (fresh.updatedAt !== existing.updatedAt && fresh.updatedAt !== session.writtenUpdatedAt) {
    throw new DriveError('bid.json changed meanwhile', BID_CHANGED_MESSAGE, 409)
  }
  await uploadMissing(store, folderId, params.newFiles, session)

  const newUploads = params.newFiles.map((f) => session.uploaded[f.key])
  const files = [...existing.files, ...newUploads]
  const existingParts = params.content.parts
  const bid: Bid = {
    ...existing,
    ...params.content,
    schemaVersion: BID_SCHEMA_VERSION,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: (params.now ?? new Date()).toISOString(),
    parts: resolveParts(existingParts, session),
    files,
    // I3: a bid without an explicit cover never gets a plate picture forced on it as its permanent cover — the cover
    // rule (folder photos first, plate picture last) keeps applying. A newly added photo does become the cover.
    coverFileId:
      (params.coverFromNewFileKey ? session.uploaded[params.coverFromNewFileKey]?.id : undefined) ??
      params.coverFileId ??
      existing.coverFileId ??
      firstImage(newUploads.filter((f) => !isPlatePictureName(f.name))),
  }
  if (!bid.coverFileId) delete bid.coverFileId
  if (bid.archived !== true) delete bid.archivedAt

  await store.updateFileContent(bidFile.id, jsonBlob(bid), JSON_MIME)
  session.writtenUpdatedAt = bid.updatedAt

  const entry = indexEntryFromBid(folderId, bid)
  if (!entry.coverFileId) {
    // Photos the Founder added to the folder later can be the cover (N3).
    entry.coverFileId = pickCover(classifyFolder(await store.listChildren(folderId)).images)
    if (!entry.coverFileId) delete entry.coverFileId
  }
  await upsertIndexEntry(store, modelsFolderId, entry)
  return bid
}

// ---------- Cover & description from the model page (v0.6 E2/E3) ----------

/** The bid.json fields the form controls, taken from a saved bid (nothing recalculated: result + snapshot kept). */
export function bidContentOf(bid: Bid): BidContent {
  return {
    name: bid.name,
    revision: bid.revision,
    description: bid.description,
    material: { ...bid.material },
    parts: bid.parts.map((p) => ({ ...p })),
    laborMinutes: bid.laborMinutes,
    hardware: bid.hardware.map((h) => ({ ...h })),
    hasShipping: bid.hasShipping,
    packaging: bid.packaging.map((l) => ({ ...l })),
    shippingCost: bid.shippingCost,
    settingsSnapshot: { ...bid.settingsSnapshot },
    result: { ...bid.result },
  }
}

export const NOT_A_FOLDER_IMAGE_MESSAGE = 'התמונה הזו אינה נמצאת בתיקיית הדגם.'

function assertNotLegacy(model: ModelFolder): void {
  if (model.bid && model.legacyBid) throw new DriveError('legacy bid.json is read-only', LEGACY_BID_MESSAGE, 403)
}

/**
 * A small change from the model page: applied to the bid.json AS IT IS NOW (read again, not the copy the page shows),
 * changing only that one field — a change made meanwhile in another tab is kept (I2).
 */
async function changeBidField(
  store: DriveStore,
  modelsFolderId: string,
  folderId: string,
  apply: (fresh: Bid) => Pick<UpdateParams, 'content' | 'coverFileId' | 'coverFromNewFileKey' | 'newFiles'>,
  session: SaveSession,
  now?: Date,
): Promise<Bid> {
  const { bid: fresh, legacy } = await loadBid(store, folderId)
  if (legacy) throw new DriveError('legacy bid.json is read-only', LEGACY_BID_MESSAGE, 403)
  return updateBid(store, modelsFolderId, { folderId, existing: fresh, now, ...apply(fresh) }, session)
}

/**
 * After a `_rubedo-model.json` change (`meta` = what was written): the folder's library card shows the chosen cover
 * (AC34) and keeps / gets its archive flag (v0.7).
 */
async function refreshNeedsSlicingEntry(store: DriveStore, modelsFolderId: string, model: ModelFolder, meta: ModelMeta): Promise<void> {
  const contents = classifyFolder(await store.listChildren(model.folder.id))
  await upsertIndexEntry(store, modelsFolderId, needsSlicingEntry(model.folder, contents, metaInfoOf(meta, contents)))
}

/**
 * "קבע כתמונה ראשית": priced (marked) bid → coverFileId in bid.json via updateBid (snapshot kept);
 * folder without bid.json → `_rubedo-model.json`. Both update the library card. A pre-v0.4 bid is read-only.
 */
export async function setModelCover(
  store: DriveStore,
  modelsFolderId: string,
  model: ModelFolder,
  fileId: string,
  now: Date = new Date(),
): Promise<void> {
  assertNotLegacy(model)
  if (!model.contents.images.some((i) => i.id === fileId)) throw new DriveError('not an image of the folder', NOT_A_FOLDER_IMAGE_MESSAGE, 400)
  const folderId = model.folder.id
  if (model.bid) {
    await changeBidField(store, modelsFolderId, folderId, (fresh) => ({ content: bidContentOf(fresh), newFiles: [], coverFileId: fileId }), newSaveSession(), now)
    return
  }
  const meta = await writeModelMeta(store, folderId, { coverFileId: fileId }, now)
  await refreshNeedsSlicingEntry(store, modelsFolderId, model, meta)
}

/**
 * "העלה תמונה חדשה כראשית": uploads the picture INTO the model folder (a new marked file), then sets it as the cover
 * as setModelCover does. Keep `session` between retries: an uploaded picture is not uploaded twice.
 */
export async function uploadModelCover(
  store: DriveStore,
  modelsFolderId: string,
  model: ModelFolder,
  file: LocalFile,
  session: SaveSession,
  now: Date = new Date(),
): Promise<string> {
  assertNotLegacy(model)
  const folderId = model.folder.id
  if (model.bid) {
    const bid = await changeBidField(
      store,
      modelsFolderId,
      folderId,
      (fresh) => ({ content: bidContentOf(fresh), newFiles: [file], coverFromNewFileKey: file.key }),
      session,
      now,
    )
    return bid.coverFileId as string
  }
  // A damaged meta file is reported BEFORE anything is uploaded (it is never replaced, I3).
  await readCurrentModelMeta(store, folderId)
  await uploadMissing(store, folderId, [file], session)
  const coverId = session.uploaded[file.key].id
  const meta = await writeModelMeta(store, folderId, { coverFileId: coverId }, now)
  await refreshNeedsSlicingEntry(store, modelsFolderId, model, meta)
  return coverId
}

/**
 * Inline description edit (E3), max 2000 characters: priced (marked) bid → bid.json via updateBid (snapshot kept);
 * folder without bid.json → `_rubedo-model.json`. A pre-v0.4 bid is read-only.
 */
export async function setModelDescription(
  store: DriveStore,
  modelsFolderId: string,
  model: ModelFolder,
  description: string,
  now: Date = new Date(),
): Promise<void> {
  assertNotLegacy(model)
  const text = description.trim()
  // The 2000-character limit is checked by the writers, only when the description actually changes.
  if (model.bid) {
    await changeBidField(
      store,
      modelsFolderId,
      model.folder.id,
      (fresh) => ({ content: { ...bidContentOf(fresh), description: text }, newFiles: [] }),
      newSaveSession(),
      now,
    )
    return
  }
  await writeModelMeta(store, model.folder.id, { description: text }, now)
}

// ---------- Remove from library = archive (v0.7) ----------

/** Text of the confirm dialog before archiving (A1). */
export const ARCHIVE_CONFIRM_MESSAGE = 'המודל יוסתר מהספרייה. הקבצים נשארים ב-Drive ואפשר לשחזר מהארכיון.'
export const ARCHIVE_LABEL = 'הסר מהספרייה'
export const RESTORE_LABEL = 'שחזר לספרייה'
export const ARCHIVED_BANNER = 'המודל בארכיון'

/**
 * "הסר מהספרייה" / "שחזר לספרייה" (v0.7 A1/A2). Only one app file changes, nothing else in Drive:
 * - marked bid.json → `archived` / `archivedAt` via the stale-safe single-field update (re-read, only that field changes);
 * - folder without bid.json, or with a pre-v0.4 bid.json (never touched) → `<folder>/_rubedo-model.json` (created
 *   marked, or merged after a re-read; a damaged one is refused, never replaced).
 * Then the library index entry is updated. The folder is read again here, so the call works from the library too.
 */
export async function setModelArchived(
  store: DriveStore,
  modelsFolderId: string,
  folderId: string,
  archived: boolean,
  now: Date = new Date(),
): Promise<void> {
  await requireModelFolder(store, modelsFolderId, folderId)
  const model = await loadModelFolder(store, folderId)
  const fields = archived ? { archived: true, archivedAt: now.toISOString() } : { archived: false, archivedAt: undefined }
  if (model.bid && !model.legacyBid) {
    await changeBidField(
      store,
      modelsFolderId,
      folderId,
      (fresh) => ({ content: { ...bidContentOf(fresh), ...fields }, newFiles: [] }),
      newSaveSession(),
      now,
    )
    return
  }
  const meta = await writeModelMeta(store, folderId, fields, now)
  if (!model.bid) {
    await refreshNeedsSlicingEntry(store, modelsFolderId, model, meta)
    return
  }
  // Pre-v0.4 bid: same card as before, with the new flag.
  const contents = classifyFolder(await store.listChildren(folderId))
  const entry = indexEntryFromBid(folderId, model.bid)
  entry.coverFileId = pickCover(contents.images, model.bid.coverFileId)
  if (!entry.coverFileId) delete entry.coverFileId
  entry.archived = meta.archived === true
  await upsertIndexEntry(store, modelsFolderId, entry)
}
