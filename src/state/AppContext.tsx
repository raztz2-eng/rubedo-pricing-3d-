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
  /** Settings of the CURRENT models folder only (null while another folder's settings are all we have). */
  settings: AppSettings | null
  /** Folder the settings above were loaded from (always === folderId when settings is non-null). */
  settingsFolderId: string | null
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
  // Loaded settings / load errors are tagged with the folder they belong to, so a folder switch can never
  // show (or save) the previous folder's values.
  const [loaded, setLoaded] = useState<{ folderId: string; settings: AppSettings } | null>(null)
  const [loadError, setLoadError] = useState<{ folderId: string; message: string } | null>(null)
  const [loadingFor, setLoadingFor] = useState<string | null>(null)
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
      setLoaded(null)
      setLoadError(null)
      setLoadingFor(null)
      return
    }
    let cancelled = false
    setLoadingFor(folderId)
    setLoadError(null)
    loadSettings(drive, folderId)
      .then((s) => {
        if (!cancelled) setLoaded({ folderId, settings: s })
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError({ folderId, message: errorMessage(e, 'טעינת ההגדרות מ-Drive נכשלה.') })
      })
      .finally(() => {
        if (!cancelled) setLoadingFor(null)
      })
    return () => {
      cancelled = true
    }
  }, [drive, sessionActive, folderId, reloadTick])

  const current = loaded && loaded.folderId === folderId ? loaded : null
  const settings = current?.settings ?? null
  const settingsFolderId = current?.folderId ?? null
  const settingsError = loadError && loadError.folderId === folderId ? loadError.message : null
  // Loading whenever the current folder's settings are not in yet (covers the render right after a switch).
  const settingsLoading =
    loadingFor !== null || (!!drive && sessionActive && !!folderId && !current && settingsError === null)

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
      setLoaded({ folderId, settings: s })
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
      settingsFolderId,
      settingsLoading,
      settingsError,
      signIn,
      signOut,
      pickFolder,
      reloadSettings,
      saveSettings,
    }),
    [services, signedIn, needsReconnect, sessionActive, folderId, settings, settingsFolderId, settingsLoading, settingsError, signIn, signOut, pickFolder, reloadSettings, saveSettings],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- hook belongs with its provider
export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp must be used inside <AppProvider>')
  return v
}
