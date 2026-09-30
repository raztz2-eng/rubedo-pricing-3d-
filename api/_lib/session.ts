import { deriveKey, seal, unseal } from './crypto.js'
import { clearCookie, parseCookies, serializeCookie } from './http.js'

/**
 * The session = an encrypted HttpOnly cookie holding the Google refresh token (brief v0.4 D-G).
 * The refresh token never leaves the server in plaintext: not in responses, not in logs.
 */

export const SESSION_COOKIE = 'rubedo_session'
export const SESSION_PATH = '/api'
export const SESSION_MAX_AGE = 180 * 24 * 60 * 60

export const STATE_COOKIE = 'rubedo_oauth_state'
export const STATE_PATH = '/api/auth'
export const STATE_MAX_AGE = 10 * 60

export interface Session {
  v: 1
  rt: string
  email: string
  iat: number
}

export type SessionRead = { kind: 'none' } | { kind: 'invalid' } | { kind: 'ok'; session: Session }

export function sessionCookie(session: Session, clientSecret: string): string {
  return serializeCookie(SESSION_COOKIE, seal(JSON.stringify(session), deriveKey(clientSecret)), {
    path: SESSION_PATH,
    maxAge: SESSION_MAX_AGE,
  })
}

export function clearSessionCookie(): string {
  return clearCookie(SESSION_COOKIE, SESSION_PATH)
}

export function readSession(req: Request, clientSecret: string): SessionRead {
  const raw = parseCookies(req.headers.get('Cookie'))[SESSION_COOKIE]
  if (!raw) return { kind: 'none' }
  const plain = unseal(raw, deriveKey(clientSecret))
  if (plain === null) return { kind: 'invalid' }
  try {
    const s = JSON.parse(plain) as Partial<Session>
    if (s.v !== 1 || typeof s.rt !== 'string' || !s.rt || typeof s.email !== 'string') return { kind: 'invalid' }
    return { kind: 'ok', session: { v: 1, rt: s.rt, email: s.email, iat: Number(s.iat ?? 0) } }
  } catch {
    return { kind: 'invalid' }
  }
}
