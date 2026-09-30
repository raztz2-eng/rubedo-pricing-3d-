import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Session cookie crypto (brief v0.4 D-G). AES-256-GCM with a key derived from GOOGLE_CLIENT_SECRET via
 * HKDF-SHA256 (info "rubedo-session-v1") — no extra secret to manage. Format: "v1." + base64url(iv | ciphertext | tag).
 */

const INFO = 'rubedo-session-v1'
const PREFIX = 'v1.'
const IV_LEN = 12
const TAG_LEN = 16

export function deriveKey(clientSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(clientSecret, 'utf8'), Buffer.alloc(0), INFO, 32))
}

/** Always uses a fresh random IV (callers cannot supply one: IV reuse would break GCM). */
export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(INFO))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64url')
}

/** Returns the plaintext, or null if the value is malformed, tampered with or sealed with another key. */
export function unseal(token: string, key: Buffer): string | null {
  if (!token.startsWith(PREFIX)) return null
  try {
    const buf = Buffer.from(token.slice(PREFIX.length), 'base64url')
    if (buf.length < IV_LEN + TAG_LEN + 1) return null
    const iv = buf.subarray(0, IV_LEN)
    const tag = buf.subarray(buf.length - TAG_LEN)
    const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(INFO))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** Constant-time string comparison (for the OAuth state). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb) && a.length === b.length
}

/** Non-reversible cache key for a refresh token (the token itself is never used as a key or logged). */
export function tokenFingerprint(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('base64url')
}
