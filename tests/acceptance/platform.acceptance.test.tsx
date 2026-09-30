/**
 * AC12 (amended by Addendum v0.4, D-F/D-G) and AC13.
 * AC12 now: the SPA keeps the Google access token in memory only (never localStorage/sessionStorage/cookies), the
 * refresh token lives only in the encrypted HttpOnly session cookie and never reaches browser JS; the login asks for
 * exactly `openid email drive` (D-F). Tested end-to-end: real SessionAuth + GoogleDriveStore + real /api handlers,
 * against a fake Google (google-world.ts).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addManualPart, newServices, renderApp, saveButton, setValue } from './helpers'
import { Browser, CLIENT_ID, DRIVE_SCOPE, GoogleWorld, ORIGIN, SESSION_COOKIE_NAME } from './google-world'
import { allPersisted, sessionServices } from './session-helpers'

const MODELS_FOLDER_KEY = 'rubedo.modelsFolderId'
const SIGN_IN = 'התחברות עם Google'
const SIGNED_IN = 'מחובר ל-Google'
const SIGN_OUT = 'התנתקות'

function srcFiles(dir = resolve(process.cwd(), 'src')): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? srcFiles(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })
}

function sessionSetCookies(browser: Browser): string[] {
  return browser.exchanges.flatMap((e) => e.setCookies).filter((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && !/Max-Age=0\b/i.test(c))
}

// ---------------------------------------------------------------------------------------------
describe('AC12 (amended by addendum v0.4 D-F/D-G) — access token in memory only; the refresh token never reaches browser JS', () => {
  afterEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('AC12.ui: header sign-in → Google → back signed in; token never in local/sessionStorage/cookies; refresh token never visible to JS; sign-out ends the session', async () => {
    const world = new GoogleWorld()
    const root = world.addFolder('founder-drive-root', 'models')
    world.addFolder(root, 'Owl lamp')
    localStorage.setItem(MODELS_FOLDER_KEY, root)
    const browser = new Browser(world)

    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const cookieWrites: string[] = []
    const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
    vi.spyOn(document, 'cookie', 'set').mockImplementation((v: string) => {
      cookieWrites.push(v)
      cookieDesc?.set?.call(document, v)
    })

    const user = userEvent.setup()
    let services = sessionServices(browser)
    renderApp(services, '/')
    await user.click((await screen.findAllByRole('button', { name: SIGN_IN }))[0])
    // Full-page redirect to the backend (no popup).
    expect(services.navigations).toEqual(['/api/auth/login'])

    // The browser leaves the app: Google consent → /api/auth/callback → 302 back to "/".
    const cb = await browser.signInAtGoogle()
    expect(cb.status).toBe(302)
    expect(cb.headers.get('Location')).toBe('/')
    expect(browser.hasSession()).toBe(true)

    // The app loads again: signed in, Drive works with the minted access token.
    cleanup()
    services = sessionServices(browser)
    renderApp(services, '/library')
    await screen.findByText(SIGNED_IN)
    await waitFor(() => expect(screen.getAllByTestId('library-card').some((c) => (c.textContent ?? '').includes('Owl lamp'))).toBe(true))
    const token = await services.auth.getToken()
    expect(world.accessTokens.has(token), 'token was minted by Google via /api/auth/token').toBe(true)

    // Access token: memory only.
    expect(allPersisted()).not.toContain(token)
    for (const call of setItem.mock.calls) expect(String(call[1])).not.toContain(token)
    for (const c of cookieWrites) expect(c).not.toContain(token)
    expect(localStorage.getItem(MODELS_FOLDER_KEY)).toBe(root) // the only thing persisted: a folder ID

    // Refresh token: only inside the encrypted HttpOnly cookie, never in anything JS could read.
    const rts = [...world.refreshTokens.keys()]
    expect(rts).toHaveLength(1)
    const rt = rts[0]
    expect(browser.seenByJs.length).toBeGreaterThan(0)
    for (const seen of browser.seenByJs) {
      expect(`${seen.headers}\n${seen.body}`, `${seen.method} ${seen.path}`).not.toContain(rt)
      expect(seen.headers.toLowerCase(), 'no Set-Cookie readable by JS').not.toContain('set-cookie')
    }
    const session = sessionSetCookies(browser)
    expect(session.length).toBeGreaterThan(0)
    for (const sc of session) {
      expect(sc).toMatch(/;\s*HttpOnly/i)
      expect(sc).toMatch(/;\s*Secure/i)
      expect(sc).toMatch(/;\s*SameSite=Lax/i)
      expect(sc).toMatch(/;\s*Path=\/api(;|$)/)
      expect(sc).toMatch(/;\s*Max-Age=15552000(;|$)/) // 180 days
      expect(sc).not.toContain(rt)
      expect(sc).not.toContain(Buffer.from(rt).toString('base64url'))
      expect(sc).not.toContain(Buffer.from(rt).toString('base64'))
    }
    expect(document.cookie).not.toContain(SESSION_COOKIE_NAME)
    expect(allPersisted()).not.toContain(rt)
    for (const call of setItem.mock.calls) expect(String(call[1])).not.toContain(rt)

    // Sign-out: the session cookie is cleared, the refresh token revoked at Google, no more tokens.
    await user.click(screen.getByRole('button', { name: SIGN_OUT }))
    await screen.findAllByRole('button', { name: SIGN_IN })
    await waitFor(() => expect(browser.hasSession()).toBe(false))
    await waitFor(() => expect(world.refreshTokens.get(rt)?.revoked).toBe(true))
    await expect(services.auth.getToken()).rejects.toThrow()

    // Reload after sign-out: signed out.
    cleanup()
    services = sessionServices(browser)
    renderApp(services, '/')
    await screen.findAllByRole('button', { name: SIGN_IN })
    expect(services.auth.signedIn).toBe(false)
  })

  it('AC12.scope (D-F): /api/auth/login asks Google for exactly openid + email + drive, offline, consent, no inherited scopes; state is random and in an HttpOnly cookie', async () => {
    const browser = new Browser(new GoogleWorld())
    const first = await browser.request('/api/auth/login')
    expect(first.status).toBe(302)
    const loc = new URL(first.headers.get('Location') ?? '')
    expect(`${loc.origin}${loc.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const p = loc.searchParams
    expect((p.get('scope') ?? '').trim().split(/\s+/).sort()).toEqual(['email', 'openid', DRIVE_SCOPE].sort())
    expect(p.get('access_type')).toBe('offline')
    expect(p.get('prompt')).toBe('consent')
    expect(p.get('include_granted_scopes')).toBe('false')
    expect(p.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback`)
    expect(p.get('client_id')).toBe(CLIENT_ID)
    expect(p.get('response_type')).toBe('code')
    const state = p.get('state') ?? ''
    expect(state.length).toBeGreaterThanOrEqual(16)
    const stateCookie = first.headers.getSetCookie().find((c) => c.includes(`=${state}`))
    expect(stateCookie, 'state stored in a cookie').toBeTruthy()
    expect(stateCookie).toMatch(/;\s*HttpOnly/i)
    const second = new URL((await browser.request('/api/auth/login')).headers.get('Location') ?? '')
    expect(second.searchParams.get('state')).not.toBe(state)
  })

  it('AC12.callback-requirements: without the drive scope, without a refresh token, or with a forged state → no session', async () => {
    for (const [label, opts] of [
      ['drive scope not granted', { grantedScope: 'openid https://www.googleapis.com/auth/userinfo.email' }],
      ['no refresh token', { withRefreshToken: false }],
      ['forged state', { tamperState: true }],
    ] as const) {
      const browser = new Browser(new GoogleWorld())
      const res = await browser.signInAtGoogle(undefined, opts)
      expect(res.status, label).not.toBe(302)
      expect(browser.hasSession(), label).toBe(false)
      expect((await browser.request('/api/auth/token', { method: 'POST', origin: ORIGIN })).status, label).toBe(401)
    }
  })

  it('AC12.static: src/ never writes/reads cookies, never uses sessionStorage/indexedDB, localStorage only for the folder pointer, never handles a refresh token', () => {
    const offenders: string[] = []
    for (const f of srcFiles()) {
      const code = readFileSync(f, 'utf8')
      if (/document\.cookie/.test(code)) offenders.push(`${f}: touches document.cookie`)
      if (/sessionStorage\.setItem|indexedDB\.open/.test(code)) offenders.push(`${f}: sessionStorage/indexedDB write`)
      for (const m of code.matchAll(/localStorage\.setItem\(([^)]*)\)/g)) {
        if (!/MODELS_FOLDER_KEY/.test(m[1])) offenders.push(`${f}: localStorage.setItem(${m[1]})`)
      }
      if (/refresh_token|refreshToken/.test(code)) offenders.push(`${f}: refresh token in SPA code`)
    }
    expect(offenders).toEqual([])
    // The old GIS token client is gone (brief v0.4 "Remove GIS token client").
    const all = srcFiles().map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(all).not.toMatch(/initTokenClient|accounts\.google\.com\/gsi\/client/)
  })
})

// ---------------------------------------------------------------------------------------------
const HEBREW = /[֐-׿]/

/** Base (unprefixed = mobile) classes that force a width above 375 px. */
function wideClasses(root: HTMLElement): string[] {
  const bad: string[] = []
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') ?? '')
    for (const token of cls.split(/\s+/)) {
      if (!token || token.includes(':')) continue // responsive/state variants apply only above mobile
      let m = token.match(/^(?:min-)?w-\[(\d+(?:\.\d+)?)px\]$/)
      if (m && Number(m[1]) > 375) bad.push(token)
      m = token.match(/^(?:min-)?w-(\d+)$/)
      if (m && Number(m[1]) * 4 > 375) bad.push(token)
      m = token.match(/^grid-cols-\[(.+)\]$/)
      if (m) {
        const px = [...m[1].matchAll(/(\d+)px/g)].reduce((a, x) => a + Number(x[1]), 0)
        if (px > 375) bad.push(token)
      }
    }
    const w = el.style.width || el.style.minWidth
    if (/px$/.test(w) && parseFloat(w) > 375) bad.push(`style width ${w}`)
  }
  return bad
}

describe('AC13 — Hebrew RTL UI, usable at 375 px', () => {
  it('AC13.html: index.html declares lang="he", dir="rtl" and a device-width viewport', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
    const tag = html.match(/<html[^>]*>/)?.[0] ?? ''
    expect(tag).toMatch(/\blang="he"/)
    expect(tag).toMatch(/\bdir="rtl"/)
    expect(html).toMatch(/<meta[^>]+name="viewport"[^>]+width=device-width/)
  })

  it.each([
    ['/', 'Home'],
    ['/new', 'New model'],
    ['/library', 'Library'],
    ['/settings', 'Settings'],
  ])('AC13.page %s (%s): Hebrew headings/buttons, numeric inputs LTR, no fixed width > 375 px at mobile', async (path) => {
    const { services } = newServices()
    const { container } = renderApp(services, path)
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 }).length).toBeGreaterThan(0))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    for (const h of screen.getAllByRole('heading')) expect(h.textContent, 'heading text').toMatch(HEBREW)
    for (const b of [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')]) {
      const label = b.getAttribute('aria-label') ?? b.textContent ?? ''
      if (label.trim()) if (!/RUBEDO/.test(label)) expect(label, 'button/link label').toMatch(HEBREW)
    }
    for (const input of Array.from(container.querySelectorAll('input[type="number"]'))) {
      expect(input.getAttribute('dir')).toBe('ltr')
    }
    expect(wideClasses(container)).toEqual([])
  })

  it('AC13.model-page: saved model page has Hebrew headings and no fixed width > 375 px; wide tables scroll', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    const { container } = renderApp(services, '/new')
    setValue(await screen.findByLabelText(/^שם \*$/), 'דגם')
    await addManualPart(user, '100', '3.5')
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'דגם' })
    for (const h of screen.getAllByRole('heading')) expect(h.textContent).toMatch(HEBREW)
    expect(wideClasses(container)).toEqual([])
    for (const t of Array.from(container.querySelectorAll('table'))) {
      expect(t.closest('.overflow-x-auto') ?? t.closest('.card'), 'table container').not.toBeNull()
    }
  })

  it.skip('AC13.visual: actual rendering at 375 px (no horizontal scroll, tap targets, RTL mirroring) — NOT COVERABLE in jsdom (no layout engine); needs a real browser check', () => {})
})
