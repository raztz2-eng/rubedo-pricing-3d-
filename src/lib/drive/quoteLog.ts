import { FOLDER_MIME } from '../bid'
import { quoteFileName, type QuoteRecord } from '../quote'
import type { DriveStore } from './types'

/**
 * Quote log (brief v0.5 Q4): `<model folder>/quotes/quote-YYYYMMDD-HHmm.json`, written only AFTER the Gmail draft was
 * created. Creates only: the `quotes` subfolder (first time, app-marked by the store) and a NEW JSON file per quote.
 * An existing file is never rewritten; a second quote in the same minute gets "-2", "-3", ….
 */

export const QUOTES_FOLDER_NAME = 'quotes'
const JSON_MIME = 'application/json'

/** The app's own `quotes` folder of a model folder; created (marked) when missing. A Founder folder of that name is left alone. */
export async function ensureQuotesFolder(store: DriveStore, modelFolderId: string): Promise<string> {
  const found = await store.listChildren(modelFolderId, { name: QUOTES_FOLDER_NAME, foldersOnly: true })
  const own = found.find((f) => f.mimeType === FOLDER_MIME && f.appCreated === true)
  if (own) return own.id
  return (await store.createFolder(modelFolderId, QUOTES_FOLDER_NAME)).id
}

async function freeName(store: DriveStore, folderId: string, base: string): Promise<string> {
  const stem = base.replace(/\.json$/, '')
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${stem}-${n}.json`
    if ((await store.listChildren(folderId, { name })).length === 0) return name
  }
}

export async function writeQuoteLog(
  store: DriveStore,
  modelFolderId: string,
  record: QuoteRecord,
  now: Date = new Date(record.date),
): Promise<{ folderId: string; fileId: string; name: string }> {
  const folderId = await ensureQuotesFolder(store, modelFolderId)
  const name = await freeName(store, folderId, quoteFileName(now))
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: JSON_MIME })
  const file = await store.uploadFile(folderId, name, blob, JSON_MIME)
  return { folderId, fileId: file.id, name }
}
