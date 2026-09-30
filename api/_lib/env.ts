/**
 * Server env (brief v0.4). GOOGLE_CLIENT_SECRET is required and lives only in Vercel env.
 * GOOGLE_CLIENT_ID falls back to VITE_GOOGLE_CLIENT_ID; ALLOWED_EMAIL defaults to the Founder's account.
 */

export const DEFAULT_ALLOWED_EMAIL = 'raztz2@gmail.com'

export type EnvSource = Record<string, string | undefined>

export interface ServerConfig {
  clientId: string
  clientSecret: string
  allowedEmail: string
}

export type ConfigResult = { ok: true; config: ServerConfig } | { ok: false; missing: string[] }

export function readConfig(env: EnvSource): ConfigResult {
  const clientId = (env.GOOGLE_CLIENT_ID ?? '').trim() || (env.VITE_GOOGLE_CLIENT_ID ?? '').trim()
  const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? '').trim()
  const allowedEmail = ((env.ALLOWED_EMAIL ?? '').trim() || DEFAULT_ALLOWED_EMAIL).toLowerCase()
  const missing: string[] = []
  if (!clientId) missing.push('GOOGLE_CLIENT_ID')
  if (!clientSecret) missing.push('GOOGLE_CLIENT_SECRET')
  if (missing.length > 0) return { ok: false, missing }
  return { ok: true, config: { clientId, clientSecret, allowedEmail } }
}
