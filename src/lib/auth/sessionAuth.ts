import type { TokenProvider } from '../drive/googleDrive'

/**
 * Session client for the backend auth (brief v0.4 D-G / "Front-end changes").
 *  - First sign-in (signed out) = full-page navigation to /api/auth/login (no popup → works on mobile Safari).
 *  - Reconnect while working = a popup to /api/auth/login?popup=1, opened synchronously in the click, so the page
 *    and its unsaved form stay mounted (I4). The tab then retries on window focus or the "המשך" button.
 *  - Access tokens come from POST /api/auth/token (the session lives in an HttpOnly cookie JS cannot read).
 *  - The access token is kept in this object's memory only — never in localStorage/sessionStorage/cookies.
 *  - One shared in-flight token request; renewed ≈5 min before expiry.
 *  - Session gone (401) while working → "needs reconnect": pages stay mounted, a banner offers reconnect.
 */

export const LOGIN_URL = '/api/auth/login'
export const POPUP_LOGIN_URL = '/api/auth/login?popup=1'
export const TOKEN_URL = '/api/auth/token'
export const LOGOUT_URL = '/api/auth/logout'

/** Renew this long before the token expires. */
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000

export const RECONNECT_MESSAGE = "החיבור ל-Google פג — לחצו 'התחבר מחדש' כדי להמשיך."
export const NOT_SIGNED_IN_MESSAGE = 'יש להתחבר עם Google תחילה.'
export const SERVER_UNAVAILABLE_MESSAGE = 'שרת ההתחברות לא זמין כרגע. בדקו את החיבור לאינטרנט ונסו שוב.'
export const SIGNED_OUT_MESSAGE = 'התנתקת.'
export const POPUP_BLOCKED_MESSAGE = 'הדפדפן חסם את חלון ההתחברות. אפשרו חלונות קופצים לאתר הזה ולחצו שוב על „התחבר מחדש”.'

export class AuthError extends Error {
  readonly userMessage: string
  constructor(message: string, userMessage: string) {
    super(message)
    this.name = 'AuthError'
    this.userMessage = userMessage
  }
}

/** /api/auth/token answered 401: there is no usable session cookie any more. */
export class SessionGoneError extends AuthError {
  constructor(userMessage: string) {
    super('no session', userMessage)
    this.name = 'SessionGoneError'
  }
}

type Listener = (signedIn: boolean) => void
type State = 'checking' | 'signed-out' | 'signed-in' | 'reconnect'

interface TokenBody {
  access_token?: string
  expires_in?: number
  email?: string
  /** Granted OAuth scopes (v0.5 Q5). Absent from older backends → unknown (null). */
  scopes?: unknown
  message?: string
}

export interface SessionAuthOptions {
  fetchImpl?: typeof fetch
  /** Full-page navigation (window.location.assign). Injected in tests. */
  navigate?: (url: string) => void
  /** Opens the reconnect popup (window.open); returns null when blocked. Injected in tests. */
  openWindow?: (url: string) => unknown
  now?: () => number
  log?: (context: string, e: unknown) => void
}

export class SessionAuth implements TokenProvider {
  private readonly fetchImpl: typeof fetch
  private readonly navigate: (url: string) => void
  private readonly openWindow: (url: string) => unknown
  private readonly now: () => number
  private readonly log: (context: string, e: unknown) => void
  private state: State = 'checking'
  private token: string | null = null
  private expiresAt = 0
  private accountEmail: string | null = null
  private grantedScopes: readonly string[] | null = null
  private error: string | null = null
  /** One shared in-flight token request: parallel callers all wait on it. */
  private inflight: Promise<string> | null = null
  /** Bumped on sign-out: a request started before it can no longer sign the user in. */
  private generation = 0
  private listeners = new Set<Listener>()

  constructor(options: SessionAuthOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
    this.navigate = options.navigate ?? ((url) => window.location.assign(url))
    this.openWindow = options.openWindow ?? ((url) => window.open(url, 'rubedo-login', 'popup,width=500,height=650'))
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? ((c, e) => console.error(`[rubedo] ${c}`, e))
  }

  get signedIn(): boolean {
    return this.state === 'signed-in'
  }

  get needsReconnect(): boolean {
    return this.state === 'reconnect'
  }

  /** True until the first /api/auth/token answer is in (the UI shows "checking…" instead of a sign-in button). */
  get checking(): boolean {
    return this.state === 'checking'
  }

  get email(): string | null {
    return this.accountEmail
  }

  /** Scopes granted to the current session (from /api/auth/token); null = not known. */
  get scopes(): readonly string[] | null {
    return this.grantedScopes
  }

  /**
   * After the extra-permission popup (v0.5 Q5): ask the backend for a new token so the new scopes are known.
   * Works while signed in (the popup replaced the session cookie) and while "needs reconnect".
   */
  async recheck(): Promise<void> {
    if (this.state === 'reconnect') {
      await this.fetchToken()
      return
    }
    await this.refresh()
  }

  /** Last start-up/renewal problem that is not "signed out" (plain Hebrew), for the header. */
  get lastError(): string | null {
    return this.error
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** App start: a valid session cookie signs the user in silently, with no click (AC18). */
  async init(): Promise<void> {
    try {
      await this.fetchToken()
    } catch (e) {
      if (!(e instanceof AuthError)) this.log('session check', e)
    }
    if (this.state === 'checking') this.setState('signed-out')
  }

  /**
   * Sign-in click. Call it first thing in the click handler (no await before it):
   *  - signed out → full-page navigation to Google;
   *  - "needs reconnect" → the popup is opened synchronously (the page and its form stay mounted).
   */
  signIn(): Promise<void> {
    if (this.state === 'reconnect') {
      this.reconnect()
      return Promise.resolve()
    }
    this.navigate(LOGIN_URL)
    return Promise.resolve()
  }

  /** Opens the reconnect popup. Synchronous — must run inside the click. */
  reconnect(): void {
    const w = this.openWindow(POPUP_LOGIN_URL)
    this.error = w ? null : POPUP_BLOCKED_MESSAGE
    this.emit()
  }

  /**
   * "המשך" button / window focus while disconnected: ask the backend again (the popup may have renewed the
   * session cookie). Success → signed in; still no session → stays "needs reconnect".
   */
  async retry(): Promise<void> {
    if (this.state !== 'reconnect') return
    await this.fetchToken()
  }

  /** A valid access token; renewed ≈5 minutes before expiry. Parallel calls share one request. */
  getToken(): Promise<string> {
    if (this.token && this.now() < this.expiresAt - EXPIRY_MARGIN_MS) return Promise.resolve(this.token)
    return this.refresh()
  }

  /** Forces a new token (e.g. after a Drive 401). */
  refresh(): Promise<string> {
    if (this.state === 'reconnect') return Promise.reject(new AuthError('reconnect needed', RECONNECT_MESSAGE))
    if (this.state === 'signed-out') return Promise.reject(new AuthError('not signed in', NOT_SIGNED_IN_MESSAGE))
    this.token = null
    return this.fetchToken()
  }

  /** Drive still said 401 after a refresh: stop handing out tokens and ask the user to reconnect. */
  onUnauthorized(): void {
    if (this.state !== 'signed-in') return
    this.token = null
    this.expiresAt = 0
    this.setState('reconnect')
  }

  signOut(): void {
    this.generation += 1
    this.inflight = null
    this.token = null
    this.expiresAt = 0
    this.accountEmail = null
    this.grantedScopes = null
    this.error = null
    this.setState('signed-out')
    this.fetchImpl(LOGOUT_URL, { method: 'POST', credentials: 'same-origin' }).catch((e: unknown) => this.log('logout', e))
  }

  private fetchToken(): Promise<string> {
    if (this.inflight) return this.inflight
    const gen = this.generation
    const p = this.requestToken(gen).finally(() => {
      if (this.inflight === p) this.inflight = null
    })
    this.inflight = p
    return p
  }

  private async requestToken(gen: number): Promise<string> {
    let res: Response
    try {
      res = await this.fetchImpl(TOKEN_URL, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } })
    } catch (e) {
      this.log('token request', e)
      return this.fail(gen, new AuthError('token network error', SERVER_UNAVAILABLE_MESSAGE))
    }
    if (gen !== this.generation) throw new AuthError('signed out', SIGNED_OUT_MESSAGE)
    if (res.status === 401) {
      // The session is gone. Working users keep their page ("needs reconnect"); others are simply signed out.
      this.token = null
      this.expiresAt = 0
      this.error = null
      this.setState(this.state === 'signed-in' || this.state === 'reconnect' ? 'reconnect' : 'signed-out')
      throw new SessionGoneError(this.state === 'reconnect' ? RECONNECT_MESSAGE : NOT_SIGNED_IN_MESSAGE)
    }
    let body: TokenBody = {}
    try {
      body = (await res.json()) as TokenBody
    } catch {
      /* handled below */
    }
    // M10: a sign-out may have happened while the body was being read.
    if (gen !== this.generation) throw new AuthError('signed out', SIGNED_OUT_MESSAGE)
    if (!res.ok || !body.access_token) {
      return this.fail(gen, new AuthError(`token endpoint ${res.status}`, body.message || SERVER_UNAVAILABLE_MESSAGE))
    }
    this.token = body.access_token
    this.expiresAt = this.now() + Number(body.expires_in ?? 3600) * 1000
    this.accountEmail = body.email ?? null
    this.grantedScopes = Array.isArray(body.scopes) ? body.scopes.filter((x): x is string => typeof x === 'string') : null
    this.error = null
    this.setState('signed-in')
    return body.access_token
  }

  /** A temporary failure (network / server): never ends a session by itself. */
  private fail(gen: number, e: AuthError): never {
    if (gen === this.generation) {
      this.error = e.userMessage
      this.emit()
    }
    throw e
  }

  private setState(s: State): void {
    this.state = s
    this.emit()
  }

  private emit(): void {
    for (const l of this.listeners) l(this.signedIn)
  }
}
