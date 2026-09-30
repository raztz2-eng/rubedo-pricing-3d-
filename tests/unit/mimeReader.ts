/** Test-only MIME reader (independent of src/lib/mail/mime.ts) used to check the builder's output. */
// ---------------------------------------------------------------------------------------------
// A small, independent MIME reader used to check the builder's output (boundaries, headers, bodies).

export interface Part {
  headers: Map<string, string>
  body: string
}

export function splitHead(raw: string): { head: string; body: string } {
  const i = raw.indexOf('\r\n\r\n')
  if (i < 0) throw new Error('no header/body separator')
  return { head: raw.slice(0, i), body: raw.slice(i + 4) }
}

export function parseHeaders(head: string): Map<string, string> {
  const map = new Map<string, string>()
  // Unfold: CRLF followed by whitespace continues the previous header.
  const unfolded = head.replace(/\r\n[ \t]/g, ' ')
  for (const line of unfolded.split('\r\n')) {
    const c = line.indexOf(':')
    if (c <= 0) throw new Error(`bad header line: ${line}`)
    map.set(line.slice(0, c).toLowerCase(), line.slice(c + 1).trim())
  }
  return map
}

export function parsePart(raw: string): Part {
  const { head, body } = splitHead(raw)
  return { headers: parseHeaders(head), body }
}

export function param(value: string, name: string): string | undefined {
  const m = new RegExp(`;\\s*${name}=("((?:[^"\\\\]|\\\\.)*)"|[^;\\s]+)`, 'i').exec(value)
  if (!m) return undefined
  return m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[1]
}

export function mediaType(value: string | undefined): string {
  return (value ?? '').split(';')[0].trim().toLowerCase()
}

/** Children of a multipart body, checking the delimiter lines strictly (RFC 2046 §5.1.1). */
export function multipartChildren(body: string, boundary: string): Part[] {
  const lines = body.split('\r\n')
  const children: string[][] = []
  let current: string[] | null = null
  let closed = false
  for (const line of lines) {
    if (line === `--${boundary}`) {
      if (current) children.push(current)
      current = []
      continue
    }
    if (line === `--${boundary}--`) {
      if (current) children.push(current)
      closed = true
      break
    }
    if (current) current.push(line)
  }
  if (!closed) throw new Error(`boundary ${boundary} never closed`)
  return children.map((c) => parsePart(c.join('\r\n')))
}

export function decodeBase64Body(body: string): Uint8Array {
  return Uint8Array.from(Buffer.from(body.replace(/\r\n/g, ''), 'base64'))
}

export function decodeWords(value: string): string {
  // Whitespace between adjacent encoded-words is ignored (RFC 2047 §6.2).
  return value
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/gi, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf8'))
}


/** Convenience: the decoded pieces of a quote message. */
export function readQuoteMessage(raw: string) {
  const top = parsePart(raw)
  const mixed = multipartChildren(top.body, param(top.headers.get('content-type') as string, 'boundary') as string)
  const alt = multipartChildren(mixed[0].body, param(mixed[0].headers.get('content-type') as string, 'boundary') as string)
  return {
    top,
    to: decodeWords(top.headers.get('to') ?? ''),
    subject: decodeWords(top.headers.get('subject') ?? ''),
    text: Buffer.from(decodeBase64Body(alt[0].body)).toString('utf8'),
    html: Buffer.from(decodeBase64Body(alt[1].body)).toString('utf8'),
    attachments: mixed.slice(1).map((p) => ({
      type: mediaType(p.headers.get('content-type')),
      filename: decodeWords(param(p.headers.get('content-disposition') as string, 'filename') ?? ''),
      data: decodeBase64Body(p.body),
    })),
  }
}
