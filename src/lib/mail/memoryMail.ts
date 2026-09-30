import { GMAIL_PERMISSION_MESSAGE, MailError, type DraftResult, type MailStore } from './types'

export interface MemoryDraft {
  id: string
  /** The raw MIME message exactly as the app built it. */
  raw: string
}

/**
 * In-memory MailStore — used by tests and the `?demo=1` mode. No network.
 * `failNext()` makes the next createDraft throw; `failNext('permission')` simulates a missing gmail.compose scope.
 */
export class MemoryMail implements MailStore {
  readonly drafts: MemoryDraft[] = []
  private seq = 0
  private failures: ('network' | 'permission')[] = []

  failNext(kind: 'network' | 'permission' = 'network'): void {
    this.failures.push(kind)
  }

  async createDraft(mimeMessage: string): Promise<DraftResult> {
    const failure = this.failures.shift()
    if (failure === 'permission') throw new MailError('simulated: scope missing', GMAIL_PERMISSION_MESSAGE, 403, true)
    if (failure === 'network') throw new MailError('simulated failure: createDraft', 'שגיאת רשת (מדומה). נסו שוב.', 503)
    this.seq += 1
    const draft: MemoryDraft = { id: `draft-${this.seq}`, raw: mimeMessage }
    this.drafts.push(draft)
    return { draftId: draft.id, messageId: `msg-${this.seq}` }
  }
}
