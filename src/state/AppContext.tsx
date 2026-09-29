import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppSettings } from '../lib/bid'
import { loadSettings, saveSettings as saveSettingsFile } from '../lib/drive/bidRepository'
import { errorMessage } from '../lib/errors'
import type { AppServices } from './services'

export interface AppState {
  services: AppServices
  signedIn: boolean
  /** Token renewal failed; pages stay mounted and a reconnect prompt is shown. */
  needsReconnect: boolean
  /** Signed in, or temporarily disconnected (needs reconnect). Pages are gated on this, not on signedIn. */
  sessionActive: boolean
  folderId: string | null
  settings: AppSettings | null
  settingsLoading: boolean
  settingsError: string | null
  signIn: () => Promise<void>
  signOut: () => void
  pickFolder: () => Promise<void>
  reloadSettings: () => void
  saveSettings: (s: AppSettings) => Promise<void>
}

const Ctx = createContext<AppState | null>(null)

export function AppProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(services.auth?.signedIn ?? false)
  const [folderId, setFolderId] = useState<string | null>(() => services.folderPointer.get())
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  const [needsReconnect, setNeedsReconnect] = useState(services.auth?.needsReconnect ?? false)
  const sessionActive = signedIn || needsReconnect

  useEffect(() => {
    const auth = services.auth
    if (!auth) return
    return auth.subscribe((s) => {
      setSignedIn(s)
      setNeedsReconnect(auth.needsReconnect ?? false)
    })
  }, [services.auth])

  const drive = services.drive
  useEffect(() => {
    if (!drive || !sessionActive || !folderId) {
      setSettings(null)
      return
    }
    let cancelled = false
    setSettingsLoading(true)
    setSettingsError(null)
    loadSettings(drive, folderId)
      .then((s) => {
        if (!cancelled) setSettings(s)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setSettings(null)
          setSettingsError(errorMessage(e, 'טעינת ההגדרות מ-Drive נכשלה.'))
        }
      })
      .finally(() => {
        if (!cancelled) setSettingsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [drive, sessionActive, folderId, reloadTick])

  const signIn = useCallback(async () => {
    if (!services.auth) return
    await services.auth.signIn()
  }, [services.auth])

  const signOut = useCallback(() => {
    services.auth?.signOut()
  }, [services.auth])

  const pickFolder = useCallback(async () => {
    const picked = await services.pickFolder()
    if (!picked) return
    services.folderPointer.set(picked.id)
    setFolderId(picked.id)
  }, [services])

  const saveSettings = useCallback(
    async (s: AppSettings) => {
      if (!drive || !folderId) throw new Error('no folder')
      await saveSettingsFile(drive, folderId, s)
      setSettings(s)
    },
    [drive, folderId],
  )

  const reloadSettings = useCallback(() => setReloadTick((t) => t + 1), [])

  const value = useMemo<AppState>(
    () => ({
      services,
      signedIn,
      needsReconnect,
      sessionActive,
      folderId,
      settings,
      settingsLoading,
      settingsError,
      signIn,
      signOut,
      pickFolder,
      reloadSettings,
      saveSettings,
    }),
    [services, signedIn, needsReconnect, sessionActive, folderId, settings, settingsLoading, settingsError, signIn, signOut, pickFolder, reloadSettings, saveSettings],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- hook belongs with its provider
export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp must be used inside <AppProvider>')
  return v
}
