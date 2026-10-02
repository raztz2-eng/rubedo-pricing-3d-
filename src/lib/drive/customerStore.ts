import { CUSTOMERS_FILE_NAME, FOLDER_MIME, newId } from '../bid'
import {
  findByEmail,
  mergeCustomerLists,
  parseCustomers,
  withAddedCustomer,
  withHiddenFlag,
  withUpdatedCustomer,
  type Customer,
  type CustomerInput,
} from '../customers'
import { preferAppFile } from './folderContents'
import { InvalidJsonError, JSON_MIME, jsonBlob, readJson } from './jsonFiles'
import { DriveError, type DriveFile, type DriveStore } from './types'

/**
 * `<models folder>/_rubedo-customers.json` (brief v0.6 E4). App-owned: created with the marker; only a marked file
 * is ever rewritten. Nothing is ever removed from it, and no file is ever removed.
 *
 * Lost updates are prevented three ways (I1):
 *  a) all changes of one models folder run one after another (module-level promise chain);
 *  b) right before rewriting, the file's revision is read again — if it changed since it was read, the change is
 *     re-applied to the new content and tried again (3 attempts, then a Hebrew error);
 *  c) if several marked files of that name exist, they are read as ONE list (merged by id, newer updatedAt wins) and
 *     the merged list is written to the oldest one, so a duplicate file can never hide customers.
 */

export const INVALID_CUSTOMERS_MESSAGE = `הקובץ ${CUSTOMERS_FILE_NAME} פגום — רשימת הלקוחות לא נטענה ולא שונתה.`
export const CUSTOMERS_BUSY_MESSAGE = 'רשימת הלקוחות שונתה בו-זמנית במקום אחר ולא ניתן היה לשמור. נסו שוב.'
export const MAX_SAVE_ATTEMPTS = 3

interface CustomersState {
  list: Customer[]
  /** The file a change is written to (the oldest marked one); undefined → a new marked file is created. */
  target?: DriveFile
}

function revision(f: Pick<DriveFile, 'modifiedTime' | 'version'>): string {
  return `${f.modifiedTime ?? ''}|${f.version ?? ''}`
}

async function readList(store: DriveStore, file: DriveFile): Promise<Customer[]> {
  let raw: unknown
  try {
    raw = await readJson(store, file.id, CUSTOMERS_FILE_NAME)
  } catch (e) {
    if (e instanceof InvalidJsonError) throw new DriveError(`${CUSTOMERS_FILE_NAME} invalid`, INVALID_CUSTOMERS_MESSAGE)
    throw e
  }
  const list = parseCustomers(raw)
  if (!list) throw new DriveError(`${CUSTOMERS_FILE_NAME} invalid`, INVALID_CUSTOMERS_MESSAGE)
  return list
}

async function readState(store: DriveStore, modelsFolderId: string): Promise<CustomersState> {
  const files = (await store.listChildren(modelsFolderId, { name: CUSTOMERS_FILE_NAME })).filter((f) => f.mimeType !== FOLDER_MIME)
  // Listing order is creation order: the first marked file is the oldest.
  const marked = files.filter((f) => f.appCreated === true)
  if (marked.length > 0) {
    const lists = []
    for (const f of marked) lists.push(await readList(store, f))
    // The revision of the target is the one seen BEFORE its content was read.
    return { list: mergeCustomerLists(lists), target: marked[0] }
  }
  // Only a file the app did not create: read it, never rewrite it (a change creates a new marked file).
  const foreign = preferAppFile(files)
  return { list: foreign ? await readList(store, foreign) : [] }
}

/** The customers list; [] when no file exists yet. A damaged file is an error (never treated as empty). */
export async function loadCustomers(store: DriveStore, modelsFolderId: string): Promise<Customer[]> {
  return (await readState(store, modelsFolderId)).list
}

// ---------- serialised changes ----------

const chains = new Map<string, Promise<unknown>>()

/** Runs `fn` after every earlier change of the same models folder has finished (I1a). */
function serialised<T>(modelsFolderId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(modelsFolderId) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  // One settled promise per models folder stays in the map — nothing to clean up.
  chains.set(modelsFolderId, run.catch(() => undefined))
  return run
}

/**
 * Applies `change` to the current list and saves it. `change` returns the new list, or null when nothing needs to be
 * written. A concurrent change seen right before writing → read again, re-apply, retry (I1b).
 */
async function mutate<R>(
  store: DriveStore,
  modelsFolderId: string,
  change: (list: Customer[]) => { list: Customer[] | null; result: R },
): Promise<R> {
  return serialised(modelsFolderId, async () => {
    for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
      const before = await readState(store, modelsFolderId)
      const seen = before.target ? revision(before.target) : null
      const { list, result } = change(before.list)
      if (list === null) return result
      if (!before.target) {
        await store.uploadFile(modelsFolderId, CUSTOMERS_FILE_NAME, jsonBlob(list), JSON_MIME)
        return result
      }
      const now = await store.getFile(before.target.id)
      if (revision(now) !== seen) continue
      await store.updateFileContent(before.target.id, jsonBlob(list), JSON_MIME)
      return result
    }
    throw new DriveError('customers file kept changing', CUSTOMERS_BUSY_MESSAGE, 409)
  })
}

export async function addCustomer(
  store: DriveStore,
  modelsFolderId: string,
  input: CustomerInput,
  now: Date = new Date(),
): Promise<{ customer: Customer; list: Customer[] }> {
  const id = newId()
  return mutate(store, modelsFolderId, (current) => {
    const r = withAddedCustomer(current, input, id, now)
    return { list: r.list, result: r }
  })
}

export async function updateCustomer(
  store: DriveStore,
  modelsFolderId: string,
  id: string,
  input: CustomerInput,
  now: Date = new Date(),
): Promise<{ customer: Customer; list: Customer[] }> {
  return mutate(store, modelsFolderId, (current) => {
    const r = withUpdatedCustomer(current, id, input, now)
    return { list: r.list, result: r }
  })
}

export async function setCustomerHidden(
  store: DriveStore,
  modelsFolderId: string,
  id: string,
  hidden: boolean,
  now: Date = new Date(),
): Promise<{ customer: Customer; list: Customer[] }> {
  return mutate(store, modelsFolderId, (current) => {
    const r = withHiddenFlag(current, id, hidden, now)
    return { list: r.list, result: r }
  })
}

export interface QuoteCustomerResult {
  customer: Customer
  /** A new customer was added to the list. */
  created: boolean
  /** The e-mail was already stored under another name: the stored name is kept. */
  storedNameDiffers: boolean
  /** The e-mail belongs to a hidden customer (kept hidden; the Founder is told). */
  hidden: boolean
}

/**
 * After a successful quote draft (never before): makes sure the customer is in the list. An existing e-mail is
 * left as it is (stored name kept — no write); a new one is added, with `preferredId` (the id already written in
 * the quote log) when given.
 */
export async function ensureQuoteCustomer(
  store: DriveStore,
  modelsFolderId: string,
  input: { name: string; email: string },
  preferredId?: string,
  now: Date = new Date(),
): Promise<QuoteCustomerResult> {
  const fallbackId = newId()
  return mutate<QuoteCustomerResult>(store, modelsFolderId, (list) => {
    const existing = findByEmail(list, input.email)
    if (existing) {
      return {
        list: null,
        result: { customer: existing, created: false, storedNameDiffers: existing.name.trim() !== input.name.trim(), hidden: existing.hidden === true },
      }
    }
    const id = preferredId && !list.some((c) => c.id === preferredId) ? preferredId : fallbackId
    const r = withAddedCustomer(list, input, id, now)
    return { list: r.list, result: { customer: r.customer, created: true, storedNameDiffers: false, hidden: false } }
  })
}
