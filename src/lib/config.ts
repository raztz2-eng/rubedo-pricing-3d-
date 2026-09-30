/**
 * Build-time configuration (Vite env) and app mode.
 * OAuth scopes are requested by the backend only (api/_lib/google.ts, brief v0.4 D-F); the SPA never asks for scopes.
 */

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
