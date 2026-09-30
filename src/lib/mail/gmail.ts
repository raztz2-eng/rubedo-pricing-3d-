import type { TokenProvider } from '../drive/googleDrive'
import { GMAIL_PERMISSION_MESSAGE, MailError, type DraftResult, type MailStore } from './types'

/**
 * MailStore backed by the Gmail API (brief v0.5 D-J), plain fetch. Scope: gmail.compose.
 * The ONLY Gmail endpoint used anywhere in the app is drafts.create (media upload of the raw MIME message).
 */
export const GMAIL_DRAFTS_CREATE_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media'

function userMessageFor(status: number): string {
  if (status === 401) return 'פג תוקף ההתחברות ל-Google. התחברו מחדש ונסו שוב.'
  if (status === 400) return 'Gmail דחה את ההודעה (מבנה לא תקין). הטיוטה לא נוצרה.'
  if (status === 413) return 'ההודעה גדולה מדי עבור Gmail. בטלו סימון של חלק מהתמונות ונסו שוב.'
  if (status === 429 || status >= 500) return 'Gmail לא זמין כרגע. נסו שוב בעוד רגע.'
  return 'יצירת הטיוטה ב-Gmail נכשלה. נסו שוב.'
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
      throw new MailError('drafts.create: invalid JSON answer', 'Gmail החזיר תשובה לא צפויה. בדקו בטיוטות אם הטיוטה נוצרה.', res.status)
    }
    if (typeof body.id !== 'string' || body.id === '') {
      throw new MailError('drafts.create: no draft id', 'Gmail החזיר תשובה לא צפויה. בדקו בטיוטות אם הטיוטה נוצרה.', res.status)
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
      throw new MailError(`network error: ${String(e)}`, 'אין חיבור ל-Gmail. בדקו את החיבור לאינטרנט ונסו שוב.')
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
      if (isScopeProblem(res.status, detail)) {
        throw new MailError(`drafts.create 403 (scope): ${detail.slice(0, 200)}`, GMAIL_PERMISSION_MESSAGE, 403, true)
      }
      throw new MailError(`drafts.create ${res.status}: ${detail.slice(0, 300)}`, userMessageFor(res.status), res.status)
    }
    return res
  }
}
