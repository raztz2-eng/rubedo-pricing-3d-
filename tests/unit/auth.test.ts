import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuthError,
  GoogleAuth,
  hasRequiredScopes,
  SCOPE_MISSING_MESSAGE,
  POPUP_BLOCKED_MESSAGE,
  POPUP_CLOSED_MESSAGE,
  RECONNECT_MESSAGE,
  REQUEST_TIMEOUT_MS,
  SIGNED_OUT_MESSAGE,
  STALE_REQUEST_MS,
  TIMEOUT_MESSAGE,
} from '../../src/lib/auth/googleAuth'
import { DRIVE_SCOPE } from '../../src/lib/config'

type Respond = (c: GoogleTokenClientConfig) => void

/** Installs a fake GIS. `respond` decides what each requestAccessToken call does (async, like the real popup). */
function installGis(respond: Respond) {
  let config: GoogleTokenClientConfig | undefined
  const requestAccessToken = vi.fn(() => {
    const c = config as GoogleTokenClientConfig
    setTimeout(() => respond(c), 0)
  })
  const revoke = vi.fn()
  window.google = {
    accounts: {
      oauth2: {
        initTokenClient: (c) => {
          config = c
          return { requestAccessToken }
        },
        revoke,
      },
    },
  }
  return { requestAccessToken, revoke, getConfig: () => config }
}

const grant =
  (token: string, expiresIn = 3600): Respond =>
  (c) =>
    c.callback({ access_token: token, expires_in: expiresIn, scope: DRIVE_SCOPE })

beforeEach(() => {
  // The GIS <script> "loads" immediately.
  vi.spyOn(document.head, 'appendChild').mockImplementation((el) => {
    queueMicrotask(() => (el as HTMLScriptElement).onload?.(new Event('load')))
    return el
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as Window).google
})

describe('scope check (AC17)', () => {
  const FILE = 'https://www.googleapis.com/auth/drive.file'
  const RO = 'https://www.googleapis.com/auth/drive.readonly'
  it('needs both drive.file and drive.readonly in the granted scopes', () => {
    expect(hasRequiredScopes(`${FILE} ${RO}`)).toBe(true)
    expect(hasRequiredScopes(`${RO}  ${FILE} email`)).toBe(true)
    expect(hasRequiredScopes(FILE)).toBe(false)
    expect(hasRequiredScopes(RO)).toBe(false)
    expect(hasRequiredScopes('')).toBe(false)
  })

  it('rejects a token when the user unticked the read permission', async () => {
    installGis((c) => c.callback({ access_token: 'T', expires_in: 3600, scope: FILE }))
    const auth = new GoogleAuth('client-id')
    await expect(auth.signIn()).rejects.toMatchObject({ userMessage: SCOPE_MISSING_MESSAGE })
    expect(auth.signedIn).toBe(false)
  })

  it('no scope broader than drive.file / drive.readonly is ever requested', () => {
    expect(DRIVE_SCOPE.split(' ').sort()).toEqual([FILE, RO])
    expect(DRIVE_SCOPE).not.toMatch(/auth\/drive(\s|$)/)
  })
})

describe('GoogleAuth (AC12)', () => {
  it('requests exactly drive.file + drive.readonly (v0.3) and keeps the token in memory only', async () => {
    const gis = installGis(grant('SECRET-TOKEN'))
    const auth = new GoogleAuth('client-id')
    await auth.signIn()

    expect(gis.getConfig()?.scope.split(' ').sort()).toEqual([
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
    ])
    expect(gis.getConfig()?.include_granted_scopes).toBe(false)
    expect(auth.signedIn).toBe(true)
    expect(await auth.getToken()).toBe('SECRET-TOKEN')

    const stored = [
      ...Object.keys(localStorage).map((k) => localStorage.getItem(k)),
      ...Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k)),
      document.cookie,
    ].join('|')
    expect(stored).not.toContain('SECRET-TOKEN')

    auth.signOut()
    expect(auth.signedIn).toBe(false)
    expect(gis.revoke).toHaveBeenCalledWith('SECRET-TOKEN')
    await expect(auth.getToken()).rejects.toThrow()
  })
})

describe('GoogleAuth — popup timing', () => {
  it('after init(), signIn() calls requestAccessToken synchronously (inside the click)', async () => {
    const gis = installGis(grant('T'))
    const auth = new GoogleAuth('client-id')
    await auth.init()
    const p = auth.signIn()
    expect(gis.requestAccessToken).toHaveBeenCalledTimes(1) // no await happened yet
    await p
    expect(auth.signedIn).toBe(true)
  })
})

describe('GoogleAuth — shared in-flight request', () => {
  it('3 parallel getToken() calls after expiry → 1 request, all 3 resolve', async () => {
    let n = 0
    // First token expires immediately (30 s < 60 s safety margin).
    const gis = installGis((c) => c.callback({ access_token: `T${++n}`, expires_in: n === 1 ? 30 : 3600, scope: DRIVE_SCOPE }))
    const auth = new GoogleAuth('client-id')
    await auth.signIn()
    expect(gis.requestAccessToken).toHaveBeenCalledTimes(1)

    const results = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()])
    expect(results).toEqual(['T2', 'T2', 'T2'])
    expect(gis.requestAccessToken).toHaveBeenCalledTimes(2) // sign-in + exactly one renewal
  })

  it('a second signIn while one is pending joins it instead of cancelling it', async () => {
    const gis = installGis(grant('T'))
    const auth = new GoogleAuth('client-id')
    await auth.init()
    const [a, b] = await Promise.all([auth.signIn(), auth.signIn()])
    expect(a).toBeUndefined()
    expect(b).toBeUndefined()
    expect(gis.requestAccessToken).toHaveBeenCalledTimes(1)
  })
})

describe('GoogleAuth — error callback paths', () => {
  it.each([
    ['popup_failed_to_open', POPUP_BLOCKED_MESSAGE],
    ['popup_closed', POPUP_CLOSED_MESSAGE],
  ])('%s → clear Hebrew message', async (type, message) => {
    installGis((c) => c.error_callback?.({ type }))
    const auth = new GoogleAuth('client-id')
    const err = await auth.signIn().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).userMessage).toBe(message)
    expect(auth.signedIn).toBe(false)
  })

  it('unknown error type → generic Hebrew message', async () => {
    installGis((c) => c.error_callback?.({ type: 'unknown' }))
    const err = await new GoogleAuth('client-id').signIn().catch((e: unknown) => e)
    expect((err as AuthError).userMessage).toMatch(/[א-ת]/)
  })

  it('a failed renewal after expiry → "needs reconnect" (not signed out); reconnect restores the session', async () => {
    let n = 0
    installGis((c) => {
      n += 1
      if (n === 1) c.callback({ access_token: 'T1', expires_in: 30, scope: DRIVE_SCOPE })
      else if (n === 2) c.error_callback?.({ type: 'popup_failed_to_open' })
      else c.callback({ access_token: 'T3', expires_in: 3600, scope: DRIVE_SCOPE })
    })
    const auth = new GoogleAuth('client-id')
    const events: [boolean, boolean][] = []
    auth.subscribe((s) => events.push([s, auth.needsReconnect]))
    await auth.signIn()
    expect(events).toEqual([[true, false]])

    const err = await auth.getToken().catch((e: unknown) => e)
    expect((err as AuthError).userMessage).toBe(RECONNECT_MESSAGE)
    expect(auth.signedIn).toBe(false)
    expect(auth.needsReconnect).toBe(true)
    expect(events).toEqual([[true, false], [false, true]])
    // No silent popup loop: further calls fail fast until the user reconnects.
    await expect(auth.getToken()).rejects.toThrow(AuthError)
    expect(n).toBe(2)

    await auth.signIn() // the "reconnect" click
    expect(auth.needsReconnect).toBe(false)
    expect(await auth.getToken()).toBe('T3')
    expect(events.at(-1)).toEqual([true, false])
  })

  it('a failed refresh() after a 401 → needs reconnect', async () => {
    let n = 0
    installGis((c) => {
      n += 1
      if (n === 1) c.callback({ access_token: 'T1', expires_in: 3600, scope: DRIVE_SCOPE })
      else c.error_callback?.({ type: 'popup_closed' })
    })
    const auth = new GoogleAuth('client-id')
    await auth.signIn()
    await expect(auth.refresh()).rejects.toThrow(AuthError)
    expect(auth.signedIn).toBe(false)
    expect(auth.needsReconnect).toBe(true)
  })

  it('explicit sign-out clears "needs reconnect"', async () => {
    let n = 0
    installGis((c) => {
      n += 1
      if (n === 1) c.callback({ access_token: 'T1', expires_in: 30, scope: DRIVE_SCOPE })
      else c.error_callback?.({ type: 'popup_closed' })
    })
    const auth = new GoogleAuth('client-id')
    await auth.signIn()
    await auth.getToken().catch(() => {})
    auth.signOut()
    expect(auth.needsReconnect).toBe(false)
    await expect(auth.getToken()).rejects.toThrow(/not signed in/)
  })

  it('a valid unexpired token is returned without a new request', async () => {
    const gis = installGis(grant('T', 3600))
    const auth = new GoogleAuth('client-id')
    await auth.signIn()
    expect(await auth.getToken()).toBe('T')
    expect(gis.requestAccessToken).toHaveBeenCalledTimes(1)
  })
})

describe('GoogleAuth — hung requests', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a request GIS never answers is rejected after 120 s with a Hebrew message', async () => {
    installGis(() => {}) // never calls back
    const auth = new GoogleAuth('client-id')
    await auth.init()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const p = auth.signIn().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1)
    let settled = false
    void p.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    const err = await p
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).userMessage).toBe(TIMEOUT_MESSAGE)
    // A new click can start a fresh request afterwards.
    expect(window.google?.accounts?.oauth2).toBeTruthy()
  })

  it('a sign-in click replaces a request pending > 10 s; all waiting callers get the new token', async () => {
    let calls = 0
    let config: GoogleTokenClientConfig | undefined
    const requestAccessToken = vi.fn(() => {
      calls += 1
    })
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (c) => {
            config = c
            return { requestAccessToken }
          },
          revoke: vi.fn(),
        },
      },
    }
    const auth = new GoogleAuth('client-id')
    await auth.init()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const first = auth.signIn() // popup lost, never answered
    await vi.advanceTimersByTimeAsync(5_000)
    const early = auth.signIn() // < 10 s: joins, no new popup
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(STALE_REQUEST_MS)
    const second = auth.signIn() // > 10 s: popup opened again
    expect(calls).toBe(2)
    config?.callback({ access_token: 'NEW', expires_in: 3600, scope: DRIVE_SCOPE })
    await expect(Promise.all([first, early, second])).resolves.toEqual([undefined, undefined, undefined])
    expect(await auth.getToken()).toBe('NEW')
    // The timeout was restarted by the second popup and cleared on success: nothing fires later.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2)
    expect(auth.signedIn).toBe(true)
  })
})

describe('GoogleAuth — stale callbacks (fix round 3)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function installRecordingGis() {
    const configs: GoogleTokenClientConfig[] = []
    const requestAccessToken = vi.fn()
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (c) => {
            configs.push(c)
            return { requestAccessToken }
          },
          revoke: vi.fn(),
        },
      },
    }
    return { configs, requestAccessToken }
  }

  it('after a stale re-open, a late popup_closed from the FIRST popup does not reject the shared request', async () => {
    const gis = installRecordingGis()
    const auth = new GoogleAuth('client-id')
    await auth.init()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const first = auth.signIn()
    await vi.advanceTimersByTimeAsync(STALE_REQUEST_MS + 1)
    const second = auth.signIn()
    expect(gis.configs).toHaveLength(2)

    let rejected = false
    void Promise.all([first, second]).catch(() => (rejected = true))
    gis.configs[0].error_callback?.({ type: 'popup_closed' }) // replaced attempt → ignored
    await vi.advanceTimersByTimeAsync(0)
    expect(rejected).toBe(false)

    gis.configs[1].callback({ access_token: 'OK', expires_in: 3600, scope: DRIVE_SCOPE })
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(auth.signedIn).toBe(true)
  })

  it('an error from the CURRENT attempt still rejects', async () => {
    const gis = installRecordingGis()
    const auth = new GoogleAuth('client-id')
    await auth.init()
    const p = auth.signIn().catch((e: unknown) => e)
    gis.configs[0].error_callback?.({ type: 'popup_closed' })
    expect(((await p) as AuthError).userMessage).toBe(POPUP_CLOSED_MESSAGE)
  })

  it('sign-out while a request is pending rejects waiting callers ("התנתקת") and ignores the late token', async () => {
    const gis = installRecordingGis()
    const auth = new GoogleAuth('client-id')
    await auth.init()
    const states: boolean[] = []
    auth.subscribe((s) => states.push(s))
    const pending = auth.signIn().catch((e: unknown) => e)
    auth.signOut()
    const err = (await pending) as AuthError
    expect(err).toBeInstanceOf(AuthError)
    expect(err.userMessage).toBe(SIGNED_OUT_MESSAGE)
    expect(SIGNED_OUT_MESSAGE).toContain('התנתקת')

    gis.configs[0].callback({ access_token: 'LATE', expires_in: 3600, scope: DRIVE_SCOPE })
    await Promise.resolve()
    expect(auth.signedIn).toBe(false)
    expect(states).not.toContain(true)
    await expect(auth.getToken()).rejects.toThrow(/not signed in/)

    // A new sign-in afterwards works normally.
    const again = auth.signIn()
    gis.configs[1].callback({ access_token: 'NEW', expires_in: 3600, scope: DRIVE_SCOPE })
    await again
    expect(await auth.getToken()).toBe('NEW')
  })
})
