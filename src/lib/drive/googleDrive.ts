import { FOLDER_MIME } from '../bid'
import { DriveError, NOT_APP_FILE_MESSAGE, type DriveFile, type DriveStore, type ListOptions } from './types'

/**
 * DriveStore backed by Google Drive REST v3 (plain fetch). Scopes: drive.file + drive.readonly.
 * Reads anything; never deletes or moves anything; updates only touch files the app created
 * (bid.json / index / settings) — checked via `isAppAuthorized` before every update (AC17).
 */

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,thumbnailLink,isAppAuthorized'

export interface TokenProvider {
  getToken(): Promise<string>
  /** Called once after a 401 to obtain a fresh token. */
  refresh(): Promise<string>
}

/** Escapes a value for use inside single quotes in a Drive `q` expression. */
export function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

interface RawFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  thumbnailLink?: string
  isAppAuthorized?: boolean
}

function toDriveFile(raw: RawFile): DriveFile {
  const f: DriveFile = { id: raw.id, name: raw.name, mimeType: raw.mimeType }
  if (raw.modifiedTime) f.modifiedTime = raw.modifiedTime
  if (raw.thumbnailLink) f.thumbnailLink = raw.thumbnailLink
  if (typeof raw.isAppAuthorized === 'boolean') f.appCreated = raw.isAppAuthorized
  return f
}

/** Only Google-hosted thumbnail URLs get the bearer token. */
export function isGoogleThumbnailUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (u.hostname.endsWith('.googleusercontent.com') || u.hostname.endsWith('.google.com'))
  } catch {
    return false
  }
}

export function buildListQuery(folderId: string, options: ListOptions = {}): string {
  const parts = [`'${escapeQueryValue(folderId)}' in parents`, 'trashed = false']
  if (options.name !== undefined) parts.push(`name = '${escapeQueryValue(options.name)}'`)
  if (options.foldersOnly) parts.push(`mimeType = '${FOLDER_MIME}'`)
  return parts.join(' and ')
}

function userMessageFor(status: number): string {
  if (status === 401) return 'פג תוקף ההתחברות ל-Google. התחברו מחדש ונסו שוב.'
  if (status === 403) return 'אין הרשאה לפעולה הזו ב-Drive (ייתכן שחרגתם ממכסה או שהתיקייה לא נבחרה דרך האפליקציה).'
  if (status === 404) return 'הקובץ או התיקייה לא נמצאו ב-Drive. ייתכן שיש לבחור שוב את תיקיית הדגמים בהגדרות.'
  if (status === 429 || status >= 500) return 'Google Drive לא זמין כרגע. נסו שוב בעוד רגע.'
  return 'הפעולה מול Google Drive נכשלה. נסו שוב.'
}

export class GoogleDriveStore implements DriveStore {
  private readonly tokens: TokenProvider
  private readonly fetchImpl: typeof fetch

  constructor(tokens: TokenProvider, fetchImpl: typeof fetch = (...args) => fetch(...args)) {
    this.tokens = tokens
    this.fetchImpl = fetchImpl
  }

  async listChildren(folderId: string, options: ListOptions = {}): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({
        q: buildListQuery(folderId, options),
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: '1000',
        orderBy: 'createdTime',
        spaces: 'drive',
      })
      if (pageToken) params.set('pageToken', pageToken)
      const res = await this.request(`${API}/files?${params}`, { method: 'GET' })
      const body = (await res.json()) as { files?: RawFile[]; nextPageToken?: string }
      out.push(...(body.files ?? []).map(toDriveFile))
      pageToken = body.nextPageToken
    } while (pageToken)
    return out
  }

  async createFolder(parentId: string, name: string): Promise<DriveFile> {
    const res = await this.request(`${API}/files?fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    })
    return toDriveFile((await res.json()) as RawFile)
  }

  async uploadFile(parentId: string, name: string, data: Blob, mimeType: string): Promise<DriveFile> {
    const boundary = `rubedo-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    const metadata = { name, mimeType, parents: [parentId] }
    const body = new Blob(
      [
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        JSON.stringify(metadata),
        `\r\n--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`,
        data,
        `\r\n--${boundary}--`,
      ],
      { type: `multipart/related; boundary=${boundary}` },
    )
    const res = await this.request(`${UPLOAD_API}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })
    return toDriveFile((await res.json()) as RawFile)
  }

  async getFile(fileId: string): Promise<DriveFile> {
    const res = await this.request(`${API}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`, { method: 'GET' })
    return toDriveFile((await res.json()) as RawFile)
  }

  async updateFileContent(fileId: string, data: Blob, mimeType: string): Promise<void> {
    // Guard (AC17): never modify a file the app did not create, even if Google would allow it.
    const meta = await this.getFile(fileId)
    if (meta.appCreated !== true) {
      throw new DriveError(`refused: ${fileId} was not created by the app`, NOT_APP_FILE_MESSAGE, 403)
    }
    await this.request(`${UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': mimeType },
      body: data,
    })
  }

  async readText(fileId: string): Promise<string> {
    const res = await this.request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, { method: 'GET' })
    return res.text()
  }

  async readBlob(fileId: string): Promise<Blob> {
    const res = await this.request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, { method: 'GET' })
    return res.blob()
  }

  /**
   * Thumbnails live on googleusercontent.com and may need the bearer token for private files.
   * Deliberately NOT the 401→refresh path: a failing preview must never push the session into "reconnect";
   * the caller falls back to downloading the file (images.ts).
   */
  async readThumbnail(thumbnailLink: string): Promise<Blob> {
    if (!isGoogleThumbnailUrl(thumbnailLink)) {
      throw new DriveError(`unexpected thumbnail host: ${thumbnailLink}`, 'התמונה לא נטענה.')
    }
    const token = await this.tokens.getToken()
    let res: Response
    try {
      res = await this.fetchImpl(thumbnailLink, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
    } catch (e) {
      throw new DriveError(`thumbnail network error: ${String(e)}`, 'התמונה לא נטענה.')
    }
    if (!res.ok) throw new DriveError(`thumbnail ${res.status}`, 'התמונה לא נטענה.', res.status)
    return res.blob()
  }

  folderUrl(folderId: string): string {
    return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`
  }

  fileUrl(fileId: string): string {
    return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`
  }

  private async request(url: string, init: RequestInit, retried = false): Promise<Response> {
    const token = retried ? await this.tokens.refresh() : await this.tokens.getToken()
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      })
    } catch (e) {
      throw new DriveError(`network error: ${String(e)}`, 'אין חיבור ל-Google Drive. בדקו את החיבור לאינטרנט ונסו שוב.')
    }
    if (res.status === 401 && !retried) return this.request(url, init, true)
    if (!res.ok) {
      let detail = ''
      try {
        detail = await res.text()
      } catch {
        /* ignore body read errors; status is enough */
      }
      throw new DriveError(`Drive ${init.method ?? 'GET'} ${res.status}: ${detail.slice(0, 300)}`, userMessageFor(res.status), res.status)
    }
    return res
  }
}
