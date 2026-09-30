import { createHash, randomBytes } from 'node:crypto'
import { safeEqual, tokenFingerprint } from './crypto.js'
import { readConfig, type EnvSource, type ServerConfig } from './env.js'
import {
  DRIVE_FILES_URL,
  GOOGLE_AUTH_URL,
  LOGIN_SCOPES,
  exchangeCode,
  fetchUserEmail,
  hasDriveScope,
  isAllowedThumbnailUrl,
  THUMB_TYPES,
  refreshAccessToken,
  revokeToken,
  sizeThumbnailUrl,
} from './google.js'
import { clearCookie, htmlPage, isCrossOrigin, json, parseCookies, redirect, requestOrigin, serializeCookie, type HeaderInput } from './http.js'
import {
  clearSessionCookie,
  readSession,
  sessionCookie,
  STATE_COOKIE,
  STATE_MAX_AGE,
  STATE_PATH,
  type Session,
} from './session.js'

/**
 * Pure request handlers for the /api functions (brief v0.4 "Endpoints"). Everything from the outside world is
 * injected (env, fetch, log, random, clock) so they are unit-tested without network.
 *
 * Invariants: the refresh token and GOOGLE_CLIENT_SECRET never appear in a response body, a header other than the
 * encrypted session cookie, or a log line. Logs carry only short fixed messages and HTTP status codes.
 */

export interface CachedToken {
  token: string
  expiresAt: number
}

export interface Deps {
  env: EnvSource
  fetch: typeof fetch
  log: (message: string) => void
  random: (bytes: number) => Buffer
  now: () => number
  /** Access tokens minted for the thumbnail proxy, keyed by a hash of the refresh token (instance memory only). */
  tokenCache: Map<string, CachedToken>
  /** In-flight token mints for the thumbnail proxy, same key (M9). Defaults to instance memory. */
  mintsInFlight?: Map<string, Promise<TokenOutcome>>
}

const moduleCache = new Map<string, CachedToken>()
const moduleMints = new Map<string, Promise<TokenOutcome>>()

export function defaultDeps(): Deps {
  return {
    env: process.env,
    fetch: (...args) => fetch(...args),
    log: (m) => console.error(`[rubedo-api] ${m}`),
    random: (n) => randomBytes(n),
    now: () => Date.now(),
    tokenCache: moduleCache,
    mintsInFlight: moduleMints,
  }
}

const CALLBACK_PATH = '/api/auth/callback'
/** Suffix on the OAuth state marking a popup sign-in (it is covered by the state cookie check). */
const POPUP_SUFFIX = '.p'

const POPUP_SCRIPT = 'window.close()'
const POPUP_SCRIPT_HASH = createHash('sha256').update(POPUP_SCRIPT).digest('base64')

/** Popup sign-in finished: tell the Founder he can close it, and close it. Only this exact script may run. */
function popupDonePage(headers: Headers): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  headers.set('Content-Security-Policy', `default-src 'none'; script-src 'sha256-${POPUP_SCRIPT_HASH}'; style-src 'unsafe-inline'`)
  const body = `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RUBEDO.3D — מחובר</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;margin:3rem 1rem">
<p style="font-size:1.2rem">מחובר — אפשר לסגור את החלון</p>
<p dir="ltr" lang="en" style="color:#666;font-size:.9rem">Signed in — you can close this window.</p>
<script>${POPUP_SCRIPT}</script>
</body>
</html>`
  return new Response(body, { status: 200, headers })
}

function misconfiguredPage(missing: string[]): Response {
  return htmlPage(
    500,
    'השרת לא מוגדר',
    `חסרים משתני סביבה ב-Vercel: ${missing.join(', ')}. יש להוסיף אותם בהגדרות הפרויקט ולפרוס מחדש.`,
    `Server is not configured: missing environment variable(s) ${missing.join(', ')}. Add them in the Vercel project settings and redeploy.`,
  )
}

function misconfiguredJson(missing: string[]): Response {
  return json(500, {
    error: 'server_misconfigured',
    message: `השרת לא מוגדר (חסר ${missing.join(', ')}). / Server not configured (missing ${missing.join(', ')}).`,
  })
}

function methodNotAllowed(allow: string): Response {
  return json(405, { error: 'method_not_allowed' }, { Allow: allow })
}

// ---------------------------------------------------------------------------------------------
// GET /api/auth/login

export async function handleLogin(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET')
  const cfg = readConfig(deps.env)
  if (!cfg.ok) return misconfiguredPage(cfg.missing)
  // popup=1 (reconnect from an open page): the callback answers with a tiny "close this window" page.
  const popup = new URL(req.url).searchParams.get('popup') === '1'
  const state = deps.random(32).toString('base64url') + (popup ? POPUP_SUFFIX : '')
  const params = new URLSearchParams({
    client_id: cfg.config.clientId,
    redirect_uri: `${requestOrigin(req)}${CALLBACK_PATH}`,
    response_type: 'code',
    scope: LOGIN_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
  })
  return redirect(`${GOOGLE_AUTH_URL}?${params}`, {
    'Set-Cookie': serializeCookie(STATE_COOKIE, state, { path: STATE_PATH, maxAge: STATE_MAX_AGE }),
  })
}

// ---------------------------------------------------------------------------------------------
// GET /api/auth/callback

export async function handleCallback(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET')
  const cfg = readConfig(deps.env)
  if (!cfg.ok) return misconfiguredPage(cfg.missing)
  const { clientId, clientSecret, allowedEmail } = cfg.config
  // The state cookie is single-use: cleared on every outcome.
  const clearState = { 'Set-Cookie': clearCookie(STATE_COOKIE, STATE_PATH) }

  const url = new URL(req.url)
  if (url.searchParams.get('error')) {
    return htmlPage(400, 'ההתחברות בוטלה', 'ההתחברות ל-Google בוטלה או נדחתה. אפשר לנסות שוב מהאפליקציה.', 'Google sign-in was cancelled or denied.', clearState)
  }
  const state = url.searchParams.get('state') ?? ''
  const expected = parseCookies(req.headers.get('Cookie'))[STATE_COOKIE] ?? ''
  if (!state || !expected || !safeEqual(state, expected)) {
    deps.log('callback: state mismatch')
    return htmlPage(
      400,
      'בקשת התחברות לא תקינה',
      'פג תוקף בקשת ההתחברות או שהיא לא הגיעה מהאפליקציה. חזרו לאפליקציה ולחצו שוב על "התחברות עם Google".',
      'Invalid or expired sign-in request (state mismatch). Start the sign-in again from the app.',
      clearState,
    )
  }
  const code = url.searchParams.get('code')
  if (!code) {
    return htmlPage(400, 'בקשת התחברות לא תקינה', 'חסר קוד התחברות מ-Google. נסו שוב.', 'Missing authorization code.', clearState)
  }

  let exchanged: Awaited<ReturnType<typeof exchangeCode>>
  try {
    exchanged = await exchangeCode(deps.fetch, { code, clientId, clientSecret, redirectUri: `${requestOrigin(req)}${CALLBACK_PATH}` })
  } catch {
    deps.log('callback: token exchange network error')
    return htmlPage(502, 'Google לא זמין', 'לא ניתן היה להשלים את ההתחברות מול Google. נסו שוב בעוד רגע.', 'Could not reach Google to finish sign-in.', clearState)
  }
  if (!exchanged.ok) {
    deps.log(`callback: token exchange failed (${exchanged.status})`)
    return htmlPage(502, 'ההתחברות נכשלה', 'Google דחה את בקשת ההתחברות. נסו שוב.', `Google rejected the code exchange (HTTP ${exchanged.status}).`, clearState)
  }
  const tokens = exchanged.body
  if (!tokens.access_token) {
    return htmlPage(502, 'ההתחברות נכשלה', 'Google לא החזיר אסימון גישה. נסו שוב.', 'Google returned no access token.', clearState)
  }

  // D-H: single user. Checked BEFORE anything is stored.
  let user: Awaited<ReturnType<typeof fetchUserEmail>>
  try {
    user = await fetchUserEmail(deps.fetch, tokens.access_token)
  } catch {
    user = null
  }
  if (!user) {
    deps.log('callback: userinfo failed')
    return htmlPage(502, 'ההתחברות נכשלה', 'לא ניתן היה לזהות את חשבון Google. נסו שוב.', 'Could not read the Google account e-mail.', clearState)
  }
  if (!user.verified || user.email !== allowedEmail) {
    deps.log('callback: account not allowed')
    // M2: nothing of that account is kept — revoke what Google just issued (best effort).
    try {
      await revokeToken(deps.fetch, tokens.refresh_token ?? tokens.access_token)
    } catch {
      deps.log('callback: revoke of rejected account failed')
    }
    return htmlPage(
      403,
      'החשבון אינו מורשה',
      `החשבון ${user.email} אינו מורשה להשתמש באפליקציה. התחברו עם החשבון של RUBEDO.3D.`,
      'This Google account is not allowed to use this app.',
      clearState,
    )
  }
  if (!hasDriveScope(tokens.scope)) {
    return htmlPage(
      400,
      'חסרה הרשאה ל-Drive',
      'יש לאשר את הגישה ל-Google Drive במסך ההסכמה. חזרו לאפליקציה והתחברו שוב, וסמנו את ההרשאה.',
      'The Google Drive permission was not granted.',
      clearState,
    )
  }
  if (!tokens.refresh_token) {
    return htmlPage(
      400,
      'ההתחברות לא הושלמה',
      'Google לא החזיר אסימון רענון, ולכן לא ניתן להישאר מחובר. התחברו שוב.',
      'Google returned no refresh token; cannot keep the session.',
      clearState,
    )
  }

  const session: Session = { v: 1, rt: tokens.refresh_token, email: user.email, iat: Math.floor(deps.now() / 1000) }
  const headers = new Headers()
  headers.append('Set-Cookie', sessionCookie(session, clientSecret))
  headers.append('Set-Cookie', clearCookie(STATE_COOKIE, STATE_PATH))
  if (state.endsWith(POPUP_SUFFIX)) return popupDonePage(headers)
  return redirect('/', headers)
}

// ---------------------------------------------------------------------------------------------
// Session → access token (shared by /token and /thumb)

export type TokenOutcome =
  | { ok: true; accessToken: string; expiresIn: number; session: Session; newRefreshToken?: string }
  | { ok: false; response: Response }

function unauthorized(clear: boolean): Response {
  const headers: HeaderInput = clear ? { 'Set-Cookie': clearSessionCookie() } : {}
  return json(401, { error: 'no_session', message: 'אין חיבור פעיל ל-Google. יש להתחבר.' }, headers)
}

async function mintAccessToken(req: Request, deps: Deps, cfg: ServerConfig): Promise<TokenOutcome> {
  const read = readSession(req, cfg.clientSecret, deps.now())
  if (read.kind === 'none') return { ok: false, response: unauthorized(false) }
  if (read.kind === 'invalid') {
    deps.log('session cookie invalid')
    return { ok: false, response: unauthorized(true) }
  }
  const session = read.session
  if (session.email.toLowerCase() !== cfg.allowedEmail) return { ok: false, response: unauthorized(true) }
  const r = await refreshAccessToken(deps.fetch, { refreshToken: session.rt, clientId: cfg.clientId, clientSecret: cfg.clientSecret })
  if (!r.ok) {
    deps.log(`refresh failed (${r.status})`)
    if (r.revoked) return { ok: false, response: unauthorized(true) }
    return { ok: false, response: json(502, { error: 'google_unavailable', message: 'Google לא זמין כרגע. נסו שוב בעוד רגע.' }) }
  }
  return { ok: true, accessToken: r.accessToken, expiresIn: r.expiresIn, session, ...(r.refreshToken ? { newRefreshToken: r.refreshToken } : {}) }
}

// ---------------------------------------------------------------------------------------------
// POST /api/auth/token

export async function handleToken(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed('POST')
  if (isCrossOrigin(req)) return json(403, { error: 'cross_origin' })
  const cfg = readConfig(deps.env)
  if (!cfg.ok) return misconfiguredJson(cfg.missing)
  const t = await mintAccessToken(req, deps, cfg.config)
  if (!t.ok) return t.response
  const headers: HeaderInput = t.newRefreshToken
    ? { 'Set-Cookie': sessionCookie({ ...t.session, rt: t.newRefreshToken }, cfg.config.clientSecret) }
    : {}
  return json(200, { access_token: t.accessToken, expires_in: t.expiresIn, email: t.session.email }, headers)
}

// ---------------------------------------------------------------------------------------------
// POST /api/auth/logout

export async function handleLogout(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed('POST')
  if (isCrossOrigin(req)) return json(403, { error: 'cross_origin' })
  const headers = new Headers({ 'Set-Cookie': clearSessionCookie(), 'Cache-Control': 'no-store' })
  const cfg = readConfig(deps.env)
  if (cfg.ok) {
    const read = readSession(req, cfg.config.clientSecret, deps.now())
    if (read.kind === 'ok') {
      deps.tokenCache.delete(tokenFingerprint(read.session.rt))
      try {
        await revokeToken(deps.fetch, read.session.rt) // best effort
      } catch {
        deps.log('logout: revoke failed')
      }
    }
  }
  return new Response(null, { status: 204, headers })
}

// ---------------------------------------------------------------------------------------------
// GET /api/thumb?id=<fileId>&s=<px>

export const THUMB_ID_RE = /^[A-Za-z0-9_-]{10,}$/
export const THUMB_MIN = 64
export const THUMB_MAX = 1600
export const THUMB_DEFAULT = 800
const MAX_REDIRECTS = 3
/** Minted tokens are reused until this long before they expire. */
const CACHE_MARGIN_MS = 5 * 60 * 1000
const CACHE_LIMIT = 20

export function clampSize(raw: string | null): number {
  const n = raw === null || raw.trim() === '' ? THUMB_DEFAULT : Math.round(Number(raw))
  if (!Number.isFinite(n)) return THUMB_DEFAULT
  return Math.min(THUMB_MAX, Math.max(THUMB_MIN, n))
}

async function thumbToken(req: Request, deps: Deps, cfg: ServerConfig, forceNew: boolean): Promise<TokenOutcome & { key?: string }> {
  const read = readSession(req, cfg.clientSecret, deps.now())
  // No/invalid session: mintAccessToken produces the right 401 (and clears a bad cookie).
  if (read.kind !== 'ok') return mintAccessToken(req, deps, cfg)
  const key = tokenFingerprint(read.session.rt)
  if (!forceNew) {
    const hit = deps.tokenCache.get(key)
    if (hit && hit.expiresAt - CACHE_MARGIN_MS > deps.now()) {
      return { ok: true, accessToken: hit.token, expiresIn: Math.floor((hit.expiresAt - deps.now()) / 1000), session: read.session, key }
    }
  }
  // M9: a library page asks for many thumbnails at once — they share ONE token mint per session.
  const inflight = deps.mintsInFlight ?? moduleMints
  let pending = inflight.get(key)
  if (!pending) {
    pending = mintAccessToken(req, deps, cfg).then((t) => {
      if (t.ok) {
        if (deps.tokenCache.size >= CACHE_LIMIT) deps.tokenCache.clear()
        deps.tokenCache.set(key, { token: t.accessToken, expiresAt: deps.now() + t.expiresIn * 1000 })
      }
      return t
    })
    const p = pending
    inflight.set(key, p)
    void p.finally(() => {
      if (inflight.get(key) === p) inflight.delete(key)
    })
  }
  const t = await pending
  return t.ok ? { ...t, key } : t
}

/**
 * Fetches an allowed Google host, following at most MAX_REDIRECTS redirects that stay on allowed hosts.
 * M8: the bearer token goes ONLY to the initial thumbnailLink host — never on a redirect hop.
 */
async function fetchThumbnail(deps: Deps, url: string, accessToken: string): Promise<Response | 'bad-host'> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedThumbnailUrl(current)) return 'bad-host'
    const headers: Record<string, string> = hop === 0 ? { Authorization: `Bearer ${accessToken}` } : {}
    const res = await deps.fetch(current, { headers, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location')
      if (!loc) return res
      current = new URL(loc, current).toString()
      continue
    }
    return res
  }
  return new Response(null, { status: 508 })
}

export async function handleThumb(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET')
  const url = new URL(req.url)
  const id = url.searchParams.get('id') ?? ''
  if (!THUMB_ID_RE.test(id)) return json(400, { error: 'invalid_id' })
  const size = clampSize(url.searchParams.get('s'))
  const cfg = readConfig(deps.env)
  if (!cfg.ok) return misconfiguredJson(cfg.missing)

  let t = await thumbToken(req, deps, cfg.config, false)
  if (!t.ok) return t.response

  const metaUrl = `${DRIVE_FILES_URL}/${encodeURIComponent(id)}?fields=thumbnailLink&supportsAllDrives=true`
  let meta: Response
  try {
    meta = await deps.fetch(metaUrl, { headers: { Authorization: `Bearer ${t.accessToken}` } })
    if (meta.status === 401) {
      // A cached token was revoked early: mint a fresh one once.
      if (t.key) deps.tokenCache.delete(t.key)
      t = await thumbToken(req, deps, cfg.config, true)
      if (!t.ok) return t.response
      meta = await deps.fetch(metaUrl, { headers: { Authorization: `Bearer ${t.accessToken}` } })
    }
  } catch {
    deps.log('thumb: metadata network error')
    return json(502, { error: 'google_unavailable' })
  }
  if (meta.status === 404) return json(404, { error: 'not_found' })
  if (!meta.ok) {
    deps.log(`thumb: metadata ${meta.status}`)
    return json(502, { error: 'drive_error' })
  }
  const link = ((await meta.json()) as { thumbnailLink?: string }).thumbnailLink
  if (!link) return json(404, { error: 'no_thumbnail' })

  let img: Response | 'bad-host'
  try {
    img = await fetchThumbnail(deps, sizeThumbnailUrl(link, size), t.accessToken)
  } catch {
    deps.log('thumb: image network error')
    return json(502, { error: 'google_unavailable' })
  }
  if (img === 'bad-host') {
    deps.log('thumb: refused non-Google thumbnail host')
    return json(502, { error: 'bad_thumbnail_host' })
  }
  if (img.status === 404) return json(404, { error: 'no_thumbnail' })
  if (!img.ok) {
    deps.log(`thumb: image ${img.status}`)
    return json(502, { error: 'thumbnail_unavailable' })
  }
  // I3: only plain raster images pass (no SVG/HTML that could run script on our origin).
  const type = (img.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase()
  if (!THUMB_TYPES.includes(type)) {
    deps.log('thumb: refused content type')
    return json(415, { error: 'unsupported_media_type' })
  }
  return new Response(img.body, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  })
}
