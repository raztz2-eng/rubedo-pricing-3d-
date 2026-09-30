import { SessionAuth } from '../lib/auth/sessionAuth'
import { MODELS_FOLDER_KEY, type AppMode } from '../lib/config'
import { GoogleDriveStore } from '../lib/drive/googleDrive'
import { MemoryDrive } from '../lib/drive/memoryDrive'
import { pickModelsFolder, type PickedFolder } from '../lib/drive/picker'
import type { DriveStore } from '../lib/drive/types'
import { GmailMailStore } from '../lib/mail/gmail'
import { MemoryMail } from '../lib/mail/memoryMail'
import { GMAIL_COMPOSE_SCOPE, type MailStore } from '../lib/mail/types'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

/** Everything the UI needs from the outside world. Tests and demo mode inject in-memory versions. */

export interface AuthLike {
  readonly signedIn: boolean
  /** A renewal failed while working: keep pages mounted and offer "reconnect". Optional (false if absent). */
  readonly needsReconnect?: boolean
  /** The session check at start-up is still running (show "checking…", not a sign-in button). Optional. */
  readonly checking?: boolean
  /** A start-up/renewal problem other than "signed out", in plain Hebrew. Optional. */
  readonly lastError?: string | null
  /** Signed-in Google account e-mail, when known. Optional. */
  readonly email?: string | null
  /** OAuth scopes granted to the session (v0.5 Q5); null/absent = not known. Optional. */
  readonly scopes?: readonly string[] | null
  signIn(): Promise<void>
  /** "needs reconnect": ask the session again (after the popup sign-in). Optional. */
  retry?(): Promise<void>
  /** Opens the sign-in popup (synchronously, inside the click) — also used to grant gmail.compose (Q5). Optional. */
  reconnect?(): void
  /** After the popup: fetch a new token so newly granted scopes are known. Optional. */
  recheck?(): Promise<void>
  signOut(): void
  subscribe(listener: (signedIn: boolean) => void): () => void
}

export interface FolderPointerStore {
  get(): string | null
  set(id: string): void
}

export interface AppServices {
  mode: AppMode
  drive: DriveStore | null
  /** Gmail drafts (v0.5 D-J). Absent/null → the quote screen cannot create drafts. */
  mail?: MailStore | null
  auth: AuthLike | null
  folderPointer: FolderPointerStore
  /** Opens a folder chooser. Resolves null on cancel. */
  pickFolder: () => Promise<PickedFolder | null>
}

/** localStorage pointer to the models folder (an ID only — not data). Wrapped: storage may be blocked. */
export const localFolderPointer: FolderPointerStore = {
  get() {
    try {
      return window.localStorage.getItem(MODELS_FOLDER_KEY)
    } catch {
      return null
    }
  },
  set(id) {
    try {
      window.localStorage.setItem(MODELS_FOLDER_KEY, id)
    } catch {
      /* storage blocked — pointer lives for this session only */
    }
  },
}

export function memoryFolderPointer(initial: string | null = null): FolderPointerStore {
  let value = initial
  return {
    get: () => value,
    set: (id) => {
      value = id
    },
  }
}

/**
 * Demo/test session: always signed in. `scopes` defaults to drive + gmail.compose. Without gmail.compose, the popup
 * "reconnect" (Q5) grants it: `recheck()` afterwards reports the new scope.
 */
export class MemoryAuth implements AuthLike {
  readonly signedIn = true
  readonly email: string | null
  private granted: string[] | null
  private popupOpened = false
  private listeners = new Set<(signedIn: boolean) => void>()
  /** How many times the sign-in popup was opened. */
  reconnectCalls = 0

  constructor(options: { scopes?: string[] | null; email?: string | null } = {}) {
    this.granted = options.scopes === undefined ? [DRIVE_SCOPE, GMAIL_COMPOSE_SCOPE] : options.scopes
    this.email = options.email ?? null
  }

  get scopes(): readonly string[] | null {
    return this.granted
  }

  async signIn(): Promise<void> {}
  signOut(): void {}
  reconnect(): void {
    this.reconnectCalls += 1
    this.popupOpened = true
  }
  async recheck(): Promise<void> {
    if (this.popupOpened && this.granted && !this.granted.includes(GMAIL_COMPOSE_SCOPE)) {
      this.granted = [...this.granted, GMAIL_COMPOSE_SCOPE]
    }
    for (const l of this.listeners) l(true)
  }
  subscribe(listener: (signedIn: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export interface MemoryServicesOptions {
  mail?: MemoryMail
  /** Scopes of the fake session (default drive + gmail.compose). */
  scopes?: string[] | null
}

/** Services backed by an in-memory drive (demo mode and tests). The models folder is pre-picked. */
export function createMemoryServices(
  drive = new MemoryDrive(),
  folderId?: string | null,
  options: MemoryServicesOptions = {},
): AppServices & { drive: MemoryDrive; mail: MemoryMail; auth: MemoryAuth } {
  const root = folderId === undefined ? drive.createRootFolder('models') : folderId
  return {
    mode: 'demo',
    drive,
    mail: options.mail ?? new MemoryMail(),
    auth: new MemoryAuth({ scopes: options.scopes }),
    folderPointer: memoryFolderPointer(root),
    pickFolder: async () => {
      const id = drive.createRootFolder('models')
      return { id, name: 'models' }
    },
  }
}

export function createGoogleServices(): AppServices {
  const auth = new SessionAuth()
  // Silent sign-in from the session cookie (AC18): no click needed when a session exists.
  void auth.init()
  const drive = new GoogleDriveStore(auth)
  return {
    mode: 'google',
    drive,
    mail: new GmailMailStore(auth),
    auth,
    folderPointer: localFolderPointer,
    pickFolder: async () => pickModelsFolder(await auth.getToken()),
  }
}

export function createUnconfiguredServices(): AppServices {
  return { mode: 'unconfigured', drive: null, mail: null, auth: null, folderPointer: localFolderPointer, pickFolder: async () => null }
}
