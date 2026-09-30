/**
 * Independent MIME reader for the v0.5 acceptance tests (AC28/AC29). Written by the Test Verifier from the RFCs —
 * it shares no code with src/lib/mail or tests/unit/mimeReader.ts. It is strict on purpose: anything it cannot
 * read as RFC 5322 / 2045 / 2046 / 2047 throws with the reason.
 */

export interface MimeHeader {
  name: string
  value: string
}

export interface MimeEntity {
  headers: MimeHeader[]
  /** Lower-case media type, e.g. "multipart/mixed". */
  type: string
  params: Record<string, string>
  /** Raw body text exactly as in the message (between the header block and the next boundary). */
  rawBody: string
  /** Decoded body bytes (Content-Transfer-Encoding applied). Empty for multiparts. */
  bytes: Uint8Array
  parts: MimeEntity[]
}

const CRLF = '\r\n'

function fail(msg: string): never {
  throw new Error(`MIME: ${msg}`)
}

export function header(e: { headers: MimeHeader[] }, name: string): string | undefined {
  return e.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value
}

export function headersNamed(e: { headers: MimeHeader[] }, name: string): string[] {
  return e.headers.filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value)
}

/** Whole-message line checks: CRLF only, 7-bit ASCII, lines ≤ 998 chars (RFC 5322 §2.1.1, §2.3). */
export function lineProblems(raw: string): string[] {
  const problems: string[] = []
  if (/\r(?!\n)/.test(raw)) problems.push('bare CR')
  if (/(?<!\r)\n/.test(raw)) problems.push('bare LF')
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(raw)) problems.push('non-ASCII byte')
  // eslint-disable-next-line no-control-regex
  if (/[\x00]/.test(raw)) problems.push('NUL byte')
  raw.split(CRLF).forEach((l, i) => {
    if (l.length > 998) problems.push(`line ${i + 1} longer than 998`)
  })
  return problems
}

function splitHeadBody(raw: string): { head: string; body: string } {
  if (raw.startsWith(CRLF)) return { head: '', body: raw.slice(2) }
  const i = raw.indexOf(CRLF + CRLF)
  if (i < 0) fail('no blank line between headers and body')
  return { head: raw.slice(0, i), body: raw.slice(i + 4) }
}

function parseHeaders(head: string): MimeHeader[] {
  if (head === '') return []
  const out: MimeHeader[] = []
  for (const line of head.split(CRLF)) {
    if (/^[ \t]/.test(line)) {
      if (out.length === 0) fail('continuation line before first header')
      out[out.length - 1].value += line // unfold: drop the CRLF, keep the WSP (RFC 5322 §2.2.3)
      continue
    }
    const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line)
    if (!m) fail(`malformed header line "${line.slice(0, 60)}"`)
    out.push({ name: m[1], value: m[2] })
  }
  return out
}

/** "type/sub; a=b; c=\"d e\"" → { type, params } (RFC 2045 §5.1). */
export function parseContentType(value: string | undefined): { type: string; params: Record<string, string> } {
  if (value === undefined) return { type: 'text/plain', params: { charset: 'us-ascii' } }
  const m = /^\s*([A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+)\s*(.*)$/.exec(value)
  if (!m) fail(`bad Content-Type "${value}"`)
  const params: Record<string, string> = {}
  let rest = m[2]
  while (rest.trim() !== '') {
    const p = /^\s*;\s*([A-Za-z0-9!#$&^_.+*'-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;\s]+)\s*/.exec(rest)
    if (!p) fail(`bad parameter list "${rest}"`)
    const v = p[2].startsWith('"') ? p[2].slice(1, -1).replace(/\\(.)/g, '$1') : p[2]
    params[p[1].toLowerCase()] = v
    rest = rest.slice(p[0].length)
  }
  return { type: m[1].toLowerCase(), params }
}

function decodeBase64Strict(body: string): Uint8Array {
  const lines = body.split(CRLF)
  for (const l of lines) if (l.length > 76) fail(`base64 line longer than 76 (${l.length})`)
  const b64 = body.replace(/\r\n/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) fail('base64 body has characters outside the alphabet')
  if (b64.length % 4 !== 0) fail('base64 length is not a multiple of 4')
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

function decodeQuotedPrintable(body: string): Uint8Array {
  const soft = body.replace(/=\r\n/g, '')
  const out: number[] = []
  for (let i = 0; i < soft.length; i++) {
    const c = soft[i]
    if (c === '=') {
      const hex = soft.slice(i + 1, i + 3)
      if (!/^[0-9A-F]{2}$/i.test(hex)) fail('bad quoted-printable escape')
      out.push(parseInt(hex, 16))
      i += 2
    } else out.push(c.charCodeAt(0))
  }
  return Uint8Array.from(out)
}

function splitMultipart(body: string, boundary: string): string[] {
  if (boundary.length < 1 || boundary.length > 70) fail(`boundary length ${boundary.length} (RFC 2046: 1–70)`)
  const delim = `--${boundary}`
  // Line-based (RFC 2046 §5.1.1): the CRLF before a delimiter line belongs to the delimiter.
  const parts: string[][] = []
  let current: string[] | null = null
  let closed = false
  for (const line of body.split(CRLF)) {
    const l = line.replace(/[ \t]+$/, '')
    if (l === `${delim}--`) {
      if (current) parts.push(current)
      closed = true
      break
    }
    if (l === delim) {
      if (current) parts.push(current)
      current = []
      continue
    }
    if (current) current.push(line)
  }
  if (current === null && parts.length === 0) fail(`no delimiter for boundary "${boundary}"`)
  if (!closed) fail(`missing close delimiter "${delim}--"`)
  return parts.map((ls) => ls.join(CRLF))
}

export function parseEntity(raw: string): MimeEntity {
  const { head, body } = splitHeadBody(raw)
  const headers = parseHeaders(head)
  const { type, params } = parseContentType(header({ headers }, 'Content-Type'))
  const entity: MimeEntity = { headers, type, params, rawBody: body, bytes: new Uint8Array(), parts: [] }
  if (type.startsWith('multipart/')) {
    const boundary = params.boundary
    if (!boundary) fail(`${type} without boundary`)
    entity.parts = splitMultipart(body, boundary).map(parseEntity)
    return entity
  }
  const cte = (header({ headers }, 'Content-Transfer-Encoding') ?? '7bit').trim().toLowerCase()
  if (cte === 'base64') entity.bytes = decodeBase64Strict(body)
  else if (cte === 'quoted-printable') entity.bytes = decodeQuotedPrintable(body)
  else if (cte === '7bit' || cte === '8bit' || cte === 'binary') entity.bytes = new Uint8Array(Buffer.from(body, 'latin1'))
  else fail(`unknown Content-Transfer-Encoding ${cte}`)
  return entity
}

export function textOf(e: MimeEntity): string {
  const charset = (e.params.charset ?? 'us-ascii').toLowerCase()
  if (charset !== 'utf-8' && charset !== 'us-ascii') fail(`unexpected charset ${charset}`)
  return new TextDecoder('utf-8', { fatal: true }).decode(e.bytes)
}

/**
 * RFC 2047 decoding of an unstructured header value. Returns the decoded text and the list of encoded-words found.
 * Each encoded-word must be ≤ 75 chars and decode to complete UTF-8 characters on its own (RFC 2047 §2, §5).
 */
export function decodeHeaderText(value: string): { text: string; words: string[] } {
  const words: string[] = []
  const re = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g
  let out = ''
  let last = 0
  let prevWasWord = false
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) {
    const between = value.slice(last, m.index)
    // Whitespace between two adjacent encoded-words is ignored (RFC 2047 §6.2).
    if (!(prevWasWord && /^[ \t]*$/.test(between))) out += between
    const word = m[0]
    if (word.length > 75) fail(`encoded-word longer than 75: ${word.length}`)
    const charset = m[1].toLowerCase()
    if (charset !== 'utf-8') fail(`encoded-word charset ${charset}`)
    let bytes: Uint8Array
    if (m[2].toUpperCase() === 'B') {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(m[3]) || m[3].length % 4 !== 0) fail(`bad B encoded-word ${word}`)
      bytes = new Uint8Array(Buffer.from(m[3], 'base64'))
    } else {
      bytes = decodeQuotedPrintable(m[3].replace(/_/g, '=20'))
    }
    out += new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    words.push(word)
    last = m.index + word.length
    prevWasWord = true
  }
  out += value.slice(last)
  return { text: out, words }
}

/** Depth-first list of all leaf entities. */
export function leaves(e: MimeEntity): MimeEntity[] {
  return e.parts.length === 0 ? [e] : e.parts.flatMap(leaves)
}

/** The RFC 2231/2047 filename of an attachment (Content-Disposition filename, else Content-Type name). */
export function attachmentName(e: MimeEntity): string | undefined {
  const disp = header(e, 'Content-Disposition')
  if (disp) {
    const d = parseContentType(`x/${disp.trim().replace(/^[^;]*/, (t) => t.trim())}`)
    const fn = d.params.filename
    if (fn !== undefined) return decodeHeaderText(fn).text
  }
  return e.params.name === undefined ? undefined : decodeHeaderText(e.params.name).text
}

export function dispositionType(e: MimeEntity): string | undefined {
  const disp = header(e, 'Content-Disposition')
  return disp === undefined ? undefined : disp.split(';')[0].trim().toLowerCase()
}
