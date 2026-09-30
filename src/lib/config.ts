/** Build-time configuration (Vite env) and app mode. */

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
/**
 * Exactly these two scopes (brief addendum v0.3, D-A): read everything, write only files the app created.
 * Nothing broader is ever requested.
 */
export const DRIVE_SCOPES: readonly string[] = [DRIVE_FILE_SCOPE, DRIVE_READONLY_SCOPE]
/** The space-separated scope string sent to Google Identity Services. */
export const DRIVE_SCOPE = DRIVE_SCOPES.join(' ')

export const googleConfig = {
  clientId: (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim(),
  apiKey: (import.meta.env.VITE_GOOGLE_API_KEY ?? '').trim(),
  appId: (import.meta.env.VITE_GOOGLE_APP_ID ?? '').trim(),
}

export type AppMode = 'google' | 'demo' | 'unconfigured'

/**
 * `?demo=1` → in-memory storage, no Google sign-in (for clicking through the UI without Google).
 * Decided once at startup; stays on while navigating inside the app.
 */
export function detectMode(search: string = window.location.search): AppMode {
  if (new URLSearchParams(search).get('demo') === '1') return 'demo'
  return googleConfig.clientId ? 'google' : 'unconfigured'
}

export const MODELS_FOLDER_KEY = 'rubedo.modelsFolderId'
