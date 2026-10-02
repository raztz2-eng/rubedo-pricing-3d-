import { CUSTOMERS_FILE_NAME, newId } from '../bid'
import {
  findByEmail,
  parseCustomers,
  withAddedCustomer,
  withHiddenFlag,
  withUpdatedCustomer,
  type Customer,
  type CustomerInput,
} from '../customers'
import { findFile, readJson, writeJsonFile } from './jsonFiles'
import { DriveError, type DriveStore } from './types'

/**
 * `<models folder>/_rubedo-customers.json` (brief v0.6 E4). App-owned: created with the marker, rewritten only
 * through the marker-guarded path (`writeJsonFile`). Every change re-reads the file first, so a change made in
 * another tab is kept. Nothing is ever removed from it.
 */

export const INVALID_CUSTOMERS_MESSAGE = `הקובץ ${CUSTOMERS_FILE_NAME} פגום — רשימת הלקוחות לא נטענה ולא שונתה.`

/** The customers list; [] when the file does not exist yet. A damaged file is an error (never treated as empty). */
export async function loadCustomers(store: DriveStore, modelsFolderId: string): Promise<Customer[]> {
  const file = await findFile(store, modelsFolderId, CUSTOMERS_FILE_NAME)
  if (!file) return []
  const list = parseCustomers(await readJson(store, file.id, CUSTOMERS_FILE_NAME))
  if (!list) throw new DriveError(`${CUSTOMERS_FILE_NAME} invalid`, INVALID_CUSTOMERS_MESSAGE)
  return list
}

async function save(store: DriveStore, modelsFolderId: string, list: Customer[]): Promise<void> {
  await writeJsonFile(store, modelsFolderId, CUSTOMERS_FILE_NAME, list)
}

export async function addCustomer(
  store: DriveStore,
  modelsFolderId: string,
  input: CustomerInput,
  now: Date = new Date(),
): Promise<{ customer: Customer; list: Customer[] }> {
  const r = withAddedCustomer(await loadCustomers(store, modelsFolderId), input, newId(), now)
  await save(store, modelsFolderId, r.list)
  return r
}

export async function updateCustomer(
  store: DriveStore,
  modelsFolderId: string,
  id: string,
  input: CustomerInput,
  now: Date = new Date(),
): Promise<{ customer: Customer; list: Customer[] }> {
  const r = withUpdatedCustomer(await loadCustomers(store, modelsFolderId), id, input, now)
  await save(store, modelsFolderId, r.list)
  return r
}

export async function setCustomerHidden(
  store: DriveStore,
  modelsFolderId: string,
  id: string,
  hidden: boolean,
  now: Date = new Date(),
): Promise<{ customer: Customer; list: Customer[] }> {
  const r = withHiddenFlag(await loadCustomers(store, modelsFolderId), id, hidden, now)
  await save(store, modelsFolderId, r.list)
  return r
}

export interface QuoteCustomerResult {
  customer: Customer
  /** A new customer was added to the list. */
  created: boolean
  /** The e-mail was already stored under another name: the stored name is kept. */
  storedNameDiffers: boolean
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
  const list = await loadCustomers(store, modelsFolderId)
  const existing = findByEmail(list, input.email)
  if (existing) {
    return { customer: existing, created: false, storedNameDiffers: existing.name.trim() !== input.name.trim() }
  }
  const id = preferredId && !list.some((c) => c.id === preferredId) ? preferredId : newId()
  const r = withAddedCustomer(list, input, id, now)
  await save(store, modelsFolderId, r.list)
  return { customer: r.customer, created: true, storedNameDiffers: false }
}
