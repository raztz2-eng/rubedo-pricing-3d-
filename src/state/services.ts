import { SessionAuth } from '../lib/auth/sessionAuth'
import { MODELS_FOLDER_KEY, type AppMode } from '../lib/config'
import { GoogleDriveStore } from '../lib/drive/googleDrive'
import { MemoryDrive } from '../lib/drive/memoryDrive'
import { pickModelsFolder, type PickedFolder } from '../lib/drive/picker'
import type { DriveStore } from '../lib/drive/types'

/** Everything the UI needs from the outside world. Tests and demo mode inject in-memory versions. */

export interface AuthLike {
  readonly signedIn: boolean
  /** A renewal failed while working: keep pages mounted and offer "reconnect". Optional (false if absent). */
  readonly needsReconnect?: boolean
  /** The session check at start-up is still running (show "checking…", not a sign-in button). Optional. */
  readonly checking?: boolean
  /** A start-up/renewal problem other than "signed out", in plain Hebrew. Optional. */
  readonly lastError?: string | null
  signIn(): Promise<void>
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

class AlwaysSignedIn implements AuthLike {
  readonly signedIn = true
  async signIn(): Promise<void> {}
  signOut(): void {}
  subscribe(): () => void {
    return () => {}
  }
}

/** Services backed by an in-memory drive (demo mode and tests). The models folder is pre-picked. */
export function createMemoryServices(drive = new MemoryDrive(), folderId?: string | null): AppServices & { drive: MemoryDrive } {
  const root = folderId === undefined ? drive.createRootFolder('models') : folderId
  return {
    mode: 'demo',
    drive,
    auth: new AlwaysSignedIn(),
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
    auth,
    folderPointer: localFolderPointer,
    pickFolder: async () => pickModelsFolder(await auth.getToken()),
  }
}

export function createUnconfiguredServices(): AppServices {
  return { mode: 'unconfigured', drive: null, auth: null, folderPointer: localFolderPointer, pickFolder: async () => null }
}
