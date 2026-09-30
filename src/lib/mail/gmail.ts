import type { TokenProvider } from '../drive/googleDrive'
import { GMAIL_API_DISABLED_MESSAGE, GMAIL_PERMISSION_MESSAGE, MailError, type DraftResult, type MailStore } from './types'

/**
 * MailStore backed by the Gmail API (brief v0.5 D-J), plain fetch. Scope: gmail.compose.
 * The ONLY Gmail endpoint used anywhere in the app is drafts.create (media upload of the raw MIME message).
 */
export const GMAIL_DRAFTS_CREATE_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media'

function userMessageFor(status: number): string {
  if (status === 401) return 'פג תוקף ההתחברות ל-Google. התחברו מחדש ונסו שוב.'
  if (status === 400) return 'Gmail דחה את ההודעה (מבנה לא תקין). הטיוטה לא נוצרה.'
  if (status === 413) return 'ההודעה גדולה מדי עבור Gmail. בטלו סימון של חלק מהתמונות ונסו שוב.'
  if (status === 429) return 'Gmail עמוס כרגע ולא יצר את הטיוטה. נסו שוב בעוד רגע.'
  if (status >= 500) return 'Gmail לא ענה כמו שצריך.'
  return 'Gmail דחה את הבקשה והטיוטה לא נוצרה.'
}

/** I2: the Gmail API is not enabled in the Cloud project (403 accessNotConfigured / SERVICE_DISABLED). */
export function isApiDisabled(status: number, body: string): boolean {
  if (status !== 403) return false
  return /accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(body)
}

/** A 403 because the token lacks gmail.compose (as opposed to e.g. a quota problem). */
function isScopeProblem(status: number, body: string): boolean {
  if (status !== 403) return false
  return /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT|scope/i.test(body)
}

export class GmailMailStore implements MailStore {
  private readonly tokens: TokenProvider
  private readonly fetchImpl: typeof fetch

  constructor(tokens: TokenProvider, fetchImpl: typeof fetch = (...args) => fetch(...args)) {
    this.tokens = tokens
    this.fetchImpl = fetchImpl
  }

  async createDraft(mimeMessage: string): Promise<DraftResult> {
    const res = await this.post(mimeMessage, false)
    let body: { id?: unknown; message?: { id?: unknown } }
    try {
      body = (await res.json()) as typeof body
    } catch {
      // M1: Gmail said OK — the draft may well exist.
      throw new MailError('drafts.create: invalid JSON answer', 'Gmail החזיר תשובה לא צפויה.', { status: res.status, outcome: 'unknown' })
    }
    if (typeof body.id !== 'string' || body.id === '') {
      throw new MailError('drafts.create: no draft id', 'Gmail החזיר תשובה לא צפויה.', { status: res.status, outcome: 'unknown' })
    }
    const messageId = typeof body.message?.id === 'string' ? body.message.id : undefined
    return { draftId: body.id, ...(messageId ? { messageId } : {}) }
  }

  private async post(mimeMessage: string, retried: boolean): Promise<Response> {
    const token = retried ? await this.tokens.refresh() : await this.tokens.getToken()
    let res: Response
    try {
      res = await this.fetchImpl(GMAIL_DRAFTS_CREATE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'message/rfc822' },
        body: mimeMessage,
      })
    } catch (e) {
      // M1: the request may have reached Gmail before the connection failed.
      throw new MailError(`network error: ${String(e)}`, 'החיבור ל-Gmail נקטע.', { outcome: 'unknown' })
    }
    if (res.status === 401 && !retried) return this.post(mimeMessage, true)
    if (res.status === 401) this.tokens.onUnauthorized?.()
    if (!res.ok) {
      let detail = ''
      try {
        detail = await res.text()
      } catch {
        /* the status is enough */
      }
      // Checked first: a disabled-API answer can also mention scopes or access.
      if (isApiDisabled(res.status, detail)) {
        throw new MailError(`drafts.create 403 (API disabled): ${detail.slice(0, 200)}`, GMAIL_API_DISABLED_MESSAGE, { status: 403 })
      }
      if (isScopeProblem(res.status, detail)) {
        throw new MailError(`drafts.create 403 (scope): ${detail.slice(0, 200)}`, GMAIL_PERMISSION_MESSAGE, { status: 403, needsPermission: true })
      }
      throw new MailError(`drafts.create ${res.status}: ${detail.slice(0, 300)}`, userMessageFor(res.status), {
        status: res.status,
        outcome: res.status >= 500 ? 'unknown' : 'not-created',
      })
    }
    return res
  }
}
