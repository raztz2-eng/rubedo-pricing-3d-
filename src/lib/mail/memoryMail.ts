import { GMAIL_API_DISABLED_MESSAGE, GMAIL_PERMISSION_MESSAGE, MailError, type DraftResult, type MailStore } from './types'

export interface MemoryDraft {
  id: string
  /** The raw MIME message exactly as the app built it. */
  raw: string
}

/**
 * In-memory MailStore — used by tests and the `?demo=1` mode. No network.
 * `failNext(kind)` makes the next createDraft throw:
 *  - `network` (default): unclear outcome, like a 503 / dropped connection (a real draft MAY exist);
 *  - `rejected`: Gmail refused (4xx) — no draft;
 *  - `permission`: gmail.compose missing; `api-disabled`: Gmail API not enabled in the Cloud project.
 */
export type MemoryMailFailure = 'network' | 'rejected' | 'permission' | 'api-disabled'

export class MemoryMail implements MailStore {
  readonly drafts: MemoryDraft[] = []
  private seq = 0
  private failures: MemoryMailFailure[] = []

  failNext(kind: MemoryMailFailure = 'network'): void {
    this.failures.push(kind)
  }

  async createDraft(mimeMessage: string): Promise<DraftResult> {
    const failure = this.failures.shift()
    if (failure === 'permission') throw new MailError('simulated: scope missing', GMAIL_PERMISSION_MESSAGE, { status: 403, needsPermission: true })
    if (failure === 'api-disabled') throw new MailError('simulated: API disabled', GMAIL_API_DISABLED_MESSAGE, { status: 403 })
    if (failure === 'rejected') throw new MailError('simulated: 400', 'Gmail דחה את הבקשה והטיוטה לא נוצרה.', { status: 400 })
    if (failure === 'network') throw new MailError('simulated failure: createDraft', 'שגיאת רשת (מדומה).', { status: 503, outcome: 'unknown' })
    this.seq += 1
    const draft: MemoryDraft = { id: `draft-${this.seq}`, raw: mimeMessage }
    this.drafts.push(draft)
    return { draftId: draft.id, messageId: `msg-${this.seq}` }
  }
}
