import { DRIVE_SCOPE, DRIVE_SCOPES } from '../config'
import { GIS_SRC, loadScript } from '../google/loadScript'

/**
 * Google Identity Services token client. Scopes: exactly drive.file + drive.readonly (brief v0.3 D-A).
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
type GoogleOAuth2 = NonNullable<NonNullable<Window['google']>['accounts']>['oauth2']

const EXPIRY_MARGIN_MS = 60_000

export const POPUP_BLOCKED_MESSAGE = "החלון הקופץ נחסם — לחצו שוב על 'התחברות עם Google'."
export const POPUP_CLOSED_MESSAGE = "חלון ההתחברות נסגר לפני שהסתיים — לחצו שוב על 'התחברות עם Google'."
export const AUTH_FAILED_MESSAGE = 'ההתחברות ל-Google נכשלה. נסו שוב.'
export const RECONNECT_MESSAGE = "החיבור ל-Google פג — לחצו 'התחבר מחדש' כדי להמשיך."
export const SIGNED_OUT_MESSAGE = 'התנתקת.'
export const TIMEOUT_MESSAGE = 'Google לא הגיב לבקשת ההתחברות. לחצו שוב על כפתור ההתחברות.'

/** A token request that never calls back is rejected after this long. */
export const REQUEST_TIMEOUT_MS = 120_000
/** An explicit sign-in click may re-open the popup if the pending request is older than this. */
export const STALE_REQUEST_MS = 10_000

export const SCOPE_MISSING_MESSAGE =
  'יש לאשר את שתי ההרשאות של Drive: צפייה בקבצים ויצירת קבצים של האפליקציה. התחברו שוב וסמנו את שתיהן.'

/** True when the granted scope string includes every required scope (drive.file AND drive.readonly). */
export function hasRequiredScopes(granted: string): boolean {
  const list = granted.split(/\s+/).filter(Boolean)
  return DRIVE_SCOPES.every((s) => list.includes(s))
}

export function gisErrorMessage(type: string): string {
  if (type === 'popup_failed_to_open') return POPUP_BLOCKED_MESSAGE
  if (type === 'popup_closed') return POPUP_CLOSED_MESSAGE
  return AUTH_FAILED_MESSAGE
}

/**
 * States: signed out · signed in (valid token) · needs reconnect (a renewal failed while working).
 * "Needs reconnect" keeps the session alive for the UI (pages stay mounted, form data kept) but no token
 * is handed out until the user clicks "reconnect" (an interactive signIn()).
 */
export class GoogleAuth {
  private readonly clientId: string
  /** GIS oauth2 namespace once the script is loaded (a token client is created per popup attempt). */
  private oauth2: GoogleOAuth2 | null = null
  private loading: Promise<GoogleOAuth2> | null = null
  /** Bumped on sign-out: callbacks from requests of an older generation are ignored. */
  private generation = 0
  /** Id of the latest popup attempt of the pending request; errors from replaced attempts are ignored. */
  private attempt = 0
  private token: string | null = null
  private expiresAt = 0
  private hadToken = false
  private reconnect = false
  /** One shared in-flight token request: parallel callers all wait on it. */
  private inflight: Promise<string> | null = null
  private inflightStartedAt = 0
  private timeoutId: ReturnType<typeof setTimeout> | null = null
  private settle: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null
  private listeners = new Set<Listener>()

  constructor(clientId: string) {
    this.clientId = clientId
  }

  get signedIn(): boolean {
    return this.token !== null
  }

  /** True after a failed renewal: the user must click "reconnect"; the app keeps its pages and data. */
  get needsReconnect(): boolean {
    return this.reconnect
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Preloads the GIS script and creates the token client. Call at app start so that a later
   * sign-in click can open the popup synchronously (mobile Safari blocks popups opened after an await).
   */
  init(): Promise<void> {
    return this.loadGis().then(() => undefined)
  }

  private loadGis(): Promise<GoogleOAuth2> {
    if (this.oauth2) return Promise.resolve(this.oauth2)
    this.loading ??= this.loadOAuth2().catch((e: unknown) => {
      this.loading = null
      throw e
    })
    return this.loading
  }

  /**
   * Interactive sign-in / reconnect. Call directly from a click handler (no await before it).
   * If a request is already pending for more than STALE_REQUEST_MS (e.g. its popup was lost),
   * the popup is opened again; everyone waiting on the old request gets the new token.
   */
  signIn(): Promise<void> {
    if (this.inflight && this.oauth2 && Date.now() - this.inflightStartedAt > STALE_REQUEST_MS) {
      this.fire(this.oauth2)
      return this.inflight.then(() => undefined)
    }
    return this.request().then(() => undefined)
  }

  /** Returns a valid access token, requesting a new one if it expired. Parallel calls share one request. */
  getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - EXPIRY_MARGIN_MS) return Promise.resolve(this.token)
    return this.renew()
  }

  /** Forces a new token (e.g. after a 401). */
  refresh(): Promise<string> {
    this.token = null
    return this.renew()
  }

  signOut(): void {
    // Invalidate any pending request: late callbacks are ignored and waiting callers are rejected.
    this.generation += 1
    this.finish(new AuthError('signed out', SIGNED_OUT_MESSAGE))
    const t = this.token
    this.token = null
    this.expiresAt = 0
    this.hadToken = false
    this.reconnect = false
    if (t) window.google?.accounts?.oauth2.revoke(t)
    this.emit()
  }

  /** Non-interactive renewal of an existing session. On failure → "needs reconnect" (no sign-out). */
  private renew(): Promise<string> {
    if (this.reconnect) return Promise.reject(new AuthError('reconnect needed', RECONNECT_MESSAGE))
    if (!this.hadToken) return Promise.reject(new AuthError('not signed in', 'יש להתחבר עם Google תחילה.'))
    return this.request().catch((e: unknown) => {
      if (this.hadToken && !this.reconnect) {
        this.token = null
        this.expiresAt = 0
        this.reconnect = true
        this.emit()
      }
      throw new AuthError(`renewal failed: ${e instanceof Error ? e.message : String(e)}`, RECONNECT_MESSAGE)
    })
  }

  private async loadOAuth2(): Promise<GoogleOAuth2> {
    try {
      await loadScript(GIS_SRC)
    } catch {
      throw new AuthError('gis load failed', 'לא ניתן לטעון את שירות ההתחברות של Google. בדקו את החיבור לאינטרנט.')
    }
    const oauth2 = window.google?.accounts?.oauth2
    if (!oauth2) throw new AuthError('gis missing', 'שירות ההתחברות של Google לא זמין.')
    this.oauth2 = oauth2
    return oauth2
  }

  /**
   * Starts (or joins) the single token request. If GIS is loaded, requestAccessToken is called
   * synchronously — inside the caller's click handler.
   */
  private request(): Promise<string> {
    if (this.inflight) return this.inflight
    const p = new Promise<string>((resolve, reject) => {
      this.settle = { resolve, reject }
    })
    this.inflight = p
    if (this.oauth2) this.fire(this.oauth2)
    else {
      const gen = this.generation
      this.loadGis().then(
        (o) => {
          if (gen === this.generation && this.inflight === p) this.fire(o)
        },
        (e: unknown) => {
          if (gen === this.generation) this.finish(e instanceof Error ? e : new AuthError(String(e), AUTH_FAILED_MESSAGE))
        },
      )
    }
    return p
  }

  /**
   * One popup attempt for the pending request, with its own token client so its callbacks are tagged.
   * A token from any attempt of the current generation is accepted (it is valid); an ERROR from an attempt
   * that was replaced by a newer one (e.g. the lost first popup reporting popup_closed) is ignored.
   */
  private fire(oauth2: GoogleOAuth2): void {
    const id = ++this.attempt
    const gen = this.generation
    this.inflightStartedAt = Date.now()
    if (this.timeoutId !== null) clearTimeout(this.timeoutId)
    this.timeoutId = setTimeout(() => this.finish(new AuthError('token request timed out', TIMEOUT_MESSAGE)), REQUEST_TIMEOUT_MS)
    try {
      const client = oauth2.initTokenClient({
        client_id: this.clientId,
        scope: DRIVE_SCOPE,
        // Only the scopes requested here — never inherit broader scopes granted to this client earlier.
        include_granted_scopes: false,
        callback: (resp) => {
          if (gen === this.generation) this.onToken(resp)
        },
        error_callback: (err) => {
          if (gen === this.generation && id === this.attempt) {
            this.finish(new AuthError(`gis error: ${err.type}`, gisErrorMessage(err.type)))
          }
        },
      })
      client.requestAccessToken({ prompt: '' })
    } catch (e) {
      this.finish(new AuthError(`requestAccessToken threw: ${String(e)}`, AUTH_FAILED_MESSAGE))
    }
  }

  private finish(result: Error | string): void {
    if (this.timeoutId !== null) clearTimeout(this.timeoutId)
    this.timeoutId = null
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
    // The user may untick a Drive permission on the consent screen — then we cannot work.
    if (!hasRequiredScopes(resp.scope ?? DRIVE_SCOPE)) {
      this.finish(new AuthError('scope not granted', SCOPE_MISSING_MESSAGE))
      return
    }
    this.token = resp.access_token
    this.expiresAt = Date.now() + Number(resp.expires_in ?? 3600) * 1000
    this.hadToken = true
    this.reconnect = false
    this.emit()
    this.finish(resp.access_token)
  }

  private emit(): void {
    for (const l of this.listeners) l(this.signedIn)
  }
}
