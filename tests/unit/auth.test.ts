import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoogleAuth } from '../../src/lib/auth/googleAuth'
import { DRIVE_SCOPE } from '../../src/lib/config'

afterEach(() => {
  delete (window as Window).google
})

describe('GoogleAuth (AC12)', () => {
  it('requests only drive.file and keeps the token in memory only', async () => {
    let config: GoogleTokenClientConfig | undefined
    const revoke = vi.fn()
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (c) => {
            config = c
            return {
              requestAccessToken: () =>
                setTimeout(() => c.callback({ access_token: 'SECRET-TOKEN', expires_in: 3600, scope: DRIVE_SCOPE }), 0),
            }
          },
          revoke,
        },
      },
    }
    // Pretend the GIS script is already loaded.
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    const appendSpy = vi.spyOn(document.head, 'appendChild').mockImplementation((el) => {
      queueMicrotask(() => (el as HTMLScriptElement).onload?.(new Event('load')))
      return el
    })

    const auth = new GoogleAuth('client-id')
    await auth.signIn()
    appendSpy.mockRestore()

    expect(config?.scope).toBe('https://www.googleapis.com/auth/drive.file')
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
    expect(revoke).toHaveBeenCalledWith('SECRET-TOKEN')
    await expect(auth.getToken()).rejects.toThrow()
  })
})
