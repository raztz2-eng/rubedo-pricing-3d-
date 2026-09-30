/**
 * UI wiring for v0.4 acceptance tests: the production objects (SessionAuth + GoogleDriveStore) talking to the fake
 * Google world through a fake browser. Mirrors src/state/services.ts#createGoogleServices, except that the
 * full-page navigation (sign-in redirect) is captured instead of performed.
 */
import { SessionAuth } from '../../src/lib/auth/sessionAuth'
import { GoogleDriveStore } from '../../src/lib/drive/googleDrive'
import { localFolderPointer, type AppServices } from '../../src/state/services'
import type { Browser } from './google-world'

export interface SessionServices extends AppServices {
  auth: SessionAuth
  drive: GoogleDriveStore
  navigations: string[]
}

export function sessionServices(browser: Browser): SessionServices {
  const navigations: string[] = []
  const auth = new SessionAuth({ fetchImpl: browser.spaFetch, navigate: (u) => navigations.push(u), log: () => {} })
  void auth.init()
  const drive = new GoogleDriveStore(auth, browser.spaFetch)
  return { mode: 'google', drive, auth, folderPointer: localFolderPointer, pickFolder: async () => null, navigations }
}

/** Everything the page could have persisted: localStorage, sessionStorage and JS-visible cookies. */
export function allPersisted(): string {
  const vals: string[] = []
  for (const s of [localStorage, sessionStorage]) {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i) as string
      vals.push(k, s.getItem(k) ?? '')
    }
  }
  vals.push(document.cookie)
  return vals.join('|')
}
