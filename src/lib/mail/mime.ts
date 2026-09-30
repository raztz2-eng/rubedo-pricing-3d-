/**
 * Builds the quote e-mail as a MIME message in the browser (brief v0.5 Q3, AC28). Pure, no I/O.
 *
 * Structure:
 *   multipart/mixed
 *   ├─ multipart/alternative
 *   │   ├─ text/plain; charset=UTF-8   (base64)
 *   │   └─ text/html;  charset=UTF-8   (base64, RTL)
 *   └─ image/* attachments            (base64)
 *
 * Non-ASCII header text (Hebrew subject, recipient name, attachment filenames) uses RFC 2047 "B" encoded-words.
 * All lines end in CRLF; base64 bodies are wrapped at 76 characters. The result is plain ASCII.
 */

export const CRLF = '\r\n'
const B64_LINE = 76
/** 45 UTF-8 bytes → 60 base64 chars → an encoded-word of 72 chars (limit 75, RFC 2047 §2). */
const WORD_BYTES = 45

export interface MimeAttachment {
  filename: string
  mimeType: string
  data: Uint8Array
}

export interface MimeMessageInput {
  to: { email: string; name?: string }
  subject: string
  text: string
  html: string
  attachments: MimeAttachment[]
  /** Makes boundaries deterministic (tests). Default: random. */
  boundarySeed?: string
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64 (RFC 4648 §4) of bytes, unwrapped. */
export function base64(bytes: Uint8Array): string {
  const out: string[] = []
  let chunk = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    const n = (a << 16) | (b << 8) | c
    chunk +=
      B64_CHARS[(n >> 18) & 63] +
      B64_CHARS[(n >> 12) & 63] +
      (i + 1 < bytes.length ? B64_CHARS[(n >> 6) & 63] : '=') +
      (i + 2 < bytes.length ? B64_CHARS[n & 63] : '=')
    if (chunk.length >= 4096) {
      out.push(chunk)
      chunk = ''
    }
  }
  out.push(chunk)
  return out.join('')
}

/** base64 wrapped at 76 characters per line, CRLF line endings (RFC 2045 §6.8). */
export function base64Wrapped(bytes: Uint8Array): string {
  const b64 = base64(bytes)
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += B64_LINE) lines.push(b64.slice(i, i + B64_LINE))
  return lines.join(CRLF)
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Line breaks → CRLF (canonical form of text/* bodies). */
export function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, CRLF)
}

/** Header values never contain line breaks (no header injection). */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim()
}

function isPlainAscii(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text) && !text.includes('=?')
}

/**
 * RFC 2047 encoded-words ("=?UTF-8?B?…?=") for `text`, split so that no word exceeds 75 characters and no UTF-8
 * character is split between words. Plain printable ASCII is returned as a single unchanged item.
 */
export function encodedWords(text: string): string[] {
  const t = oneLine(text)
  if (isPlainAscii(t)) return [t]
  const words: string[] = []
  let bytes: number[] = []
  const flush = () => {
    if (bytes.length === 0) return
    words.push(`=?UTF-8?B?${base64(Uint8Array.from(bytes))}?=`)
    bytes = []
  }
  for (const ch of t) {
    const b = utf8(ch)
    if (bytes.length + b.length > WORD_BYTES) flush()
    bytes.push(...b)
  }
  flush()
  return words
}

/** A header value: plain ASCII as is, otherwise encoded-words folded onto continuation lines. */
export function encodeHeaderText(text: string): string {
  return encodedWords(text).join(`${CRLF} `)
}

/** A quoted parameter value (filename / name): ASCII quoted and escaped, otherwise encoded-words. */
function paramValue(text: string): string {
  const words = encodedWords(text)
  if (words.length === 1 && !words[0].startsWith('=?')) return `"${words[0].replace(/(["\\])/g, '\\$1')}"`
  return `"${words.join(' ')}"`
}

function mailbox(to: MimeMessageInput['to']): string {
  const email = oneLine(to.email)
  const name = oneLine(to.name ?? '')
  if (!name) return `<${email}>`
  const words = encodedWords(name)
  const display = words.length === 1 && !words[0].startsWith('=?') ? `"${words[0].replace(/(["\\])/g, '\\$1')}"` : words.join(' ')
  return `${display} <${email}>`
}

function randomToken(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** "=_" never occurs in base64 or encoded-word output, so the boundaries cannot collide with content. */
export function boundaries(seed: string = randomToken()): { mixed: string; alternative: string } {
  return { mixed: `=_rubedo_mixed_${seed}`, alternative: `=_rubedo_alt_${seed}` }
}

function part(headers: string[], body: string): string {
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`
}

/** The full message (headers + body). ASCII only, CRLF line endings. */
export function buildMimeMessage(input: MimeMessageInput): string {
  const { mixed, alternative } = boundaries(input.boundarySeed)

  const textPart = part(
    ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64'],
    base64Wrapped(utf8(toCrlf(input.text))),
  )
  const htmlPart = part(
    ['Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64'],
    base64Wrapped(utf8(toCrlf(input.html))),
  )
  const alternativeBody = [`--${alternative}`, textPart, `--${alternative}`, htmlPart, `--${alternative}--`].join(CRLF)
  const alternativePart = part([`Content-Type: multipart/alternative; boundary="${alternative}"`], alternativeBody)

  const attachmentParts = input.attachments.map((a) =>
    part(
      [
        `Content-Type: ${oneLine(a.mimeType)}; name=${paramValue(a.filename)}`,
        `Content-Disposition: attachment; filename=${paramValue(a.filename)}`,
        'Content-Transfer-Encoding: base64',
      ],
      base64Wrapped(a.data),
    ),
  )

  const mixedBody = [
    `--${mixed}`,
    alternativePart,
    ...attachmentParts.flatMap((p) => [`--${mixed}`, p]),
    `--${mixed}--`,
    '',
  ].join(CRLF)

  const headers = [
    'MIME-Version: 1.0',
    `To: ${mailbox(input.to)}`,
    `Subject: ${encodeHeaderText(input.subject)}`,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ]
  return part(headers, mixedBody)
}
