import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthError, GoogleAuth, POPUP_BLOCKED_MESSAGE, POPUP_CLOSED_MESSAGE } from '../../src/lib/auth/googleAuth'
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

describe('GoogleAuth (AC12)', () => {
  it('requests only drive.file and keeps the token in memory only', async () => {
    const gis = installGis(grant('SECRET-TOKEN'))
    const auth = new GoogleAuth('client-id')
    await auth.signIn()

    expect(gis.getConfig()?.scope).toBe('https://www.googleapis.com/auth/drive.file')
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

  it('a failed renewal after expiry clears the token and emits signed-out', async () => {
    let n = 0
    installGis((c) => {
      n += 1
      if (n === 1) c.callback({ access_token: 'T1', expires_in: 30, scope: DRIVE_SCOPE })
      else c.error_callback?.({ type: 'popup_failed_to_open' })
    })
    const auth = new GoogleAuth('client-id')
    const states: boolean[] = []
    auth.subscribe((s) => states.push(s))
    await auth.signIn()
    expect(states).toEqual([true])

    const err = await auth.getToken().catch((e: unknown) => e)
    expect((err as AuthError).userMessage).toBe(POPUP_BLOCKED_MESSAGE)
    expect(auth.signedIn).toBe(false)
    expect(states).toEqual([true, false])
    // No silent retry loop: the user must sign in again.
    await expect(auth.getToken()).rejects.toThrow(AuthError)
    expect(n).toBe(2)
  })

  it('refresh() after a 401 that fails also signs out', async () => {
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
  })

  it('a valid unexpired token is returned without a new request', async () => {
    const gis = installGis(grant('T', 3600))
    const auth = new GoogleAuth('client-id')
    await auth.signIn()
    expect(await auth.getToken()).toBe('T')
    expect(gis.requestAccessToken).toHaveBeenCalledTimes(1)
  })
})
