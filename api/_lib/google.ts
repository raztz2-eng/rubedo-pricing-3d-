/** Google OAuth / Drive endpoints used by the backend (plain fetch, no SDK). */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'

/** Brief v0.4 D-F: full Drive scope (the app's own write rules are enforced in code). */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
export const LOGIN_SCOPES = ['openid', 'email', DRIVE_SCOPE].join(' ')

export interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
}

export type RefreshResult =
  | { ok: true; accessToken: string; expiresIn: number; refreshToken?: string }
  /** `revoked`: Google says the refresh token is no longer valid → the session is gone. Otherwise: temporary. */
  | { ok: false; revoked: boolean; status: number }

function form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values)
}

export async function exchangeCode(
  fetchImpl: typeof fetch,
  p: { code: string; clientId: string; clientSecret: string; redirectUri: string },
): Promise<{ ok: true; body: TokenResponse } | { ok: false; status: number }> {
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) return { ok: false, status: res.status }
  return { ok: true, body: (await res.json()) as TokenResponse }
}

export async function refreshAccessToken(
  fetchImpl: typeof fetch,
  p: { refreshToken: string; clientId: string; clientSecret: string },
): Promise<RefreshResult> {
  let res: Response
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        refresh_token: p.refreshToken,
        client_id: p.clientId,
        client_secret: p.clientSecret,
        grant_type: 'refresh_token',
      }),
    })
  } catch {
    return { ok: false, revoked: false, status: 0 }
  }
  if (!res.ok) {
    let error = ''
    try {
      error = ((await res.json()) as TokenResponse).error ?? ''
    } catch {
      /* not JSON */
    }
    // invalid_grant = expired/revoked refresh token; 401 = client problem for this token. Both end the session.
    return { ok: false, revoked: error === 'invalid_grant' || res.status === 401, status: res.status }
  }
  const body = (await res.json()) as TokenResponse
  if (!body.access_token) return { ok: false, revoked: false, status: 502 }
  return {
    ok: true,
    accessToken: body.access_token,
    expiresIn: Number(body.expires_in ?? 3600),
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
  }
}

export async function fetchUserEmail(fetchImpl: typeof fetch, accessToken: string): Promise<{ email: string; verified: boolean } | null> {
  const res = await fetchImpl(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) return null
  const body = (await res.json()) as { email?: string; email_verified?: boolean | string }
  if (typeof body.email !== 'string') return null
  return { email: body.email.trim().toLowerCase(), verified: body.email_verified === true || body.email_verified === 'true' }
}

export async function revokeToken(fetchImpl: typeof fetch, token: string): Promise<void> {
  await fetchImpl(GOOGLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ token }),
  })
}

export function hasDriveScope(scope: string | undefined): boolean {
  return (scope ?? '').split(/\s+/).includes(DRIVE_SCOPE)
}

/** Only Google-hosted thumbnail URLs are fetched (no SSRF): https + googleusercontent.com / google.com. */
export function isAllowedThumbnailUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
    const h = u.hostname.toLowerCase()
    return h === 'googleusercontent.com' || h.endsWith('.googleusercontent.com') || h === 'google.com' || h.endsWith('.google.com')
  } catch {
    return false
  }
}

/** Drive thumbnail links end in "=s220": ask for the requested size. Other links are used unchanged. */
export function sizeThumbnailUrl(link: string, size: number): string {
  return /=s\d+$/.test(link) ? link.replace(/=s\d+$/, `=s${size}`) : link
}
