/**
 * Acceptance harness for brief Addendum v0.4 (Test Verifier). Two fakes, both driven from the outside:
 *
 *  - GoogleWorld: a scripted Google (OAuth token endpoint, userinfo, revoke, Drive REST v3, thumbnail hosts). It
 *    issues its own codes / refresh tokens / access tokens and checks them like Google would (bearer required for
 *    Drive, refresh tokens can be revoked). Every request it receives is recorded.
 *  - Browser: a cookie jar + the real /api handlers (api/_lib/handlers.ts) with the world injected as their deps.
 *    `spaFetch` is what the SPA's own code gets as `fetch`: same-origin /api calls go through the handlers with the
 *    jar's cookies, and — like a real browser — Set-Cookie is stripped before JS sees the response. Everything JS
 *    could see is recorded in `seenByJs`.
 *
 * v0.5: refresh tokens remember the scopes granted at consent (a refresh answers with them, like Google), access
 * tokens carry their scopes, and a fake Gmail API accepts drafts.create only (403 without gmail.compose).
 *
 * Nothing here is a real credential: all secrets/tokens are generated fake values with an "acceptance" marker.
 */
import { randomBytes } from 'node:crypto'
import {
  handleCallback,
  handleLogin,
  handleLogout,
  handleThumb,
  handleToken,
  type CachedToken,
  type Deps,
} from '../../api/_lib/handlers'

export const ORIGIN = 'https://rubedo-app.test'
export const CLIENT_ID = 'acceptance-client-id.apps.googleusercontent.com'
/** Fake OAuth client secret (deliberately NOT in Google's secret format). */
export const CLIENT_SECRET = `acceptance-fake-client-secret-${randomBytes(6).toString('hex')}`
export const FOUNDER = 'raztz2@gmail.com'
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
export const USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email'
export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose'
/** Gmail drafts.create (media upload form) — the one Gmail call the brief allows (v0.5 D-J). */
export const GMAIL_DRAFTS_CREATE_PATHS = ['/upload/gmail/v1/users/me/drafts', '/gmail/v1/users/me/drafts']
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const SESSION_COOKIE_NAME = 'rubedo_session'
export const APP_MARK = { rubedo: '1' }

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const THUMB_HOST = 'https://lh3.googleusercontent.com'

export interface DriveNode {
  id: string
  name: string
  mimeType: string
  parents: string[]
  appProperties?: Record<string, string>
  content: Uint8Array
  modifiedTime: string
  /** Absolute thumbnailLink Drive would report (null = none). */
  thumbnailLink: string | null
  /** Bytes served at the thumbnail link. */
  thumbnail?: { bytes: Uint8Array; type: string }
}

export interface Recorded {
  method: string
  url: string
  headers: Record<string, string>
  body: string
  /** For PATCH: whether the target carried the app marker BEFORE this request. */
  targetMarkedBefore?: boolean
  /** Parsed multipart/JSON metadata of a Drive write. */
  metadata?: Record<string, unknown>
}

const enc = new TextEncoder()

export function bytes(s: string): Uint8Array {
  return enc.encode(s)
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array()
  if (typeof body === 'string') return enc.encode(body)
  if (body instanceof URLSearchParams) return enc.encode(body.toString())
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  const b = body as { arrayBuffer?: () => Promise<ArrayBuffer>; text?: () => Promise<string> }
  if (typeof b.arrayBuffer === 'function') return new Uint8Array(await b.arrayBuffer())
  if (typeof b.text === 'function') return enc.encode(await b.text())
  return enc.encode(String(body))
}

function latin1(u: Uint8Array): string {
  return Buffer.from(u).toString('latin1')
}

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A media response whose .blob() is the environment's global Blob (jsdom), so JSZip/FileReader accept it. */
function media(content: Uint8Array, type: string): Response {
  const res = new Response(content.slice(), { headers: { 'Content-Type': type } })
  const GlobalBlob = globalThis.Blob
  Object.defineProperty(res, 'blob', { value: async () => new GlobalBlob([content.slice()], { type }) })
  return res
}

function parseMultipart(contentType: string, raw: Uint8Array): { metadata: Record<string, unknown>; content: Uint8Array } {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1]
  if (!boundary) throw new Error(`no multipart boundary in ${contentType}`)
  const text = latin1(raw)
  const parts = text.split(`--${boundary}`).slice(1, -1)
  const payload = (p: string) => p.slice(p.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '')
  const metadata = JSON.parse(Buffer.from(payload(parts[0]), 'latin1').toString('utf8')) as Record<string, unknown>
  const content = parts[1] === undefined ? new Uint8Array() : new Uint8Array(Buffer.from(payload(parts[1]), 'latin1'))
  return { metadata, content }
}

function unescapeQ(v: string): string {
  return v.replace(/\\(.)/g, '$1')
}

export interface CodeOptions {
  /** Scopes Google reports as granted (default: what the login asked for). */
  grantedScope?: string
  /** Google returns a refresh token (default true). */
  withRefreshToken?: boolean
  emailVerified?: boolean
}

export class GoogleWorld {
  readonly env: Record<string, string | undefined>
  readonly nodes = new Map<string, DriveNode>()
  /** Every request "Google" received (server-side from /api handlers and from the SPA). */
  readonly calls: Recorded[] = []
  /** Log lines written by the /api handlers. */
  readonly logs: string[] = []
  /** Server instance memory of the /api functions. */
  readonly tokenCache = new Map<string, CachedToken>()
  readonly refreshTokens = new Map<string, { email: string; revoked: boolean; scope: string }>()
  readonly accessTokens = new Map<string, { email: string; scope: string }>()
  /** Drafts stored in the fake Gmail (raw RFC 822 message as received). */
  readonly drafts: { id: string; raw: string }[] = []
  /** When true, Gmail answers 503 to every request. */
  gmailDown = false
  /** When set, the next refresh also rotates the refresh token. */
  rotateOnNextRefresh = false
  /** When true the OAuth token endpoint answers 503. */
  tokenEndpointDown = false
  /** Thumbnail host answers 302 → this Location for the given file id (redirect/SSRF tests). */
  readonly thumbRedirects = new Map<string, string>()
  private readonly codes = new Map<string, { email: string; scope: string; rt: string | null; redirectUri: string; verified: boolean }>()
  private seq = 0

  constructor(env: Record<string, string | undefined> = {}) {
    this.env = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, ...env }
  }

  deps(): Deps {
    return {
      env: this.env,
      fetch: this.fetch,
      log: (m) => this.logs.push(m),
      random: (n) => randomBytes(n),
      now: () => Date.now(),
      tokenCache: this.tokenCache,
    }
  }

  // ---------------- tokens ----------------

  private uid(prefix: string): string {
    this.seq += 1
    return `${prefix}-${this.seq}-${randomBytes(8).toString('hex')}`
  }

  /** Google's consent screen finished for `email`: a one-time code for that redirect URI. */
  issueCode(email: string, requestedScope: string, redirectUri: string, o: CodeOptions = {}): string {
    const code = this.uid('code-acceptance')
    const scope =
      o.grantedScope ??
      requestedScope
        .split(/\s+/)
        .map((s) => (s === 'email' ? USERINFO_EMAIL_SCOPE : s))
        .join(' ')
    const rt = o.withRefreshToken === false ? null : this.newRefreshToken(email, scope)
    this.codes.set(code, { email, scope, rt, redirectUri, verified: o.emailVerified ?? true })
    return code
  }

  private newRefreshToken(email: string, scope: string): string {
    const rt = this.uid('rt-acceptance-NOT-REAL')
    this.refreshTokens.set(rt, { email, revoked: false, scope })
    return rt
  }

  private newAccessToken(email: string, scope: string): string {
    const at = this.uid('at-acceptance-NOT-REAL')
    this.accessTokens.set(at, { email, scope })
    return at
  }

  /** A fresh access token for the Founder — as if some other client got one (for direct store tests). */
  mintAccessToken(email = FOUNDER, scope = `openid ${USERINFO_EMAIL_SCOPE} ${DRIVE_SCOPE} ${GMAIL_COMPOSE_SCOPE}`): string {
    return this.newAccessToken(email, scope)
  }

  /** Every request the Gmail API received. */
  gmailCalls(): Recorded[] {
    return this.calls.filter((c) => new URL(c.url).hostname === 'gmail.googleapis.com' || /googleapis\.com\/(upload\/)?gmail\//.test(c.url))
  }

  // ---------------- Drive content ----------------

  private addNode(n: Omit<DriveNode, 'id' | 'modifiedTime' | 'thumbnailLink'> & { id?: string; thumbnailLink?: string | null }): DriveNode {
    const id = n.id ?? this.uid('drv').replace(/-/g, '_')
    const node: DriveNode = { modifiedTime: new Date().toISOString(), thumbnailLink: null, ...n, id }
    if (n.thumbnailLink === undefined && node.thumbnail) node.thumbnailLink = `${THUMB_HOST}/drive-thumb/${id}=s220`
    this.nodes.set(id, node)
    return node
  }

  /** A folder the Founder made himself (no app marker). */
  addFolder(parentId: string | null, name: string, o: { id?: string; appProperties?: Record<string, string> } = {}): string {
    return this.addNode({ id: o.id, name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : [], content: new Uint8Array(), appProperties: o.appProperties })
      .id
  }

  /** A file the Founder put in Drive himself (no app marker unless given). */
  addFile(
    parentId: string,
    name: string,
    content: Uint8Array,
    mimeType: string,
    o: { id?: string; appProperties?: Record<string, string>; thumbnail?: { bytes: Uint8Array; type: string }; thumbnailLink?: string | null } = {},
  ): string {
    return this.addNode({ id: o.id, name, mimeType, parents: [parentId], content, appProperties: o.appProperties, thumbnail: o.thumbnail, thumbnailLink: o.thumbnailLink }).id
  }

  children(folderId: string): DriveNode[] {
    return [...this.nodes.values()].filter((n) => n.parents.includes(folderId))
  }

  /** Every write request the Drive API received (anything but GET). */
  driveWrites(): Recorded[] {
    return this.calls.filter((c) => c.method !== 'GET' && /googleapis\.com\/(upload\/)?drive\//.test(c.url))
  }

  /** Deep snapshot of nodes that were not created by the app, for "unchanged" assertions. */
  snapshot(ids: Iterable<string>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const id of ids) {
      const n = this.nodes.get(id)
      out[id] = n
        ? { name: n.name, mimeType: n.mimeType, parents: [...n.parents], appProperties: n.appProperties ? { ...n.appProperties } : undefined, content: latin1(n.content) }
        : 'MISSING'
    }
    return out
  }

  // ---------------- the network ----------------

  readonly fetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const raw = await bodyBytes(init.body)
    const rec: Recorded = { method, url: url.toString(), headers, body: latin1(raw) }
    this.calls.push(rec)
    const bearer = (headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const authed = this.accessTokens.has(bearer)

    // ---- OAuth ----
    if (url.toString() === TOKEN_URL && method === 'POST') {
      if (this.tokenEndpointDown) return json({ error: 'backend_error' }, 503)
      const p = new URLSearchParams(Buffer.from(raw).toString('utf8'))
      if (p.get('client_id') !== CLIENT_ID || p.get('client_secret') !== this.env.GOOGLE_CLIENT_SECRET) return json({ error: 'invalid_client' }, 401)
      if (p.get('grant_type') === 'authorization_code') {
        const c = this.codes.get(p.get('code') ?? '')
        if (!c || c.redirectUri !== p.get('redirect_uri')) return json({ error: 'invalid_grant' }, 400)
        this.codes.delete(p.get('code') ?? '')
        const at = this.newAccessToken(c.email, c.scope)
        if (!c.verified) this.accessTokens.set(at, { email: `${c.email}#unverified`, scope: c.scope })
        return json({ access_token: at, expires_in: 3599, token_type: 'Bearer', scope: c.scope, ...(c.rt ? { refresh_token: c.rt } : {}) })
      }
      if (p.get('grant_type') === 'refresh_token') {
        const r = this.refreshTokens.get(p.get('refresh_token') ?? '')
        if (!r || r.revoked) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)
        const at = this.newAccessToken(r.email, r.scope)
        // Like Google: a refresh reports the scopes granted to that refresh token.
        const body: Record<string, unknown> = { access_token: at, expires_in: 3599, token_type: 'Bearer', scope: r.scope }
        if (this.rotateOnNextRefresh) {
          this.rotateOnNextRefresh = false
          body.refresh_token = this.newRefreshToken(r.email, r.scope)
        }
        return json(body)
      }
      return json({ error: 'unsupported_grant_type' }, 400)
    }
    if (url.toString() === USERINFO_URL) {
      if (!authed) return json({ error: 'invalid_token' }, 401)
      const email = this.accessTokens.get(bearer)!.email
      const unverified = email.endsWith('#unverified')
      return json({ sub: '1234567890', email: email.replace('#unverified', ''), email_verified: !unverified })
    }
    if (url.toString().startsWith(REVOKE_URL) && method === 'POST') {
      const token = new URLSearchParams(Buffer.from(raw).toString('utf8')).get('token') ?? url.searchParams.get('token') ?? ''
      const r = this.refreshTokens.get(token)
      if (r) r.revoked = true
      this.accessTokens.delete(token)
      return new Response(null, { status: 200 })
    }

    // ---- Thumbnail host ----
    if (url.origin === THUMB_HOST) {
      if (!authed) return new Response('forbidden', { status: 403 })
      const id = url.pathname.replace(/^\/drive-thumb\//, '').replace(/=s\d+$/, '')
      const redirect = this.thumbRedirects.get(id)
      if (redirect) return new Response(null, { status: 302, headers: { Location: redirect } })
      const n = this.nodes.get(id)
      if (!n?.thumbnail) return new Response('nf', { status: 404 })
      return new Response(n.thumbnail.bytes.slice(), { headers: { 'Content-Type': n.thumbnail.type } })
    }

    // ---- Drive REST v3 ----
    if (url.hostname === 'www.googleapis.com' && /^\/(upload\/)?drive\/v3\//.test(url.pathname)) {
      if (!authed) return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401)
      return this.drive(method, url, headers, raw, rec)
    }

    // ---- Gmail API ----
    if (url.hostname === 'gmail.googleapis.com') {
      if (this.gmailDown) return json({ error: { code: 503, message: 'Backend Error' } }, 503)
      if (!authed) return json({ error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } }, 401)
      const scopes = this.accessTokens.get(bearer)!.scope.split(/\s+/)
      if (!scopes.includes(GMAIL_COMPOSE_SCOPE)) {
        return json(
          {
            error: {
              code: 403,
              message: 'Request had insufficient authentication scopes.',
              status: 'PERMISSION_DENIED',
              details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
            },
          },
          403,
        )
      }
      if (method === 'POST' && GMAIL_DRAFTS_CREATE_PATHS.includes(url.pathname)) {
        let message = latin1(raw)
        if (url.pathname.startsWith('/gmail/')) {
          const m = JSON.parse(Buffer.from(raw).toString('utf8')) as { message?: { raw?: string } }
          message = Buffer.from(m.message?.raw ?? '', 'base64url').toString('latin1')
        }
        const id = this.uid('r-draft')
        this.drafts.push({ id, raw: message })
        return json({ id, message: { id: this.uid('msg'), threadId: this.uid('thr'), labelIds: ['DRAFT'] } })
      }
      return json({ error: { code: 400, message: `acceptance fake: Gmail call not allowed by the brief: ${method} ${url.pathname}` } }, 400)
    }

    // Any other host (e.g. an attacker's): recorded above, answers with an "image" so a leak would be visible.
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })
  }) as typeof fetch

  private meta(n: DriveNode): Record<string, unknown> {
    return {
      id: n.id,
      name: n.name,
      mimeType: n.mimeType,
      modifiedTime: n.modifiedTime,
      parents: [...n.parents],
      ...(n.appProperties ? { appProperties: { ...n.appProperties } } : {}),
      ...(n.thumbnailLink ? { thumbnailLink: n.thumbnailLink } : {}),
    }
  }

  private drive(method: string, url: URL, headers: Record<string, string>, raw: Uint8Array, rec: Recorded): Response {
    const path = url.pathname
    const idMatch = /\/files\/([^/]+)$/.exec(path)
    const node = idMatch ? this.nodes.get(decodeURIComponent(idMatch[1])) : undefined

    if (method === 'GET' && path === '/drive/v3/files') {
      const q = url.searchParams.get('q') ?? ''
      const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1]
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]
      const foldersOnly = q.includes(`mimeType = '${FOLDER_MIME}'`)
      const files = [...this.nodes.values()].filter(
        (n) =>
          parent !== undefined &&
          n.parents.includes(unescapeQ(parent)) &&
          (name === undefined || n.name === unescapeQ(name)) &&
          (!foldersOnly || n.mimeType === FOLDER_MIME),
      )
      return json({ files: files.map((n) => this.meta(n)) })
    }
    if (method === 'GET' && idMatch && path.startsWith('/drive/v3/files/')) {
      if (!node) return json({ error: { code: 404, message: 'File not found' } }, 404)
      if (url.searchParams.get('alt') === 'media') return media(node.content, node.mimeType)
      return json(this.meta(node))
    }
    if (method === 'POST' && path === '/drive/v3/files') {
      const m = JSON.parse(Buffer.from(raw).toString('utf8')) as { name: string; mimeType: string; parents: string[]; appProperties?: Record<string, string> }
      rec.metadata = m
      const n = this.addNode({ name: m.name, mimeType: m.mimeType, parents: m.parents, content: new Uint8Array(), appProperties: m.appProperties })
      return json(this.meta(n))
    }
    if (method === 'POST' && path === '/upload/drive/v3/files') {
      const { metadata, content } = parseMultipart(headers['content-type'] ?? '', raw)
      rec.metadata = metadata
      const m = metadata as { name: string; mimeType: string; parents: string[]; appProperties?: Record<string, string> }
      const isImage = /^image\//.test(m.mimeType)
      const n = this.addNode({
        name: m.name,
        mimeType: m.mimeType,
        parents: m.parents,
        content,
        appProperties: m.appProperties,
        ...(isImage ? { thumbnail: { bytes: content, type: 'image/png' } } : {}),
      })
      return json(this.meta(n))
    }
    if (method === 'PATCH' && idMatch) {
      if (!node) return json({ error: { code: 404 } }, 404)
      rec.targetMarkedBefore = node.appProperties?.rubedo === '1'
      const { metadata, content } = parseMultipart(headers['content-type'] ?? '', raw)
      rec.metadata = metadata
      // Applied as Drive would, so tests can prove damage if the app ever sent such a request.
      node.content = content
      node.modifiedTime = new Date().toISOString()
      const ap = metadata.appProperties as Record<string, string> | undefined
      if (ap) node.appProperties = { ...(node.appProperties ?? {}), ...ap }
      if (typeof metadata.name === 'string') node.name = metadata.name
      return json({ id: node.id })
    }
    return json({ error: { code: 400, message: `unhandled ${method} ${path}` } }, 400)
  }
}

// ---------------------------------------------------------------------------------------------

export interface SeenByJs {
  method: string
  path: string
  status: number
  headers: string
  body: string
}

type Handler = (req: Request, deps: Deps) => Promise<Response>

const ROUTES: Record<string, Handler> = {
  '/api/auth/login': handleLogin,
  '/api/auth/callback': handleCallback,
  '/api/auth/token': handleToken,
  '/api/auth/logout': handleLogout,
  '/api/thumb': handleThumb,
}

export interface RawExchange {
  method: string
  path: string
  status: number
  headers: [string, string][]
  setCookies: string[]
  body: string
}

/** A browser tab: cookie jar (HttpOnly cookies are invisible to JS) + the /api functions. */
export class Browser {
  readonly jar = new Map<string, { value: string; path: string }>()
  /** Everything the /api returned, as the network saw it (incl. Set-Cookie) — for leak sweeps. */
  readonly exchanges: RawExchange[] = []
  /** What the SPA's JS could read from /api responses (Set-Cookie stripped). */
  readonly seenByJs: SeenByJs[] = []
  readonly world: GoogleWorld

  constructor(world: GoogleWorld) {
    this.world = world
  }

  cookieHeader(path: string): string {
    return [...this.jar.entries()]
      .filter(([, c]) => path === c.path || path.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`))
      .map(([k, c]) => `${k}=${c.value}`)
      .join('; ')
  }

  hasSession(): boolean {
    return this.jar.has(SESSION_COOKIE_NAME)
  }

  /** A top-level navigation or fetch to our own origin, handled by the /api functions. */
  async request(pathAndQuery: string, o: { method?: string; origin?: string | null; cookie?: string } = {}): Promise<Response> {
    const url = new URL(pathAndQuery, ORIGIN)
    const handler = ROUTES[url.pathname]
    if (!handler) throw new Error(`no /api route for ${url.pathname}`)
    const headers = new Headers()
    const cookie = o.cookie ?? this.cookieHeader(url.pathname)
    if (cookie) headers.set('Cookie', cookie)
    if (o.origin) headers.set('Origin', o.origin)
    const method = o.method ?? 'GET'
    const res = await handler(new Request(url, { method, headers }), this.world.deps())
    const setCookies = res.headers.getSetCookie()
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';').map((s) => s.trim())
      const i = pair.indexOf('=')
      const name = pair.slice(0, i)
      const value = pair.slice(i + 1)
      const path = attrs.find((a) => /^path=/i.test(a))?.slice(5) ?? '/'
      const maxAge = attrs.find((a) => /^max-age=/i.test(a))?.slice(8)
      if (maxAge !== undefined && Number(maxAge) <= 0) this.jar.delete(name)
      else this.jar.set(name, { value, path })
    }
    const body = res.body ? Buffer.from(await res.clone().arrayBuffer()).toString('latin1') : ''
    this.exchanges.push({ method, path: url.pathname + url.search, status: res.status, headers: [...res.headers.entries()], setCookies, body })
    return res
  }

  /** `fetch` as the SPA sees it. */
  readonly spaFetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), ORIGIN)
    const method = (init.method ?? 'GET').toUpperCase()
    if (url.origin !== ORIGIN) return this.world.fetch(url.toString(), init)
    // Browsers send Origin on same-origin POSTs.
    const res = await this.request(url.pathname + url.search, { method, origin: method === 'GET' ? null : ORIGIN })
    const visibleHeaders = new Headers()
    for (const [k, v] of res.headers.entries()) if (k.toLowerCase() !== 'set-cookie') visibleHeaders.append(k, v)
    const buf = new Uint8Array(await res.arrayBuffer())
    this.seenByJs.push({
      method,
      path: url.pathname + url.search,
      status: res.status,
      headers: [...visibleHeaders.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'),
      body: Buffer.from(buf).toString('latin1'),
    })
    const noBody = res.status === 204 || res.status === 304 || buf.length === 0
    return new Response(noBody ? null : buf, { status: res.status, headers: visibleHeaders })
  }) as typeof fetch

  /**
   * The full sign-in redirect dance: GET /api/auth/login → (Google consent for `email`) → GET /api/auth/callback.
   * Returns the callback response.
   */
  async signInAtGoogle(email = FOUNDER, o: CodeOptions & { tamperState?: boolean } = {}): Promise<Response> {
    const login = await this.request('/api/auth/login')
    const loc = new URL(login.headers.get('Location') ?? '')
    const redirectUri = loc.searchParams.get('redirect_uri') ?? ''
    const code = this.world.issueCode(email, loc.searchParams.get('scope') ?? '', redirectUri, o)
    const cb = new URL(redirectUri)
    cb.searchParams.set('code', code)
    cb.searchParams.set('state', o.tamperState ? 'forged-state-value' : (loc.searchParams.get('state') ?? ''))
    return this.request(cb.pathname + cb.search)
  }
}
