// @vitest-environment node
/**
 * Acceptance tests for brief Addendum v0.4 — the /api functions, tested from the outside: a browser (cookie jar)
 * sends Requests to the real handlers; Google is the scripted fake in google-world.ts. AC19, AC20, AC23, AC24.
 * Expected behaviour comes only from the brief (v0.4 D-G, D-H, "Endpoints", AC19–AC24).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import callbackFn from '../../api/auth/callback'
import loginFn from '../../api/auth/login'
import logoutFn from '../../api/auth/logout'
import tokenFn from '../../api/auth/token'
import thumbFn from '../../api/thumb'
import { Browser, bytes, CLIENT_SECRET, FOUNDER, GoogleWorld, ORIGIN, SESSION_COOKIE_NAME } from './google-world'

const HEBREW = /[֐-׿]/
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7])
const HEIC = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])

function post(browser: Browser, path: string, origin: string | null = ORIGIN) {
  return browser.request(path, { method: 'POST', origin })
}

function sessionSetCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
}

/** A session Set-Cookie that actually stores something (not a clearing one). */
function storesSession(res: Response): boolean {
  const c = sessionSetCookie(res)
  return !!c && !/^rubedo_session=;/.test(c) && !/Max-Age=0\b/i.test(c)
}

async function signedIn(world = new GoogleWorld()) {
  const browser = new Browser(world)
  const cb = await browser.signInAtGoogle()
  expect(cb.status).toBe(302)
  expect(browser.hasSession()).toBe(true)
  return { world, browser }
}

function tokenCalls(world: GoogleWorld): number {
  return world.calls.filter((c) => c.url === 'https://oauth2.googleapis.com/token').length
}

// ---------------------------------------------------------------------------------------------
describe('AC19 — a non-allowed Google account is rejected at callback; no session cookie is set', () => {
  it('AC19.other-account: another Google account → Hebrew error page, no session cookie, /api/auth/token stays 401', async () => {
    const world = new GoogleWorld()
    const browser = new Browser(world)
    const res = await browser.signInAtGoogle('someone.else@example.com')
    expect(res.status).not.toBe(302)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.headers.get('Content-Type') ?? '').toMatch(/text\/html/)
    const html = await res.text()
    expect(html).toMatch(HEBREW)
    expect(storesSession(res)).toBe(false)
    expect(browser.hasSession()).toBe(false)
    expect((await post(browser, '/api/auth/token')).status).toBe(401)
  })

  it('AC19.allowed-account (control): the default ALLOWED_EMAIL raztz2@gmail.com gets a session and a 302 to /', async () => {
    const browser = new Browser(new GoogleWorld())
    const res = await browser.signInAtGoogle(FOUNDER)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/')
    expect(storesSession(res)).toBe(true)
    const tok = await post(browser, '/api/auth/token')
    expect(tok.status).toBe(200)
    expect(((await tok.json()) as { email: string }).email).toBe(FOUNDER)
  })

  it('AC19.env: ALLOWED_EMAIL overrides the default — then the Founder\'s default account is rejected too', async () => {
    const world = new GoogleWorld({ ALLOWED_EMAIL: 'studio.owner@example.com' })
    const founder = new Browser(world)
    const r1 = await founder.signInAtGoogle(FOUNDER)
    expect(r1.status).not.toBe(302)
    expect(storesSession(r1)).toBe(false)
    expect(founder.hasSession()).toBe(false)
    const owner = new Browser(world)
    const r2 = await owner.signInAtGoogle('studio.owner@example.com')
    expect(r2.status).toBe(302)
    expect(owner.hasSession()).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC20 — /api/auth/token: no cookie → 401; tampered cookie → 401 + cleared; cross-origin Origin → 403', () => {
  it('AC20.ok: valid session → 200 {access_token, expires_in, email}, Cache-Control no-store; the token works at Google', async () => {
    const { world, browser } = await signedIn()
    const res = await post(browser, '/api/auth/token')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control') ?? '').toMatch(/no-store/)
    const body = (await res.json()) as { access_token: string; expires_in: number; email: string }
    expect(Object.keys(body).sort()).toEqual(['access_token', 'email', 'expires_in'])
    expect(world.accessTokens.has(body.access_token)).toBe(true)
    expect(body.expires_in).toBeGreaterThan(0)
    expect(body.email).toBe(FOUNDER)
    // Without an Origin header (brief: only a PRESENT and different Origin is rejected).
    expect((await post(browser, '/api/auth/token', null)).status).toBe(200)
  })

  it('AC20.no-cookie: → 401 JSON, no call to Google', async () => {
    const world = new GoogleWorld()
    const browser = new Browser(world)
    const res = await post(browser, '/api/auth/token')
    expect(res.status).toBe(401)
    expect(res.headers.get('Content-Type') ?? '').toMatch(/application\/json/)
    expect(res.headers.get('Cache-Control') ?? '').toMatch(/no-store/)
    await res.json() // valid JSON
    expect(world.calls).toEqual([])
  })

  it('AC20.tampered: a modified session cookie → 401 and the cookie is cleared (Path=/api); Google is not asked', async () => {
    const { world, browser } = await signedIn()
    const v = browser.jar.get(SESSION_COOKIE_NAME)!.value
    const i = Math.floor(v.length / 2)
    browser.jar.set(SESSION_COOKIE_NAME, { value: v.slice(0, i) + (v[i] === 'A' ? 'B' : 'A') + v.slice(i + 1), path: '/api' })
    const before = tokenCalls(world)
    const res = await post(browser, '/api/auth/token')
    expect(res.status).toBe(401)
    const clear = sessionSetCookie(res)
    expect(clear, 'cookie cleared').toBeTruthy()
    expect(clear).toMatch(/Max-Age=0\b/i)
    expect(clear).toMatch(/Path=\/api(;|$)/)
    expect(browser.hasSession()).toBe(false)
    expect(tokenCalls(world)).toBe(before)
  })

  it('AC20.tampered-variants: garbage value, truncated value, and a cookie sealed with another key → 401 + cleared', async () => {
    const other = await signedIn(new GoogleWorld({ GOOGLE_CLIENT_SECRET: 'acceptance-other-fake-secret' }))
    const foreignValue = other.browser.jar.get(SESSION_COOKIE_NAME)!.value
    const { browser } = await signedIn()
    const good = browser.jar.get(SESSION_COOKIE_NAME)!.value
    for (const [label, value] of [
      ['garbage', 'not-a-session'],
      ['truncated', good.slice(0, good.length - 6)],
      ['other key', foreignValue],
    ] as const) {
      browser.jar.set(SESSION_COOKIE_NAME, { value, path: '/api' })
      const res = await post(browser, '/api/auth/token')
      expect(res.status, label).toBe(401)
      expect(sessionSetCookie(res) ?? '', label).toMatch(/Max-Age=0\b/i)
      expect(browser.hasSession(), label).toBe(false)
    }
  })

  it('AC20.cross-origin: an Origin other than the app → 403 (no token minted, session kept); same origin → 200', async () => {
    const { world, browser } = await signedIn()
    const before = tokenCalls(world)
    for (const origin of ['https://evil.example', 'null', 'http://rubedo-app.test', 'https://rubedo-app.test.evil.example']) {
      const res = await post(browser, '/api/auth/token', origin)
      expect(res.status, origin).toBe(403)
      expect(await res.text(), origin).not.toMatch(/at-acceptance/)
    }
    expect(tokenCalls(world)).toBe(before)
    expect(browser.hasSession()).toBe(true)
    expect((await post(browser, '/api/auth/token', ORIGIN)).status).toBe(200)
  })

  it('AC20.revoked: a refresh token revoked at Google → 401 and the cookie cleared', async () => {
    const { world, browser } = await signedIn()
    for (const r of world.refreshTokens.values()) r.revoked = true
    const res = await post(browser, '/api/auth/token')
    expect(res.status).toBe(401)
    expect(browser.hasSession()).toBe(false)
  })

  it('AC20.wiring: the Vercel entry files route to the right handlers (method checks answer before any config/network)', async () => {
    const r = (path: string, method: string) => new Request(`${ORIGIN}${path}`, { method })
    expect((await tokenFn.fetch(r('/api/auth/token', 'GET'))).status).toBe(405)
    expect((await logoutFn.fetch(r('/api/auth/logout', 'GET'))).status).toBe(405)
    expect((await loginFn.fetch(r('/api/auth/login', 'POST'))).status).toBe(405)
    expect((await callbackFn.fetch(r('/api/auth/callback', 'POST'))).status).toBe(405)
    expect((await thumbFn.fetch(r('/api/thumb?id=bad', 'GET'))).status).toBe(400)
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC23 — /api/thumb returns an image for a HEIC file\'s thumbnail, rejects invalid ids and non-Google hosts', () => {
  async function withHeic() {
    const s = await signedIn()
    const root = s.world.addFolder('drive-root', 'models')
    const folder = s.world.addFolder(root, 'Owl lamp')
    const heic = s.world.addFile(folder, 'IMG_0001.HEIC', HEIC, 'image/heic', { thumbnail: { bytes: PNG, type: 'image/png' } })
    return { ...s, folder, heic }
  }

  it('AC23.heic: → 200 image bytes of Drive\'s thumbnail, sized as asked, Cache-Control private max-age=3600', async () => {
    const { world, browser, heic } = await withHeic()
    const res = await browser.request(`/api/thumb?id=${heic}&s=400`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
    const fetched = world.calls.filter((c) => c.url.startsWith('https://lh3.googleusercontent.com/'))
    expect(fetched.map((c) => c.url)).toEqual([`https://lh3.googleusercontent.com/drive-thumb/${heic}=s400`])
    // Fetched server-side with the session's access token (the browser never had to send one).
    expect(world.accessTokens.has((fetched[0].headers.authorization ?? '').replace(/^Bearer /, ''))).toBe(true)
  })

  it('AC23.size: s is clamped to 64–1600', async () => {
    const { world, browser, heic } = await withHeic()
    for (const [s, want] of [
      ['5000', 1600],
      ['10', 64],
      ['1600', 1600],
      ['64', 64],
    ] as const) {
      const n = world.calls.length
      const res = await browser.request(`/api/thumb?id=${heic}&s=${s}`)
      expect(res.status, `s=${s}`).toBe(200)
      const url = world.calls.slice(n).find((c) => c.url.startsWith('https://lh3.googleusercontent.com/'))?.url
      expect(url, `s=${s}`).toBe(`https://lh3.googleusercontent.com/drive-thumb/${heic}=s${want}`)
    }
  })

  it('AC23.invalid-id: ids not matching ^[A-Za-z0-9_-]{10,}$ → 400 and nothing is sent to Google', async () => {
    const { world, browser } = await withHeic()
    for (const id of ['', 'short_id1', '../../etc/passwd', 'abc%20defghijk', "abcdefghij'or'1", 'abcdefghij%2F..%2Fx', 'abcdefghij.png', 'x'.repeat(9)]) {
      const n = world.calls.length
      const res = await browser.request(`/api/thumb?id=${id}&s=400`)
      expect(res.status, `id=${id}`).toBe(400)
      expect(world.calls.length, `id=${id}: no request to Google`).toBe(n)
    }
    expect((await browser.request('/api/thumb?s=400')).status).toBe(400)
  })

  it('AC23.ssrf: thumbnail links on non-Google hosts (or a redirect to one) are never fetched; no image is returned', async () => {
    const { world, browser, folder } = await withHeic()
    const bad = [
      'https://evil.example/steal=s220',
      'https://googleusercontent.com.evil.example/x=s220',
      'https://lh3.googleusercontent.com@evil.example/x=s220',
      'http://lh3.googleusercontent.com/drive-thumb/abc=s220',
      'https://169.254.169.254/latest/meta-data=s220',
      'https://notgoogle.com/x=s220',
    ]
    for (const link of bad) {
      const id = world.addFile(folder, 'photo.heic', HEIC, 'image/heic', { thumbnailLink: link })
      const res = await browser.request(`/api/thumb?id=${id}&s=400`)
      expect(res.status, link).not.toBe(200)
      expect(res.headers.get('Content-Type') ?? '', link).not.toMatch(/^image\//)
    }
    // Redirect from the Google host to another host.
    const redirected = world.addFile(folder, 'r.heic', HEIC, 'image/heic', { thumbnail: { bytes: PNG, type: 'image/png' } })
    world.thumbRedirects.set(redirected, 'https://evil.example/after-redirect')
    const res = await browser.request(`/api/thumb?id=${redirected}&s=400`)
    expect(res.status).not.toBe(200)

    const offHost = world.calls.filter((c) => {
      const u = new URL(c.url)
      const h = u.hostname
      const google = h === 'googleusercontent.com' || h.endsWith('.googleusercontent.com') || h === 'google.com' || h.endsWith('.google.com') || h.endsWith('.googleapis.com')
      return !google || u.protocol !== 'https:'
    })
    expect(offHost.map((c) => c.url)).toEqual([])
  })

  it('AC23.session-and-missing: no session → 401; a file without thumbnail or unknown id → 404', async () => {
    const { world, browser, folder, heic } = await withHeic()
    const anon = new Browser(world)
    expect((await anon.request(`/api/thumb?id=${heic}&s=400`)).status).toBe(401)
    const noThumb = world.addFile(folder, 'part.stl', bytes('solid'), 'model/stl')
    expect((await browser.request(`/api/thumb?id=${noThumb}&s=400`)).status).toBe(404)
    expect((await browser.request('/api/thumb?id=unknown_file_id_123&s=400')).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------------------------
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: process.cwd(), encoding: 'utf8' }).split('\0').filter(Boolean)
}

/** Credential formats that must never be committed (patterns assembled so this file itself never matches). */
const LEAK_PATTERNS: [string, RegExp][] = [
  ['Google OAuth client secret', new RegExp(['GOC', 'SPX-[A-Za-z0-9_-]{10,}'].join(''))],
  ['Google access token', new RegExp(['ya', '29\\.[A-Za-z0-9_-]{30,}'].join(''))],
  ['Google refresh token', new RegExp(['1/', '/0[A-Za-z0-9_-]{30,}'].join(''))],
  ['private key', new RegExp(['-----BEGIN ', '(RSA |EC )?PRIVATE KEY-----'].join(''))],
]

describe('AC24 — no secret or refresh token is ever sent to the browser JS, logged, or committed', () => {
  it('AC24.sweep: every endpoint, success and failure paths → no client secret / refresh token in any response (body, headers, cookies) or log line', async () => {
    const world = new GoogleWorld()
    const b = new Browser(world)
    const root = world.addFolder('drive-root', 'models')
    const heic = world.addFile(root, 'IMG.HEIC', HEIC, 'image/heic', { thumbnail: { bytes: PNG, type: 'image/png' } })
    const evil = world.addFile(root, 'evil.heic', HEIC, 'image/heic', { thumbnailLink: 'https://evil.example/x=s220' })

    // Failures before and around sign-in.
    await b.request('/api/auth/callback?error=access_denied')
    await b.request('/api/auth/callback?code=x&state=y')
    await b.signInAtGoogle('someone.else@example.com')
    await b.signInAtGoogle(FOUNDER, { withRefreshToken: false })
    await b.signInAtGoogle(FOUNDER, { tamperState: true })
    await b.signInAtGoogle(FOUNDER, { grantedScope: 'openid email' })
    await post(b, '/api/auth/token')
    await b.request(`/api/thumb?id=${heic}`)
    // Happy paths.
    await b.signInAtGoogle(FOUNDER)
    await post(b, '/api/auth/token')
    world.rotateOnNextRefresh = true
    await post(b, '/api/auth/token') // Google rotates the refresh token
    await post(b, '/api/auth/token')
    await post(b, '/api/auth/token', 'https://evil.example')
    await b.request(`/api/thumb?id=${heic}&s=300`)
    await b.request(`/api/thumb?id=${evil}&s=300`)
    await b.request('/api/thumb?id=../x')
    world.tokenEndpointDown = true
    await post(b, '/api/auth/token') // Google down → 502
    world.tokenEndpointDown = false
    await b.request('/api/auth/token') // wrong method
    await post(b, '/api/auth/logout')
    // Session revoked at Google + a tampered cookie.
    await b.signInAtGoogle(FOUNDER)
    for (const r of world.refreshTokens.values()) r.revoked = true
    await post(b, '/api/auth/token')
    await b.signInAtGoogle(FOUNDER)
    b.jar.set(SESSION_COOKIE_NAME, { value: `${b.jar.get(SESSION_COOKIE_NAME)!.value}x`, path: '/api' })
    await post(b, '/api/auth/token')

    const rts = [...world.refreshTokens.keys()]
    expect(rts.length).toBeGreaterThanOrEqual(5) // incl. the other account's and the rotated one
    const secrets = [CLIENT_SECRET, ...rts]
    const variants = secrets.flatMap((s) => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), encodeURIComponent(s)])

    expect(b.exchanges.length).toBeGreaterThan(20)
    for (const e of b.exchanges) {
      const seen = `${e.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}\n${e.setCookies.join('\n')}\n${e.body}`
      for (const v of variants) expect(seen.includes(v), `${e.method} ${e.path} (${e.status}) leaks a secret/refresh token`).toBe(false)
    }
    const logs = world.logs.join('\n')
    for (const v of variants) expect(logs.includes(v), 'log leaks a secret/refresh token').toBe(false)
    // Access tokens are credentials too: never logged.
    for (const at of world.accessTokens.keys()) expect(logs.includes(at), 'log leaks an access token').toBe(false)
  })

  it('AC24.js-visible: through the SPA\'s fetch (Set-Cookie hidden like a browser), token/logout answers never contain a refresh token', async () => {
    const { world, browser } = await signedIn()
    world.rotateOnNextRefresh = true
    for (let i = 0; i < 3; i++) await browser.spaFetch('/api/auth/token', { method: 'POST', credentials: 'same-origin' })
    await browser.spaFetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
    expect(browser.seenByJs.length).toBe(4)
    for (const s of browser.seenByJs) {
      for (const rt of world.refreshTokens.keys()) expect(`${s.headers}\n${s.body}`).not.toContain(rt)
      expect(`${s.headers}\n${s.body}`).not.toContain(CLIENT_SECRET)
    }
  })

  it('AC24.repo: no .env file committed (except .env.example, which holds no values for secrets); no credential patterns in any tracked file or in git history', () => {
    const files = trackedFiles()
    expect(files.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !/(^|\/)\.env\.example$/.test(f))).toEqual([])
    expect(files.filter((f) => /^(dist|\.vercel|node_modules)\//.test(f))).toEqual([])

    const example = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8')
    for (const line of example.split('\n')) {
      if (/^\s*#/.test(line) || !line.includes('=')) continue
      const [k, v] = [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]
      if (/SECRET|TOKEN|PASSWORD|PRIVATE/i.test(k)) expect(v, `${k} has a value in .env.example`).toBe('')
      expect(/^VITE_.*(SECRET|TOKEN|PASSWORD|PRIVATE)/i.test(k), `${k}: a VITE_ variable is bundled into browser JS`).toBe(false)
    }

    const hits: string[] = []
    for (const f of files) {
      let text: string
      try {
        text = readFileSync(resolve(process.cwd(), f)).toString('latin1')
      } catch {
        continue // deleted in the working tree
      }
      for (const [label, re] of LEAK_PATTERNS) if (re.test(text)) hits.push(`${f}: ${label}`)
      if (/import\.meta\.env\.[A-Z_]*SECRET/.test(text)) hits.push(`${f}: secret read through import.meta.env (would be bundled)`)
    }
    expect(hits).toEqual([])

    const history = execFileSync('git', ['log', '--all', '-p', '--no-color', '--no-ext-diff'], { cwd: process.cwd(), encoding: 'latin1', maxBuffer: 512 * 1024 * 1024 })
    expect(LEAK_PATTERNS.filter(([, re]) => re.test(history)).map(([l]) => l)).toEqual([])
  })
})
