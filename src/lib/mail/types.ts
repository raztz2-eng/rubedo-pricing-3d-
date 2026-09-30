/**
 * The ONLY way the app talks to e-mail (brief v0.5 D-J). `gmail.ts` implements it against the Gmail API,
 * `memoryMail.ts` in memory for tests and demo mode.
 *
 * Deliberately has exactly one operation: create a DRAFT. The Founder reviews it and presses Send in Gmail himself.
 * The app never sends, reads, changes or removes mail.
 */

/** OAuth scope needed for drafts (v0.5 D-J). Optional for the rest of the app (Q5). */
export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose'

/** Where the Founder finds the draft. */
export const GMAIL_DRAFTS_URL = 'https://mail.google.com/mail/#drafts'

export interface DraftResult {
  /** Gmail draft id. */
  draftId: string
  /** Id of the message inside the draft (when known). */
  messageId?: string
}

export interface MailStore {
  /** Creates a Gmail draft from a complete RFC 5322 / MIME message (CRLF line endings, ASCII only). */
  createDraft(mimeMessage: string): Promise<DraftResult>
}

/** Plain-Hebrew message when the session lacks gmail.compose (v0.5 Q5). */
export const GMAIL_PERMISSION_MESSAGE = 'נדרש אישור נוסף ל-Gmail'

/** Error thrown by a MailStore; `userMessage` is plain Hebrew. `needsPermission`: the Gmail scope is missing. */
export class MailError extends Error {
  readonly status?: number
  readonly userMessage: string
  readonly needsPermission: boolean

  constructor(message: string, userMessage: string, status?: number, needsPermission = false) {
    super(message)
    this.name = 'MailError'
    this.status = status
    this.userMessage = userMessage
    this.needsPermission = needsPermission
  }
}
