import { FOLDER_MIME } from '../bid'
import { DriveError, type DriveFile, type DriveStore, type ListOptions } from './types'
import { APP_PROPERTIES, assertUpdatable, hasAppMarker } from './writeGuard'

/**
 * DriveStore backed by Google Drive REST v3 (plain fetch). Scope: drive (brief v0.4 D-F).
 * Reads anything. Writes: creates (always with appProperties.rubedo="1") and content updates of marked files only
 * (writeGuard.ts). There is no request that deletes, trashes, moves, renames or changes sharing (AC22).
 */

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,thumbnailLink,parents,appProperties'

export interface TokenProvider {
  getToken(): Promise<string>
  /** Called once after a 401 to obtain a fresh token. */
  refresh(): Promise<string>
  /** Called when Drive still answers 401 after a refresh: the session is unusable → "needs reconnect". */
  onUnauthorized?(): void
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
  parents?: string[]
  appProperties?: Record<string, string>
}

function toDriveFile(raw: RawFile): DriveFile {
  const f: DriveFile = { id: raw.id, name: raw.name, mimeType: raw.mimeType, appCreated: hasAppMarker(raw.appProperties) }
  if (raw.modifiedTime) f.modifiedTime = raw.modifiedTime
  if (raw.thumbnailLink) f.thumbnailLink = raw.thumbnailLink
  if (Array.isArray(raw.parents)) f.parents = raw.parents
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

/** Same-origin thumbnail proxy (brief v0.4). */
export function thumbProxyUrl(fileId: string, size: number): string {
  return `/api/thumb?id=${encodeURIComponent(fileId)}&s=${Math.round(size)}`
}

function userMessageFor(status: number): string {
  if (status === 401) return 'פג תוקף ההתחברות ל-Google. התחברו מחדש ונסו שוב.'
  if (status === 403) return 'אין הרשאה לפעולה הזו ב-Drive (ייתכן שחרגתם ממכסה).'
  if (status === 404) return 'הקובץ או התיקייה לא נמצאו ב-Drive. ייתכן שיש לבחור שוב את תיקיית הדגמים בהגדרות.'
  if (status === 429 || status >= 500) return 'Google Drive לא זמין כרגע. נסו שוב בעוד רגע.'
  return 'הפעולה מול Google Drive נכשלה. נסו שוב.'
}

/** multipart/related body: JSON metadata + content. */
function multipart(metadata: Record<string, unknown>, data: Blob, mimeType: string): { body: Blob; contentType: string } {
  const boundary = `rubedo-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  const contentType = `multipart/related; boundary=${boundary}`
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`,
      data,
      `\r\n--${boundary}--`,
    ],
    { type: contentType },
  )
  return { body, contentType }
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
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId], appProperties: { ...APP_PROPERTIES } }),
    })
    return toDriveFile((await res.json()) as RawFile)
  }

  async uploadFile(parentId: string, name: string, data: Blob, mimeType: string): Promise<DriveFile> {
    const { body, contentType } = multipart({ name, mimeType, parents: [parentId], appProperties: { ...APP_PROPERTIES } }, data, mimeType)
    const res = await this.request(`${UPLOAD_API}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    })
    return toDriveFile((await res.json()) as RawFile)
  }

  async getFile(fileId: string): Promise<DriveFile> {
    const res = await this.request(`${API}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`, { method: 'GET' })
    return toDriveFile((await res.json()) as RawFile)
  }

  /**
   * The ONLY modifying request the app sends. Checked by writeGuard.decideUpdate before anything is sent.
   * The metadata part contains appProperties only — never name/parents (no rename/move).
   */
  async updateFileContent(fileId: string, data: Blob, mimeType: string): Promise<void> {
    assertUpdatable(await this.getFile(fileId))
    const { body, contentType } = multipart({ appProperties: { ...APP_PROPERTIES } }, data, mimeType)
    await this.request(`${UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': contentType },
      body,
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
   * Direct thumbnail download from the browser. Kept for the DriveStore contract; the UI does not use it with
   * this store (googleusercontent.com blocks it by CORS — brief v0.4 C2) and loads `thumbnailUrl()` instead.
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

  thumbnailUrl(fileId: string, size: number): string {
    return thumbProxyUrl(fileId, size)
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
    if (res.status === 401) this.tokens.onUnauthorized?.()
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
