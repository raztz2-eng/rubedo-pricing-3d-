import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXPIRY_MARGIN_MS, RECONNECT_MESSAGE, SessionAuth, SessionGoneError } from '../../src/lib/auth/sessionAuth'

const TOKEN = 'fake-access-SESSION-TOKEN'

type Answer = () => Response | Promise<Response>

function backend(first: Answer = () => Response.json({ access_token: TOKEN, expires_in: 3600, email: 'raztz2@gmail.com' })) {
  const calls: { url: string; init: RequestInit }[] = []
  let answer: Answer = first
  let n = 0
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init })
    if (String(input) === '/api/auth/token') {
      n += 1
      return answer()
    }
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  return {
    calls,
    fetchImpl,
    tokenCalls: () => n,
    set(a: Answer) {
      answer = a
    },
  }
}

const ok = (t = TOKEN, expiresIn = 3600) => () => Response.json({ access_token: t, expires_in: expiresIn, email: 'raztz2@gmail.com' })
const gone = () => Response.json({ error: 'no_session' }, { status: 401 })

function make(b = backend(), clock = { t: 1_000_000 }, popup: unknown = {}) {
  const navigate = vi.fn()
  const openWindow = vi.fn(() => popup)
  const auth = new SessionAuth({ fetchImpl: b.fetchImpl, navigate, openWindow, now: () => clock.t, log: () => {} })
  return { auth, navigate, openWindow, b, clock }
}

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('SessionAuth — start-up (AC18)', () => {
  it('a valid session cookie signs in with NO click: POST /api/auth/token, same-origin credentials', async () => {
    const { auth, b, navigate } = make()
    expect(auth.checking).toBe(true)
    const events: boolean[] = []
    auth.subscribe((s) => events.push(s))
    await auth.init()
    expect(auth.signedIn).toBe(true)
    expect(auth.checking).toBe(false)
    expect(auth.email).toBe('raztz2@gmail.com')
    expect(events).toContain(true)
    expect(b.calls[0].url).toBe('/api/auth/token')
    expect(b.calls[0].init.method).toBe('POST')
    expect(b.calls[0].init.credentials).toBe('same-origin')
    expect(navigate).not.toHaveBeenCalled()
    expect(await auth.getToken()).toBe(TOKEN)
    expect(b.tokenCalls()).toBe(1)
  })

  it('no session (401) → signed out quietly (no error, no navigation)', async () => {
    const { auth, navigate } = make(backend(gone))
    await auth.init()
    expect(auth.signedIn).toBe(false)
    expect(auth.needsReconnect).toBe(false)
    expect(auth.lastError).toBeNull()
    expect(navigate).not.toHaveBeenCalled()
    await expect(auth.getToken()).rejects.toThrow()
  })

  it('server trouble at start-up → signed out with a Hebrew error (not a crash)', async () => {
    const b = backend(() => Response.json({ error: 'server_misconfigured', message: 'השרת לא מוגדר' }, { status: 500 }))
    const { auth } = make(b)
    await auth.init()
    expect(auth.signedIn).toBe(false)
    expect(auth.lastError).toBe('השרת לא מוגדר')
    const net = backend(() => {
      throw new TypeError('Failed to fetch')
    })
    const m = make(net)
    await m.auth.init()
    expect(m.auth.lastError).toMatch(/[א-ת]/)
  })
})

describe('SessionAuth — sign-in / sign-out', () => {
  it('sign-in is a full-page navigation to /api/auth/login (no popup)', async () => {
    const { auth, navigate } = make(backend(gone))
    await auth.init()
    await auth.signIn()
    expect(navigate).toHaveBeenCalledWith('/api/auth/login')
  })

  it('sign-out clears the token, POSTs /api/auth/logout and a late token answer cannot sign back in', async () => {
    let release: (r: Response) => void = () => {}
    const b = backend()
    const { auth } = make(b)
    await auth.init()
    b.set(() => new Promise<Response>((r) => (release = r)))
    const pending = auth.refresh().catch((e: unknown) => e)
    auth.signOut()
    expect(auth.signedIn).toBe(false)
    expect(b.calls.some((c) => c.url === '/api/auth/logout' && c.init.method === 'POST')).toBe(true)
    release(Response.json({ access_token: 'LATE', expires_in: 3600 }))
    await pending
    expect(auth.signedIn).toBe(false)
    await expect(auth.getToken()).rejects.toThrow()
  })
})

describe('SessionAuth — renewal', () => {
  it('parallel callers share ONE in-flight request', async () => {
    const b = backend()
    const { auth } = make(b)
    await auth.init()
    let release: (r: Response) => void = () => {}
    b.set(() => new Promise<Response>((r) => (release = r)))
    const all = Promise.all([auth.refresh(), auth.refresh(), auth.getToken(), auth.refresh()])
    release(Response.json({ access_token: 'T2', expires_in: 3600 }))
    expect(await all).toEqual(['T2', 'T2', 'T2', 'T2'])
    expect(b.tokenCalls()).toBe(2) // init + one shared renewal
  })

  it('renews ≈5 minutes before expiry, not earlier', async () => {
    const b = backend(ok('T1', 3600))
    const { auth, clock } = make(b)
    await auth.init()
    clock.t += 3600_000 - EXPIRY_MARGIN_MS - 1000
    expect(await auth.getToken()).toBe('T1')
    expect(b.tokenCalls()).toBe(1)
    b.set(ok('T2'))
    clock.t += 2000
    expect(await auth.getToken()).toBe('T2')
    expect(b.tokenCalls()).toBe(2)
  })

  it('session gone while working (401) → "needs reconnect", nothing signed out, no navigation', async () => {
    const b = backend()
    const { auth, navigate } = make(b)
    await auth.init()
    b.set(gone)
    const err = await auth.refresh().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionGoneError)
    expect((err as SessionGoneError).userMessage).toBe(RECONNECT_MESSAGE)
    expect(auth.needsReconnect).toBe(true)
    expect(auth.signedIn).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    // While disconnected, Drive calls fail fast (no hammering of the endpoint).
    await expect(auth.getToken()).rejects.toMatchObject({ userMessage: RECONNECT_MESSAGE })
    expect(b.tokenCalls()).toBe(2)
  })

  it('I4 reconnect click: opens /api/auth/login?popup=1 SYNCHRONOUSLY (no navigation, the page stays); retry() after the popup → signed in', async () => {
    const b = backend()
    const { auth, navigate, openWindow } = make(b)
    await auth.init()
    b.set(gone)
    await auth.refresh().catch(() => {})
    expect(auth.needsReconnect).toBe(true)

    void auth.signIn() // the click
    expect(openWindow).toHaveBeenCalledTimes(1) // before any await
    expect(openWindow).toHaveBeenCalledWith('/api/auth/login?popup=1')
    expect(navigate).not.toHaveBeenCalled()

    // Popup not finished yet: retry keeps "needs reconnect".
    await expect(auth.retry()).rejects.toBeInstanceOf(SessionGoneError)
    expect(auth.needsReconnect).toBe(true)
    // The popup set a new session cookie: retry (focus / "המשך") → signed in, same page.
    b.set(ok('T5'))
    await auth.retry()
    expect(auth.signedIn).toBe(true)
    expect(await auth.getToken()).toBe('T5')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('I4 popup blocked → Hebrew error, still "needs reconnect", no navigation', async () => {
    const b = backend()
    const { auth, navigate } = make(b, { t: 1_000_000 }, null)
    await auth.init()
    b.set(gone)
    await auth.refresh().catch(() => {})
    await auth.signIn()
    expect(auth.lastError).toMatch(/חסם/)
    expect(auth.needsReconnect).toBe(true)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('first sign-in from signed out still navigates (no popup)', async () => {
    const { auth, navigate, openWindow } = make(backend(gone))
    await auth.init()
    await auth.signIn()
    expect(navigate).toHaveBeenCalledWith('/api/auth/login')
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('M10: sign-out while the token body is still being read → the late answer cannot sign back in', async () => {
    const b = backend()
    const { auth } = make(b)
    await auth.init()
    let releaseBody: (v: unknown) => void = () => {}
    b.set(() => {
      const res = new Response('{}', { status: 200 })
      Object.defineProperty(res, 'json', { value: () => new Promise((r) => (releaseBody = r)) })
      return res
    })
    const pending = auth.refresh().catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 0))
    auth.signOut()
    releaseBody({ access_token: 'LATE-BODY', expires_in: 3600 })
    await pending
    expect(auth.signedIn).toBe(false)
    await expect(auth.getToken()).rejects.toThrow()
  })

  it('reconnect click during a network failure stays on the page (form kept); retry reports the error', async () => {
    const b = backend()
    const { auth, navigate } = make(b)
    await auth.init()
    b.set(gone)
    await auth.refresh().catch(() => {})
    b.set(() => {
      throw new TypeError('offline')
    })
    await expect(auth.retry()).rejects.toThrow()
    expect(navigate).not.toHaveBeenCalled()
    expect(auth.needsReconnect).toBe(true)
  })

  it('network error while signed in does not end the session', async () => {
    const b = backend()
    const { auth } = make(b)
    await auth.init()
    b.set(() => {
      throw new TypeError('offline')
    })
    await expect(auth.refresh()).rejects.toThrow()
    expect(auth.needsReconnect).toBe(false)
    b.set(ok('T4'))
    expect(await auth.refresh()).toBe('T4')
  })

  it('a Drive 401 that survives the refresh (onUnauthorized) → "needs reconnect"', async () => {
    const { auth } = make()
    await auth.init()
    auth.onUnauthorized()
    expect(auth.needsReconnect).toBe(true)
  })
})

describe('SessionAuth — AC24: the access token is never persisted by the SPA', () => {
  it('nothing in localStorage/sessionStorage/document.cookie', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { auth } = make()
    await auth.init()
    await auth.refresh()
    for (const call of setItem.mock.calls) expect(String(call[1])).not.toContain('fake-access')
    expect(document.cookie).not.toContain('fake-access')
    setItem.mockRestore()
  })
})

describe('v0.5 Q5 — granted scopes', () => {
  const GMAIL = 'https://www.googleapis.com/auth/gmail.compose'
  const DRIVE = 'https://www.googleapis.com/auth/drive'
  const withScopes = (scopes: unknown) => () => Response.json({ access_token: TOKEN, expires_in: 3600, email: 'raztz2@gmail.com', scopes })

  it('keeps the scopes reported by /api/auth/token (memory only); unknown when absent; cleared on sign-out', async () => {
    const { auth, b } = make(backend(withScopes([DRIVE])))
    await auth.init()
    expect(auth.scopes).toEqual([DRIVE])
    b.set(withScopes('not-a-list'))
    await auth.refresh()
    expect(auth.scopes).toBeNull()
    b.set(ok())
    await auth.refresh()
    expect(auth.scopes).toBeNull()
    auth.signOut()
    expect(auth.scopes).toBeNull()
    expect(JSON.stringify({ ...localStorage })).not.toContain(GMAIL)
  })

  it('extra permission: reconnect() opens the popup synchronously; recheck() then picks up gmail.compose and notifies', async () => {
    const { auth, b, openWindow } = make(backend(withScopes([DRIVE])))
    await auth.init()
    const seen: boolean[] = []
    auth.subscribe((s) => seen.push(s))
    auth.reconnect()
    expect(openWindow).toHaveBeenCalledWith('/api/auth/login?popup=1')
    b.set(withScopes([DRIVE, GMAIL]))
    await auth.recheck()
    expect(auth.scopes).toEqual([DRIVE, GMAIL])
    expect(auth.signedIn).toBe(true)
    expect(seen.at(-1)).toBe(true)
  })
})
