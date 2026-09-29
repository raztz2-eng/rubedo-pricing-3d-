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

export const POPUP_BLOCKED_MESSAGE = "החלון הקופץ נחסם — לחצו שוב על 'התחברות עם Google'."
export const POPUP_CLOSED_MESSAGE = "חלון ההתחברות נסגר לפני שהסתיים — לחצו שוב על 'התחברות עם Google'."
export const AUTH_FAILED_MESSAGE = 'ההתחברות ל-Google נכשלה. נסו שוב.'

export function gisErrorMessage(type: string): string {
  if (type === 'popup_failed_to_open') return POPUP_BLOCKED_MESSAGE
  if (type === 'popup_closed') return POPUP_CLOSED_MESSAGE
  return AUTH_FAILED_MESSAGE
}

export class GoogleAuth {
  private readonly clientId: string
  private client: GoogleTokenClient | null = null
  private clientLoading: Promise<GoogleTokenClient> | null = null
  private token: string | null = null
  private expiresAt = 0
  private hadToken = false
  /** One shared in-flight token request: parallel callers all wait on it (never cancelled). */
  private inflight: Promise<string> | null = null
  private settle: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null
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

  /**
   * Preloads the GIS script and creates the token client. Call at app start so that a later
   * sign-in click can open the popup synchronously (mobile Safari blocks popups opened after an await).
   */
  init(): Promise<GoogleTokenClient> {
    if (this.client) return Promise.resolve(this.client)
    this.clientLoading ??= this.loadClient().catch((e: unknown) => {
      this.clientLoading = null
      throw e
    })
    return this.clientLoading
  }

  /** Interactive sign-in. Call directly from a click handler (no await before it). */
  signIn(): Promise<void> {
    return this.request().then(() => undefined)
  }

  /** Returns a valid access token, requesting a new one if it expired. Parallel calls share one request. */
  getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - EXPIRY_MARGIN_MS) return Promise.resolve(this.token)
    if (!this.hadToken) return Promise.reject(new AuthError('not signed in', 'יש להתחבר עם Google תחילה.'))
    return this.renew()
  }

  /** Forces a new token (e.g. after a 401). */
  refresh(): Promise<string> {
    if (!this.hadToken) return Promise.reject(new AuthError('not signed in', 'יש להתחבר עם Google תחילה.'))
    this.token = null
    return this.renew()
  }

  signOut(): void {
    const t = this.token
    this.clearToken()
    if (t) window.google?.accounts?.oauth2.revoke(t)
    this.emit()
  }

  /** Renewal of an existing session; on failure the session ends so the header offers sign-in again. */
  private renew(): Promise<string> {
    return this.request().catch((e: unknown) => {
      const wasSignedIn = this.signedIn || this.hadToken
      this.clearToken()
      if (wasSignedIn) this.emit()
      throw e
    })
  }

  private clearToken(): void {
    this.token = null
    this.expiresAt = 0
    this.hadToken = false
  }

  private async loadClient(): Promise<GoogleTokenClient> {
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
      error_callback: (err) => this.finish(new AuthError(`gis error: ${err.type}`, gisErrorMessage(err.type))),
    })
    return this.client
  }

  /**
   * Starts (or joins) the single token request. If the client is ready, requestAccessToken is called
   * synchronously — inside the caller's click handler.
   */
  private request(): Promise<string> {
    if (this.inflight) return this.inflight
    const p = new Promise<string>((resolve, reject) => {
      this.settle = { resolve, reject }
    })
    this.inflight = p
    const fire = (client: GoogleTokenClient) => {
      try {
        client.requestAccessToken({ prompt: '' })
      } catch (e) {
        this.finish(new AuthError(`requestAccessToken threw: ${String(e)}`, AUTH_FAILED_MESSAGE))
      }
    }
    if (this.client) fire(this.client)
    else
      this.init().then(fire, (e: unknown) =>
        this.finish(e instanceof Error ? e : new AuthError(String(e), AUTH_FAILED_MESSAGE)),
      )
    return p
  }

  private finish(result: Error | string): void {
    const s = this.settle
    this.settle = null
    this.inflight = null
    if (!s) return
    if (typeof result === 'string') s.resolve(result)
    else s.reject(result)
  }

  private onToken(resp: GoogleTokenResponse): void {
    if (resp.error || !resp.access_token) {
      this.finish(new AuthError(`token error: ${resp.error}`, AUTH_FAILED_MESSAGE))
      return
    }
    // The user may untick the Drive permission on the consent screen — then we cannot work.
    const scopes = (resp.scope ?? DRIVE_SCOPE).split(' ')
    if (!scopes.includes(DRIVE_SCOPE)) {
      this.finish(new AuthError('scope not granted', 'יש לאשר גישה לקבצים שהאפליקציה יוצרת ב-Drive.'))
      return
    }
    this.token = resp.access_token
    this.expiresAt = Date.now() + Number(resp.expires_in ?? 3600) * 1000
    this.hadToken = true
    this.emit()
    this.finish(resp.access_token)
  }

  private emit(): void {
    for (const l of this.listeners) l(this.signedIn)
  }
}
