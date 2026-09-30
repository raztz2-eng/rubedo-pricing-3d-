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

/** I2: the Gmail API is not enabled in the Google Cloud project (a Founder setup step). */
export const GMAIL_API_DISABLED_MESSAGE = 'Gmail API לא מופעל בפרויקט Google Cloud — יש להפעיל אותו ולנסות שוב'

/**
 * Whether a draft may exist after a failure (M1):
 *  - `not-created`: Gmail refused the request (4xx) or it was never sent → safe to retry;
 *  - `unknown`: 5xx, network error, or a 2xx answer we could not read → a draft MAY exist; check Drafts first.
 */
export type DraftOutcome = 'not-created' | 'unknown'

export interface MailErrorOptions {
  status?: number
  /** The session lacks gmail.compose (Q5). */
  needsPermission?: boolean
  /** Default `not-created`. */
  outcome?: DraftOutcome
}

/** Error thrown by a MailStore; `userMessage` is plain Hebrew. */
export class MailError extends Error {
  readonly status?: number
  readonly userMessage: string
  readonly needsPermission: boolean
  readonly outcome: DraftOutcome

  constructor(message: string, userMessage: string, options: MailErrorOptions = {}) {
    super(message)
    this.name = 'MailError'
    this.status = options.status
    this.userMessage = userMessage
    this.needsPermission = options.needsPermission ?? false
    this.outcome = options.outcome ?? 'not-created'
  }
}
