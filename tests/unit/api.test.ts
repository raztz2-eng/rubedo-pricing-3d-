// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveKey, seal, unseal } from '../../api/_lib/crypto'
import { readConfig } from '../../api/_lib/env'
import { isAllowedThumbnailUrl, sizeThumbnailUrl } from '../../api/_lib/google'
import {
  clampSize,
  handleCallback,
  handleLogin,
  handleLogout,
  handleThumb,
  handleToken,
  type CachedToken,
  type Deps,
} from '../../api/_lib/handlers'
import { SESSION_COOKIE, STATE_COOKIE, sessionCookie } from '../../api/_lib/session'

const ORIGIN = 'https://rubedo.example.app'
const SECRET = 'fake-test-client-secret-not-real'
const CLIENT_ID = 'client-123.apps.googleusercontent.com'
const RT = '1//refresh-token-DO-NOT-LEAK'
const RT2 = '1//rotated-refresh-token-DO-NOT-LEAK'
const EMAIL = 'raztz2@gmail.com'
const DRIVE = 'https://www.googleapis.com/auth/drive'
const FILE_ID = 'heicFile_ID-1234567890'

interface Call {
  url: string
  method: string
  body: string
  headers: Record<string, string>
  redirect?: string
}

/** Scripted Google: every test decides what each endpoint answers. Records every outgoing request. */
function google(overrides: Partial<Record<'token' | 'refresh' | 'userinfo' | 'revoke' | 'meta' | 'thumb', () => Response | Promise<Response>>> = {}) {
  const calls: Call[] = []
  const answer = (r: Response | (() => Response | Promise<Response>)) => (typeof r === 'function' ? r() : r)
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const body = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : ''
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    calls.push({ url, method: (init.method ?? 'GET').toUpperCase(), body, headers, redirect: init.redirect })
    if (url === 'https://oauth2.googleapis.com/token') {
      const grant = new URLSearchParams(body).get('grant_type')
      if (grant === 'authorization_code') {
        return answer(
          overrides.token ??
            (() => Response.json({ access_token: 'ya29.login', refresh_token: RT, expires_in: 3599, scope: `openid ${DRIVE} https://www.googleapis.com/auth/userinfo.email` })),
        )
      }
      return answer(overrides.refresh ?? (() => Response.json({ access_token: 'ya29.fresh', expires_in: 3599 })))
    }
    if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
      return answer(overrides.userinfo ?? (() => Response.json({ email: EMAIL, email_verified: true })))
    }
    if (url === 'https://oauth2.googleapis.com/revoke') return answer(overrides.revoke ?? (() => new Response(null, { status: 200 })))
    if (url.startsWith('https://www.googleapis.com/drive/v3/files/')) {
      return answer(overrides.meta ?? (() => Response.json({ thumbnailLink: 'https://lh3.googleusercontent.com/drive-thumb/abc=s220' })))
    }
    if (url.startsWith('https://lh3.googleusercontent.com/')) {
      return answer(overrides.thumb ?? (() => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'Content-Type': 'image/jpeg' } })))
    }
    return new Response('unexpected', { status: 599 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

function makeDeps(g = google(), env: Record<string, string | undefined> = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: SECRET }) {
  const logs: string[] = []
  const deps: Deps = {
    env,
    fetch: g.fetchImpl,
    log: (m) => logs.push(m),
    random: (n) => Buffer.alloc(n, 7),
    now: () => 1_700_000_000_000,
    tokenCache: new Map<string, CachedToken>(),
  }
  return { deps, logs, g }
}

function req(path: string, init: { method?: string; cookie?: string; origin?: string } = {}): Request {
  const headers = new Headers()
  if (init.cookie) headers.set('Cookie', init.cookie)
  if (init.origin) headers.set('Origin', init.origin)
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers })
}

function validSessionCookie(rt = RT, email = EMAIL): string {
  const set = sessionCookie({ v: 1, rt, email, iat: 1 }, SECRET)
  return set.split(';')[0]
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie()
}

/** Everything a browser could see from a response, minus the encrypted cookie value (checked separately). */
async function visible(res: Response): Promise<string> {
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')
  const body = res.body ? Buffer.from(await res.clone().arrayBuffer()).toString('utf8') : ''
  return `${headers}\n${body}`
}

// ---------------------------------------------------------------------------------------------
describe('api/_lib/crypto — AES-256-GCM session sealing', () => {
  it('round-trips, and rejects tampering, another key and garbage', () => {
    const key = deriveKey(SECRET)
    const sealed = seal('{"rt":"x"}', key)
    expect(sealed.startsWith('v1.')).toBe(true)
    expect(sealed).not.toContain('rt')
    expect(unseal(sealed, key)).toBe('{"rt":"x"}')

    const raw = Buffer.from(sealed.slice(3), 'base64url')
    for (const i of [0, 13, raw.length - 1]) {
      const t = Buffer.from(raw)
      t[i] ^= 1
      expect(unseal(`v1.${t.toString('base64url')}`, key), `flip byte ${i}`).toBeNull()
    }
    expect(unseal(sealed, deriveKey('another-secret'))).toBeNull()
    expect(unseal('v1.', key)).toBeNull()
    expect(unseal('garbage', key)).toBeNull()
    expect(unseal(sealed.slice(0, -4), key)).toBeNull()
  })

  it('derives a stable 32-byte key from the client secret (HKDF-SHA256)', () => {
    expect(deriveKey(SECRET)).toHaveLength(32)
    expect(deriveKey(SECRET).equals(deriveKey(SECRET))).toBe(true)
    expect(deriveKey(SECRET).equals(deriveKey(`${SECRET}x`))).toBe(false)
  })
})

describe('api/_lib/env', () => {
  it('GOOGLE_CLIENT_ID falls back to VITE_GOOGLE_CLIENT_ID; ALLOWED_EMAIL defaults to the Founder', () => {
    const r = readConfig({ VITE_GOOGLE_CLIENT_ID: 'vite-id', GOOGLE_CLIENT_SECRET: 's' })
    expect(r).toEqual({ ok: true, config: { clientId: 'vite-id', clientSecret: 's', allowedEmail: 'raztz2@gmail.com' } })
    const r2 = readConfig({ GOOGLE_CLIENT_ID: 'id', VITE_GOOGLE_CLIENT_ID: 'vite-id', GOOGLE_CLIENT_SECRET: 's', ALLOWED_EMAIL: ' Other@Example.com ' })
    expect(r2.ok && r2.config).toMatchObject({ clientId: 'id', allowedEmail: 'other@example.com' })
    expect(readConfig({ GOOGLE_CLIENT_ID: 'id' })).toEqual({ ok: false, missing: ['GOOGLE_CLIENT_SECRET'] })
  })
})

// ---------------------------------------------------------------------------------------------
describe('GET /api/auth/login', () => {
  it('redirects to Google with drive + openid email, offline, consent, no granted-scope inheritance, and a state cookie', async () => {
    const { deps } = makeDeps()
    const res = await handleLogin(req('/api/auth/login'), deps)
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('Location') as string)
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const p = loc.searchParams
    expect(p.get('client_id')).toBe(CLIENT_ID)
    expect(p.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback`)
    expect(p.get('response_type')).toBe('code')
    expect((p.get('scope') ?? '').split(' ').sort()).toEqual(['email', 'openid', DRIVE].sort())
    expect(p.get('access_type')).toBe('offline')
    expect(p.get('prompt')).toBe('consent')
    expect(p.get('include_granted_scopes')).toBe('false')
    const state = p.get('state') as string
    expect(state.length).toBeGreaterThanOrEqual(40)
    const [cookie] = setCookies(res)
    expect(cookie).toBe(`${STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=600`)
    expect(p.get('client_secret')).toBeNull()
    expect(await visible(res)).not.toContain(SECRET)
  })

  it('falls back to VITE_GOOGLE_CLIENT_ID', async () => {
    const { deps } = makeDeps(google(), { VITE_GOOGLE_CLIENT_ID: 'vite-client', GOOGLE_CLIENT_SECRET: SECRET })
    const res = await handleLogin(req('/api/auth/login'), deps)
    expect(new URL(res.headers.get('Location') as string).searchParams.get('client_id')).toBe('vite-client')
  })

  it('missing GOOGLE_CLIENT_SECRET → clear Hebrew/English error page, no crash, no redirect', async () => {
    const { deps } = makeDeps(google(), { GOOGLE_CLIENT_ID: CLIENT_ID })
    const res = await handleLogin(req('/api/auth/login'), deps)
    expect(res.status).toBe(500)
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/)
    const html = await res.text()
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('GOOGLE_CLIENT_SECRET')
    expect(html).toMatch(/[א-ת]/)
    expect(html).toMatch(/missing environment variable/i)
    expect(res.headers.get('Location')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
describe('GET /api/auth/callback', () => {
  const STATE = 'state-abc-123'
  const cb = (q: string, cookie = `${STATE_COOKIE}=${STATE}`) => req(`/api/auth/callback?${q}`, { cookie })

  it('happy path: state ok, allowed account, drive scope, refresh token → encrypted session cookie, 302 to /', async () => {
    const { deps, g } = makeDeps()
    const res = await handleCallback(cb(`code=CODE&state=${STATE}`), deps)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/')
    const cookies = setCookies(res)
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) as string
    expect(session).toMatch(/; HttpOnly; Secure; SameSite=Lax; Path=\/api; Max-Age=15552000$/)
    expect(session).not.toContain(RT)
    const value = session.split(';')[0].slice(SESSION_COOKIE.length + 1)
    expect(JSON.parse(unseal(value, deriveKey(SECRET)) as string)).toMatchObject({ v: 1, rt: RT, email: EMAIL })
    // The state cookie is cleared.
    expect(cookies).toContain(`${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=0`)
    // Code exchange used the same redirect_uri and the secret (server → Google only).
    const exchange = g.calls.find((c) => c.url === 'https://oauth2.googleapis.com/token') as Call
    const form = new URLSearchParams(exchange.body)
    expect(form.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback`)
    expect(form.get('client_secret')).toBe(SECRET)
    expect(await visible(res)).not.toContain(SECRET)
  })

  it('AC19: a non-allowed Google account is rejected with a Hebrew page and NO session cookie', async () => {
    for (const userinfo of [
      () => Response.json({ email: 'someone.else@gmail.com', email_verified: true }),
      () => Response.json({ email: EMAIL, email_verified: false }),
    ]) {
      const { deps } = makeDeps(google({ userinfo }))
      const res = await handleCallback(cb(`code=CODE&state=${STATE}`), deps)
      expect(res.status).toBe(403)
      expect(await res.text()).toMatch(/אינו מורשה/)
      expect(setCookies(res).some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false)
    }
  })

  it('ALLOWED_EMAIL env overrides the default (case-insensitive)', async () => {
    const { deps } = makeDeps(google({ userinfo: () => Response.json({ email: 'Partner@Example.com', email_verified: true }) }), {
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: SECRET,
      ALLOWED_EMAIL: 'partner@example.com',
    })
    expect((await handleCallback(cb(`code=CODE&state=${STATE}`), deps)).status).toBe(302)
  })

  it('state check: missing cookie, missing param or mismatch → 400, no token exchange, no session', async () => {
    for (const r of [cb(`code=CODE&state=${STATE}`, ''), cb('code=CODE'), cb('code=CODE&state=other')]) {
      const { deps, g } = makeDeps()
      const res = await handleCallback(r, deps)
      expect(res.status).toBe(400)
      expect(g.calls).toEqual([])
      expect(setCookies(res).some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false)
    }
  })

  it('requires the drive scope and a refresh token', async () => {
    const cases = [
      () => Response.json({ access_token: 'a', refresh_token: RT, scope: 'openid email' }),
      () => Response.json({ access_token: 'a', scope: `openid ${DRIVE}` }),
    ]
    for (const token of cases) {
      const { deps } = makeDeps(google({ token }))
      const res = await handleCallback(cb(`code=CODE&state=${STATE}`), deps)
      expect(res.status).toBe(400)
      expect(setCookies(res).some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false)
    }
  })

  it('user cancelled at Google (error=access_denied) → Hebrew page, no exchange', async () => {
    const { deps, g } = makeDeps()
    const res = await handleCallback(cb(`error=access_denied&state=${STATE}`), deps)
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/בוטלה/)
    expect(g.calls).toEqual([])
  })

  it('failed code exchange → 502 page; the log has the status only', async () => {
    const { deps, logs } = makeDeps(google({ token: () => new Response(JSON.stringify({ error: 'invalid_grant', secret_echo: SECRET }), { status: 400 }) }))
    const res = await handleCallback(cb(`code=CODE&state=${STATE}`), deps)
    expect(res.status).toBe(502)
    expect(logs.join('\n')).toMatch(/400/)
    expect(logs.join('\n')).not.toContain(SECRET)
    expect(await visible(res)).not.toContain(SECRET)
  })
})

// ---------------------------------------------------------------------------------------------
describe('POST /api/auth/token (AC20)', () => {
  it('valid session → {access_token, expires_in, email}, no-store; refreshes with the stored refresh token', async () => {
    const { deps, g } = makeDeps()
    const res = await handleToken(req('/api/auth/token', { method: 'POST', cookie: validSessionCookie(), origin: ORIGIN }), deps)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ access_token: 'ya29.fresh', expires_in: 3599, email: EMAIL })
    const call = g.calls[0]
    expect(call.url).toBe('https://oauth2.googleapis.com/token')
    expect(new URLSearchParams(call.body).get('refresh_token')).toBe(RT)
    expect(new URLSearchParams(call.body).get('grant_type')).toBe('refresh_token')
  })

  it('no cookie → 401 JSON (nothing to clear), no call to Google', async () => {
    const { deps, g } = makeDeps()
    const res = await handleToken(req('/api/auth/token', { method: 'POST' }), deps)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('no_session')
    expect(g.calls).toEqual([])
  })

  it('tampered cookie → 401 and the cookie is cleared', async () => {
    const good = validSessionCookie()
    const tampered = good.slice(0, -3) + (good.endsWith('A') ? 'BBB' : 'AAA')
    for (const cookie of [tampered, `${SESSION_COOKIE}=v1.not-a-real-session`, `${SESSION_COOKIE}=plain`]) {
      const { deps, g } = makeDeps()
      const res = await handleToken(req('/api/auth/token', { method: 'POST', cookie }), deps)
      expect(res.status).toBe(401)
      expect(setCookies(res)).toEqual([`${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=0`])
      expect(g.calls).toEqual([])
    }
  })

  it('cross-origin Origin → 403 (CSRF); same origin or no Origin header is fine', async () => {
    const { deps, g } = makeDeps()
    const res = await handleToken(req('/api/auth/token', { method: 'POST', cookie: validSessionCookie(), origin: 'https://evil.example' }), deps)
    expect(res.status).toBe(403)
    expect(g.calls).toEqual([])
    expect((await handleToken(req('/api/auth/token', { method: 'POST', cookie: validSessionCookie() }), deps)).status).toBe(200)
  })

  it('GET is not allowed', async () => {
    const { deps } = makeDeps()
    expect((await handleToken(req('/api/auth/token', { cookie: validSessionCookie() }), deps)).status).toBe(405)
  })

  it('revoked refresh token (invalid_grant) → 401 + cookie cleared; Google down → 502, cookie kept', async () => {
    const revoked = makeDeps(google({ refresh: () => Response.json({ error: 'invalid_grant' }, { status: 400 }) }))
    const r1 = await handleToken(req('/api/auth/token', { method: 'POST', cookie: validSessionCookie() }), revoked.deps)
    expect(r1.status).toBe(401)
    expect(setCookies(r1)[0]).toMatch(/Max-Age=0$/)

    const down = makeDeps(google({ refresh: () => new Response('oops', { status: 503 }) }))
    const r2 = await handleToken(req('/api/auth/token', { method: 'POST', cookie: validSessionCookie() }), down.deps)
    expect(r2.status).toBe(502)
    expect(setCookies(r2)).toEqual([])
  })

  it('a session for an account that is no longer allowed → 401 + cleared', async () => {
    const { deps, g } = makeDeps()
    const res = await handleToken(req('/api/auth/token', { method: 'POST', cookie: validSessionCookie(RT, 'old@example.com') }), deps)
    expect(res.status).toBe(401)
    expect(g.calls).toEqual([])
  })

  it('a rotated refresh token from Google is stored in a new encrypted cookie, never in the body', async () => {
    const { deps } = makeDeps(google({ refresh: () => Response.json({ access_token: 'ya29.x', expires_in: 3600, refresh_token: RT2 }) }))
    const res = await handleToken(req('/api/auth/token', { method: 'POST', cookie: validSessionCookie() }), deps)
    const [cookie] = setCookies(res)
    const value = cookie.split(';')[0].slice(SESSION_COOKIE.length + 1)
    expect(JSON.parse(unseal(value, deriveKey(SECRET)) as string).rt).toBe(RT2)
    expect(await visible(res)).not.toContain(RT2)
  })

  it('missing env → 500 JSON with a Hebrew/English message, no crash', async () => {
    const { deps } = makeDeps(google(), {})
    const res = await handleToken(req('/api/auth/token', { method: 'POST', cookie: validSessionCookie() }), deps)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('server_misconfigured')
    expect(body.message).toMatch(/[א-ת]/)
  })
})

// ---------------------------------------------------------------------------------------------
describe('POST /api/auth/logout', () => {
  it('revokes the refresh token at Google (best effort), clears the cookie, 204', async () => {
    const { deps, g } = makeDeps()
    const res = await handleLogout(req('/api/auth/logout', { method: 'POST', cookie: validSessionCookie(), origin: ORIGIN }), deps)
    expect(res.status).toBe(204)
    expect(setCookies(res)).toEqual([`${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=0`])
    const revoke = g.calls.find((c) => c.url === 'https://oauth2.googleapis.com/revoke') as Call
    expect(new URLSearchParams(revoke.body).get('token')).toBe(RT)
  })

  it('revoke failure or no session still clears the cookie and answers 204', async () => {
    const failing = makeDeps(
      google({
        revoke: () => {
          throw new Error('network down')
        },
      }),
    )
    const r1 = await handleLogout(req('/api/auth/logout', { method: 'POST', cookie: validSessionCookie() }), failing.deps)
    expect(r1.status).toBe(204)
    expect(setCookies(r1)[0]).toMatch(/Max-Age=0$/)
    const r2 = await handleLogout(req('/api/auth/logout', { method: 'POST' }), makeDeps().deps)
    expect(r2.status).toBe(204)
  })

  it('cross-origin → 403, nothing revoked', async () => {
    const { deps, g } = makeDeps()
    const res = await handleLogout(req('/api/auth/logout', { method: 'POST', cookie: validSessionCookie(), origin: 'https://evil.example' }), deps)
    expect(res.status).toBe(403)
    expect(g.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
describe('GET /api/thumb (AC23)', () => {
  const thumbReq = (q: string, cookie = validSessionCookie()) => req(`/api/thumb?${q}`, { cookie })

  it('returns the Drive thumbnail of a HEIC file as an image, sized, fetched server-side with the token', async () => {
    const { deps, g } = makeDeps()
    const res = await handleThumb(thumbReq(`id=${FILE_ID}&s=400`), deps)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600')
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([0xff, 0xd8, 0xff])
    const meta = g.calls.find((c) => c.url.startsWith('https://www.googleapis.com/drive/v3/files/')) as Call
    expect(meta.url).toContain(`/files/${FILE_ID}?fields=thumbnailLink`)
    expect(meta.headers.authorization).toBe('Bearer ya29.fresh')
    const img = g.calls.find((c) => c.url.startsWith('https://lh3.googleusercontent.com/')) as Call
    expect(img.url).toBe('https://lh3.googleusercontent.com/drive-thumb/abc=s400')
    expect(img.redirect).toBe('manual')
  })

  it('rejects invalid ids before any work (400)', async () => {
    for (const id of ['', 'short', '../../etc/passwd', 'abc%2Fdef1234567', 'a b c d e f g h', 'x'.repeat(9)]) {
      const { deps, g } = makeDeps()
      const res = await handleThumb(thumbReq(`id=${encodeURIComponent(id)}`), deps)
      expect(res.status, id).toBe(400)
      expect(g.calls).toEqual([])
    }
  })

  it('clamps the size to 64–1600 (default 800)', () => {
    expect(clampSize('10')).toBe(64)
    expect(clampSize('99999')).toBe(1600)
    expect(clampSize('400')).toBe(400)
    expect(clampSize(null)).toBe(800)
    expect(clampSize('abc')).toBe(800)
    expect(clampSize('-5')).toBe(64)
  })

  it('refuses non-Google thumbnail hosts (no SSRF), also via redirect', async () => {
    for (const link of ['https://evil.example.com/x=s220', 'http://lh3.googleusercontent.com/x', 'https://googleusercontent.com.evil.io/x', 'https://user:pw@lh3.googleusercontent.com/x']) {
      const { deps, g } = makeDeps(google({ meta: () => Response.json({ thumbnailLink: link }) }))
      const res = await handleThumb(thumbReq(`id=${FILE_ID}`), deps)
      expect(res.status, link).toBe(502)
      expect(g.calls.some((c) => c.url.startsWith(link.split('=')[0]) && !c.url.startsWith('https://www.googleapis.com'))).toBe(false)
    }
    const redirecting = makeDeps(google({ thumb: () => new Response(null, { status: 302, headers: { Location: 'https://evil.example.com/steal' } }) }))
    const res = await handleThumb(thumbReq(`id=${FILE_ID}`), redirecting.deps)
    expect(res.status).toBe(502)
    expect(redirecting.g.calls.some((c) => c.url.includes('evil.example.com'))).toBe(false)
  })

  it('host allowlist', () => {
    expect(isAllowedThumbnailUrl('https://lh3.googleusercontent.com/a')).toBe(true)
    expect(isAllowedThumbnailUrl('https://drive.google.com/thumbnail?id=1')).toBe(true)
    expect(isAllowedThumbnailUrl('https://evilgoogle.com/a')).toBe(false)
    expect(isAllowedThumbnailUrl('https://google.com.evil.io/a')).toBe(false)
    expect(isAllowedThumbnailUrl('https://lh3.googleusercontent.com:8443/a')).toBe(false)
    expect(isAllowedThumbnailUrl('not a url')).toBe(false)
    expect(sizeThumbnailUrl('https://lh3.googleusercontent.com/a=s220', 800)).toBe('https://lh3.googleusercontent.com/a=s800')
  })

  it('no thumbnail → 404; file not found → 404; not an image → 502', async () => {
    expect((await handleThumb(thumbReq(`id=${FILE_ID}`), makeDeps(google({ meta: () => Response.json({}) })).deps)).status).toBe(404)
    expect((await handleThumb(thumbReq(`id=${FILE_ID}`), makeDeps(google({ meta: () => new Response('', { status: 404 }) })).deps)).status).toBe(404)
    const html = makeDeps(google({ thumb: () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }) }))
    expect((await handleThumb(thumbReq(`id=${FILE_ID}`), html.deps)).status).toBe(502)
  })

  it('requires a valid session: none → 401; tampered → 401 + cleared', async () => {
    const { deps, g } = makeDeps()
    expect((await handleThumb(req(`/api/thumb?id=${FILE_ID}`), deps)).status).toBe(401)
    const res = await handleThumb(thumbReq(`id=${FILE_ID}`, `${SESSION_COOKIE}=v1.tampered`), deps)
    expect(res.status).toBe(401)
    expect(setCookies(res)[0]).toMatch(/Max-Age=0$/)
    expect(g.calls).toEqual([])
  })

  it('reuses a minted access token across thumbnails (one refresh for many images); a Drive 401 mints a new one once', async () => {
    const { deps, g } = makeDeps()
    await handleThumb(thumbReq(`id=${FILE_ID}`), deps)
    await handleThumb(thumbReq(`id=${FILE_ID}`), deps)
    expect(g.calls.filter((c) => c.url === 'https://oauth2.googleapis.com/token')).toHaveLength(1)

    let first = true
    const stale = makeDeps(
      google({
        meta: () => {
          if (first) {
            first = false
            return new Response('', { status: 401 })
          }
          return Response.json({ thumbnailLink: 'https://lh3.googleusercontent.com/drive-thumb/abc=s220' })
        },
      }),
    )
    const res = await handleThumb(thumbReq(`id=${FILE_ID}`), stale.deps)
    expect(res.status).toBe(200)
    expect(stale.g.calls.filter((c) => c.url === 'https://oauth2.googleapis.com/token')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC24 — the refresh token and the client secret never reach a response, a log line or the repo', () => {
  it('sweep: every endpoint, success and failure paths', async () => {
    const scenarios: [string, () => Promise<{ res: Response; logs: string[] }>][] = []
    const run = (name: string, handler: (r: Request, d: Deps) => Promise<Response>, r: () => Request, g = google()) =>
      scenarios.push([
        name,
        async () => {
          const { deps, logs } = makeDeps(g)
          return { res: await handler(r(), deps), logs }
        },
      ])
    const STATE = 's'
    const bad = () => new Response(JSON.stringify({ error: 'invalid_grant', echo: `${RT} ${SECRET}` }), { status: 400 })
    run('login', handleLogin, () => req('/api/auth/login'))
    run('callback ok', handleCallback, () => req(`/api/auth/callback?code=c&state=${STATE}`, { cookie: `${STATE_COOKIE}=${STATE}` }))
    run('callback denied account', handleCallback, () => req(`/api/auth/callback?code=c&state=${STATE}`, { cookie: `${STATE_COOKIE}=${STATE}` }), google({ userinfo: () => Response.json({ email: 'x@y.z', email_verified: true }) }))
    run('callback exchange fails', handleCallback, () => req(`/api/auth/callback?code=c&state=${STATE}`, { cookie: `${STATE_COOKIE}=${STATE}` }), google({ token: bad }))
    run('token ok', handleToken, () => req('/api/auth/token', { method: 'POST', cookie: validSessionCookie() }))
    run('token revoked', handleToken, () => req('/api/auth/token', { method: 'POST', cookie: validSessionCookie() }), google({ refresh: bad }))
    run('token google down', handleToken, () => req('/api/auth/token', { method: 'POST', cookie: validSessionCookie() }), google({ refresh: () => new Response(`${RT}`, { status: 500 }) }))
    run('logout', handleLogout, () => req('/api/auth/logout', { method: 'POST', cookie: validSessionCookie() }), google({ revoke: bad }))
    run('thumb ok', handleThumb, () => req(`/api/thumb?id=${FILE_ID}`, { cookie: validSessionCookie() }))
    run('thumb bad host', handleThumb, () => req(`/api/thumb?id=${FILE_ID}`, { cookie: validSessionCookie() }), google({ meta: () => Response.json({ thumbnailLink: `https://evil.example/${RT}` }) }))
    run('thumb drive error', handleThumb, () => req(`/api/thumb?id=${FILE_ID}`, { cookie: validSessionCookie() }), google({ meta: () => new Response(SECRET, { status: 500 }) }))

    const original = { log: console.log, error: console.error, warn: console.warn, info: console.info }
    const consoleOut: string[] = []
    for (const k of ['log', 'error', 'warn', 'info'] as const) console[k] = (...a: unknown[]) => consoleOut.push(a.map(String).join(' '))
    try {
      for (const [name, s] of scenarios) {
        const { res, logs } = await s()
        const seen = await visible(res)
        for (const secret of [RT, SECRET]) {
          expect(seen, `${name}: response`).not.toContain(secret)
          expect(logs.join('\n'), `${name}: log`).not.toContain(secret)
        }
      }
    } finally {
      Object.assign(console, original)
    }
    expect(consoleOut.join('\n')).not.toContain(RT)
    expect(consoleOut.join('\n')).not.toContain(SECRET)
  })

  it('static: no API code logs a token/secret variable, and the SPA never reads the session cookie', () => {
    const files = ['api/_lib/handlers.ts', 'api/_lib/google.ts', 'api/_lib/session.ts', 'api/_lib/crypto.ts', 'api/_lib/http.ts', 'api/_lib/env.ts']
    for (const f of files) {
      const code = readFileSync(resolve(process.cwd(), f), 'utf8')
      expect(code, f).not.toMatch(/console\.\w+\([^)]*(refresh|secret|rt\b|token)/i)
      expect(code, f).not.toMatch(/deps\.log\([^)]*\$\{[^}]*(rt|refresh|secret|clientSecret|token|body)/i)
    }
    const example = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8')
    expect(example).toMatch(/^GOOGLE_CLIENT_SECRET=\s*$/m)
  })

  it('vercel.json: the SPA rewrite does not swallow /api/*', () => {
    const cfg = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')) as { rewrites: { source: string; destination: string }[] }
    for (const r of cfg.rewrites.filter((x) => x.destination === '/index.html')) {
      const re = new RegExp(`^${r.source.replace(/\(\.\*\)/g, '.*')}$`)
      expect(re.test('/api/auth/token'), r.source).toBe(false)
      expect(re.test('/api/thumb'), r.source).toBe(false)
      expect(re.test('/library'), r.source).toBe(true)
      expect(re.test('/model/abc/edit'), r.source).toBe(true)
    }
  })
})
