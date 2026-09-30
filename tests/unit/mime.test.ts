import { describe, expect, it } from 'vitest'
import {
  base64,
  base64Wrapped,
  buildMimeMessage,
  encodeHeaderText,
  encodedWords,
  type MimeMessageInput,
} from '../../src/lib/mail/mime'
import { decodeBase64Body, decodeWords, mediaType, multipartChildren, param, parsePart, splitHead } from './mimeReader'

// ---------------------------------------------------------------------------------------------

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 300 }, (_, i) => i % 256), 0xff, 0xd9])
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

function input(over: Partial<MimeMessageInput> = {}): MimeMessageInput {
  return {
    to: { email: 'dana@example.com', name: 'דנה כהן' },
    subject: 'הצעת מחיר — עמדת השרשה | RUBEDO.3D',
    text: 'שלום דנה,\n\nמחיר: ₪84\n\nבברכה,\nRUBEDO.3D — הדפסות תלת-ממד בהתאמה אישית',
    html: '<!DOCTYPE html>\n<html lang="he" dir="rtl"><body dir="rtl"><div dir="rtl"><p>שלום דנה,</p></div></body></html>',
    attachments: [
      { filename: 'תמונה ראשית.jpg', mimeType: 'image/jpeg', data: JPEG },
      { filename: 'plate-1.png', mimeType: 'image/png', data: PNG },
    ],
    boundarySeed: 'seed123',
    ...over,
  }
}

describe('base64 helpers', () => {
  it('matches Node base64 for all padding cases', () => {
    for (const bytes of [[], [1], [1, 2], [1, 2, 3], [255, 254, 253, 252], Array.from({ length: 1000 }, (_, i) => (i * 7) % 256)]) {
      const u = Uint8Array.from(bytes)
      expect(base64(u)).toBe(Buffer.from(u).toString('base64'))
    }
  })

  it('wraps at exactly 76 characters with CRLF', () => {
    const wrapped = base64Wrapped(Uint8Array.from({ length: 500 }, (_, i) => i % 256))
    const lines = wrapped.split('\r\n')
    expect(lines.slice(0, -1).every((l) => l.length === 76)).toBe(true)
    expect(lines[lines.length - 1].length).toBeLessThanOrEqual(76)
    expect(wrapped).not.toMatch(/(^|[^\r])\n/)
  })
})

describe('RFC 2047 encoded-words', () => {
  it('leaves plain ASCII as is and encodes Hebrew as UTF-8 B-words of at most 75 chars', () => {
    expect(encodedWords('Quote RUBEDO.3D')).toEqual(['Quote RUBEDO.3D'])
    const long = 'הצעת מחיר — תחנת ריבוי צמחים עם חמש מבחנות ומעמד מודפס | RUBEDO.3D'
    const words = encodedWords(long)
    expect(words.length).toBeGreaterThan(1)
    for (const w of words) {
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
      expect(w.length).toBeLessThanOrEqual(75)
      // Every word decodes on its own (no UTF-8 character split between words).
      expect(decodeWords(w)).not.toContain('�')
    }
    expect(decodeWords(words.join(' '))).toBe(long)
  })

  it('never lets a line break into a header (no header injection)', () => {
    expect(encodeHeaderText('a\r\nBcc: x@y.z')).toBe('a Bcc: x@y.z')
    expect(decodeWords(encodeHeaderText('שלום\r\nBcc: x@y.z'))).toBe('שלום Bcc: x@y.z')
  })
})

describe('buildMimeMessage (AC28)', () => {
  const raw = buildMimeMessage(input())

  it('is ASCII only, uses CRLF line endings only, and no line exceeds 998 chars', () => {
    expect([...raw].every((ch) => ch.charCodeAt(0) < 128)).toBe(true)
    expect(raw).not.toMatch(/(^|[^\r])\n/)
    expect(raw).not.toMatch(/\r(?!\n)/)
    for (const line of raw.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998)
  })

  it('top level: MIME-Version, To (encoded name), RFC 2047 Subject, multipart/mixed with a quoted boundary', () => {
    const top = parsePart(raw)
    expect(top.headers.get('mime-version')).toBe('1.0')
    const to = top.headers.get('to') as string
    expect(to).toMatch(/<dana@example\.com>$/)
    expect(to).toMatch(/^=\?UTF-8\?B\?/)
    expect(decodeWords(to)).toBe('דנה כהן <dana@example.com>')
    const subject = top.headers.get('subject') as string
    expect(subject).toMatch(/^=\?UTF-8\?B\?/)
    expect(decodeWords(subject)).toBe('הצעת מחיר — עמדת השרשה | RUBEDO.3D')
    // The raw (folded) Subject header continues on lines starting with a space.
    const { head } = splitHead(raw)
    expect(head).toMatch(/Subject: =\?UTF-8\?B\?[^\r]+\r\n =\?UTF-8\?B\?/)
    expect(mediaType(top.headers.get('content-type'))).toBe('multipart/mixed')
    expect(top.headers.get('content-type')).toMatch(/boundary="[^"]+"/)
  })

  it('multipart/mixed = [multipart/alternative(text/plain, text/html), image/jpeg, image/png], boundaries distinct and closed', () => {
    const top = parsePart(raw)
    const mixedB = param(top.headers.get('content-type') as string, 'boundary') as string
    const mixed = multipartChildren(top.body, mixedB)
    expect(mixed.map((p) => mediaType(p.headers.get('content-type')))).toEqual(['multipart/alternative', 'image/jpeg', 'image/png'])

    const altB = param(mixed[0].headers.get('content-type') as string, 'boundary') as string
    expect(altB).not.toBe(mixedB)
    expect(mixedB.includes(altB) || altB.includes(mixedB)).toBe(false)
    const alt = multipartChildren(mixed[0].body, altB)
    expect(alt.map((p) => mediaType(p.headers.get('content-type')))).toEqual(['text/plain', 'text/html'])
    for (const p of alt) {
      expect(param(p.headers.get('content-type') as string, 'charset')?.toUpperCase()).toBe('UTF-8')
      expect(p.headers.get('content-transfer-encoding')).toBe('base64')
    }
    // Boundaries never occur inside any body.
    for (const p of [...alt, ...mixed.slice(1)]) {
      expect(p.body).not.toContain(mixedB)
      expect(p.body).not.toContain(altB)
    }
  })

  it('text and html bodies decode back to the (CRLF) input; html is RTL', () => {
    const top = parsePart(raw)
    const mixed = multipartChildren(top.body, param(top.headers.get('content-type') as string, 'boundary') as string)
    const alt = multipartChildren(mixed[0].body, param(mixed[0].headers.get('content-type') as string, 'boundary') as string)
    const text = Buffer.from(decodeBase64Body(alt[0].body)).toString('utf8')
    const html = Buffer.from(decodeBase64Body(alt[1].body)).toString('utf8')
    expect(text).toBe(input().text.replace(/\n/g, '\r\n'))
    expect(html).toContain('dir="rtl"')
    expect(html).toBe(input().html.replace(/\n/g, '\r\n'))
    for (const p of alt) {
      const lines = p.body.split('\r\n').filter((l) => l !== '')
      expect(lines.every((l) => l.length <= 76)).toBe(true)
    }
  })

  it('attachments: base64 bytes identical, Content-Disposition attachment, Hebrew filename RFC 2047-encoded, ASCII kept', () => {
    const top = parsePart(raw)
    const mixed = multipartChildren(top.body, param(top.headers.get('content-type') as string, 'boundary') as string)
    const [jpeg, png] = [mixed[1], mixed[2]]
    expect(jpeg.headers.get('content-transfer-encoding')).toBe('base64')
    expect(Array.from(decodeBase64Body(jpeg.body))).toEqual(Array.from(JPEG))
    expect(Array.from(decodeBase64Body(png.body))).toEqual(Array.from(PNG))
    expect(jpeg.body.split('\r\n').every((l) => l.length <= 76)).toBe(true)

    const disp = jpeg.headers.get('content-disposition') as string
    expect(disp.startsWith('attachment;')).toBe(true)
    const encodedName = param(disp, 'filename') as string
    expect(encodedName).toMatch(/^=\?UTF-8\?B\?/)
    expect(decodeWords(encodedName)).toBe('תמונה ראשית.jpg')
    expect(decodeWords(param(jpeg.headers.get('content-type') as string, 'name') as string)).toBe('תמונה ראשית.jpg')
    expect(param(png.headers.get('content-disposition') as string, 'filename')).toBe('plate-1.png')
  })

  it('without attachments it is still multipart/mixed containing the alternative part', () => {
    const m = buildMimeMessage(input({ attachments: [] }))
    const top = parsePart(m)
    const mixed = multipartChildren(top.body, param(top.headers.get('content-type') as string, 'boundary') as string)
    expect(mixed.map((p) => mediaType(p.headers.get('content-type')))).toEqual(['multipart/alternative'])
  })

  it('random boundaries differ between messages', () => {
    const a = parsePart(buildMimeMessage(input({ boundarySeed: undefined })))
    const b = parsePart(buildMimeMessage(input({ boundarySeed: undefined })))
    expect(a.headers.get('content-type')).not.toBe(b.headers.get('content-type'))
  })
})
