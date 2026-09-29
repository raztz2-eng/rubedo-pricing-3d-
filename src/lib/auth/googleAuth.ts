import { DRIVE_SCOPE } from '../config'
import { GIS_SRC, loadScript } from '../google/loadScript'

/**
 * Google Identity Services token client. Scope: drive.file ONLY.
 * The access token lives in this object's memory only — never in localStorage/sessionStorage/cookies.
 */

export class AuthError extends Error {
  readonly userMessage: string
  constructor(message: string, userMessage: string) {
    super(message)
    this.name = 'AuthError'
    this.userMessage = userMessage
  }
}

type Listener = (signedIn: boolean) => void

const EXPIRY_MARGIN_MS = 60_000

export class GoogleAuth {
  private readonly clientId: string
  private client: GoogleTokenClient | null = null
  private token: string | null = null
  private expiresAt = 0
  private hadToken = false
  private waiting: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null
  private listeners = new Set<Listener>()

  constructor(clientId: string) {
    this.clientId = clientId
  }

  get signedIn(): boolean {
    return this.token !== null
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Interactive sign-in (call from a click handler so the popup is allowed). */
  async signIn(): Promise<void> {
    await this.request('')
  }

  /** Returns a valid access token, silently requesting a new one if it expired. */
  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - EXPIRY_MARGIN_MS) return this.token
    if (!this.hadToken) throw new AuthError('not signed in', 'יש להתחבר עם Google תחילה.')
    return this.request('')
  }

  /** Forces a new token (e.g. after a 401). */
  async refresh(): Promise<string> {
    this.token = null
    return this.request('')
  }

  signOut(): void {
    const t = this.token
    this.token = null
    this.expiresAt = 0
    this.hadToken = false
    if (t) window.google?.accounts?.oauth2.revoke(t)
    this.emit()
  }

  private async ensureClient(): Promise<GoogleTokenClient> {
    if (this.client) return this.client
    try {
      await loadScript(GIS_SRC)
    } catch {
      throw new AuthError('gis load failed', 'לא ניתן לטעון את שירות ההתחברות של Google. בדקו את החיבור לאינטרנט.')
    }
    const oauth2 = window.google?.accounts?.oauth2
    if (!oauth2) throw new AuthError('gis missing', 'שירות ההתחברות של Google לא זמין.')
    this.client = oauth2.initTokenClient({
      client_id: this.clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => this.onToken(resp),
      error_callback: (err) => {
        const w = this.waiting
        this.waiting = null
        w?.reject(
          new AuthError(
            `gis error: ${err.type}`,
            err.type === 'popup_closed' ? 'חלון ההתחברות נסגר לפני שהסתיים.' : 'ההתחברות ל-Google נכשלה. נסו שוב.',
          ),
        )
      },
    })
    return this.client
  }

  private async request(prompt: string): Promise<string> {
    const client = await this.ensureClient()
    if (this.waiting) this.waiting.reject(new AuthError('superseded', 'בקשת התחברות קודמת בוטלה.'))
    return new Promise<string>((resolve, reject) => {
      this.waiting = { resolve, reject }
      client.requestAccessToken({ prompt })
    })
  }

  private onToken(resp: GoogleTokenResponse): void {
    const w = this.waiting
    this.waiting = null
    if (resp.error || !resp.access_token) {
      w?.reject(new AuthError(`token error: ${resp.error}`, 'ההתחברות ל-Google נכשלה. נסו שוב.'))
      return
    }
    // The user may untick the Drive permission on the consent screen — then we cannot work.
    const scopes = (resp.scope ?? DRIVE_SCOPE).split(' ')
    if (!scopes.includes(DRIVE_SCOPE)) {
      w?.reject(new AuthError('scope not granted', 'יש לאשר גישה לקבצים שהאפליקציה יוצרת ב-Drive.'))
      return
    }
    this.token = resp.access_token
    this.expiresAt = Date.now() + Number(resp.expires_in ?? 3600) * 1000
    this.hadToken = true
    this.emit()
    w?.resolve(resp.access_token)
  }

  private emit(): void {
    for (const l of this.listeners) l(this.signedIn)
  }
}
