import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FOLDER_MIME } from '../../src/lib/bid'
import { MemoryDrive } from '../../src/lib/drive/memoryDrive'
import { QUOTES_FOLDER_NAME, writeQuoteLog } from '../../src/lib/drive/quoteLog'
import type { DriveFile, DriveStore } from '../../src/lib/drive/types'
import {
  assertTotalSize,
  attachmentFileName,
  AttachmentError,
  loadAttachment,
  loadAttachments,
  MAX_ATTACHMENTS_BYTES,
} from '../../src/lib/mail/attachments'
import { GMAIL_DRAFTS_CREATE_URL, GmailMailStore } from '../../src/lib/mail/gmail'
import { MemoryMail } from '../../src/lib/mail/memoryMail'
import { GMAIL_PERMISSION_MESSAGE, MailError } from '../../src/lib/mail/types'
import type { QuoteRecord } from '../../src/lib/quote'

function tokens() {
  let n = 0
  return {
    getToken: vi.fn(async () => `tok-${n}`),
    refresh: vi.fn(async () => `tok-${++n}`),
    onUnauthorized: vi.fn(),
  }
}

const MIME = 'MIME-Version: 1.0\r\nTo: <a@b.co>\r\nSubject: x\r\nContent-Type: text/plain\r\n\r\nhi\r\n'

describe('GmailMailStore (D-J: drafts.create only)', () => {
  it('POSTs the raw message as message/rfc822 to the drafts.create media upload URL and returns the draft id', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'r-42', message: { id: 'm-1' } }))
    const store = new GmailMailStore(tokens(), fetchMock as unknown as typeof fetch)
    await expect(store.createDraft(MIME)).resolves.toEqual({ draftId: 'r-42', messageId: 'm-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media')
    expect(url).toBe(GMAIL_DRAFTS_CREATE_URL)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('message/rfc822')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-0')
    expect(init.body).toBe(MIME)
  })

  it('401 → one refresh + retry; a second 401 → onUnauthorized and a Hebrew error', async () => {
    const t = tokens()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ id: 'r-1' }))
    await expect(new GmailMailStore(t, fetchMock).createDraft(MIME)).resolves.toEqual({ draftId: 'r-1' })
    expect(t.refresh).toHaveBeenCalledTimes(1)

    const t2 = tokens()
    const always401 = vi.fn(async () => new Response('', { status: 401 }))
    await expect(new GmailMailStore(t2, always401).createDraft(MIME)).rejects.toMatchObject({ status: 401 })
    expect(t2.onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('403 insufficient scope → MailError.needsPermission with "נדרש אישור נוסף ל-Gmail"', async () => {
    const body = JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } })
    const f = vi.fn(async () => new Response(body, { status: 403 }))
    const err = (await new GmailMailStore(tokens(), f).createDraft(MIME).catch((e: unknown) => e)) as MailError
    expect(err).toBeInstanceOf(MailError)
    expect(err.needsPermission).toBe(true)
    expect(err.userMessage).toBe(GMAIL_PERMISSION_MESSAGE)
  })

  it('other failures → Hebrew errors, never a fake success', async () => {
    for (const status of [400, 413, 429, 500]) {
      const err = (await new GmailMailStore(tokens(), vi.fn(async () => new Response('x', { status }))).createDraft(MIME).catch((e: unknown) => e)) as MailError
      expect(err).toBeInstanceOf(MailError)
      expect(err.needsPermission).toBe(false)
      expect(err.userMessage).toMatch(/[א-ת]/)
    }
    const noId = vi.fn(async () => Response.json({}))
    await expect(new GmailMailStore(tokens(), noId).createDraft(MIME)).rejects.toBeInstanceOf(MailError)
    const network = vi.fn(async () => {
      throw new TypeError('offline')
    })
    await expect(new GmailMailStore(tokens(), network).createDraft(MIME)).rejects.toMatchObject({ userMessage: expect.stringMatching(/Gmail/) })
  })
})

describe('MemoryMail', () => {
  it('stores drafts and can simulate failures', async () => {
    const m = new MemoryMail()
    m.failNext()
    await expect(m.createDraft(MIME)).rejects.toBeInstanceOf(MailError)
    m.failNext('permission')
    await expect(m.createDraft(MIME)).rejects.toMatchObject({ needsPermission: true })
    await expect(m.createDraft(MIME)).resolves.toMatchObject({ draftId: 'draft-1' })
    expect(m.drafts).toEqual([{ id: 'draft-1', raw: MIME }])
  })
})

// ---------------------------------------------------------------------------------------------

const img = (id: string, name: string, mimeType = 'image/heic'): DriveFile => ({ id, name, mimeType })

/** A DriveStore whose images are served by URL (like the real store) — only thumbnailUrl matters here. */
function urlDrive(): DriveStore {
  return { thumbnailUrl: (id: string, s: number) => `/api/thumb?id=${id}&s=${s}` } as unknown as DriveStore
}

describe('attachments (Q3): thumb proxy at 1600 px, content type verified, 20 MB cap', () => {
  it('fetches /api/thumb?id=…&s=1600 and names the file after its real type', async () => {
    const f = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } }))
    const a = await loadAttachment(urlDrive(), img('fileId_12345', 'IMG_0042.HEIC'), f as unknown as typeof fetch)
    expect((f.mock.calls as unknown as [string][])[0][0]).toBe('/api/thumb?id=fileId_12345&s=1600')
    expect(a).toEqual({ filename: 'IMG_0042.jpg', mimeType: 'image/jpeg', data: new Uint8Array([1, 2, 3]) })
  })

  it('refuses anything but image/jpeg|png|webp with a Hebrew error naming the photo', async () => {
    for (const type of ['image/svg+xml', 'text/html', 'image/gif', '']) {
      const f = vi.fn(async () => new Response('x', { headers: type ? { 'Content-Type': type } : {} }))
      const err = (await loadAttachment(urlDrive(), img('fileId_12345', 'bad.svg'), f as unknown as typeof fetch).catch((e: unknown) => e)) as AttachmentError
      expect(err).toBeInstanceOf(AttachmentError)
      expect(err.userMessage).toContain('bad.svg')
      expect(err.userMessage).toMatch(/JPEG/)
    }
  })

  it('proxy errors become Hebrew errors (404 no preview, 401 session, other)', async () => {
    for (const status of [401, 404, 502]) {
      const f = vi.fn(async () => new Response('', { status }))
      await expect(loadAttachment(urlDrive(), img('fileId_12345', 'a.jpg'), f as unknown as typeof fetch)).rejects.toMatchObject({
        userMessage: expect.stringMatching(/[א-ת]/),
      })
    }
  })

  it('in-memory drive: uses the preview blob (thumbnail) and its type', async () => {
    const drive = new MemoryDrive()
    const root = drive.createRootFolder('models')
    const heic = drive.addForeignFile(root, 'IMG_1.HEIC', new Blob(['heic']), 'image/heic', {
      thumbnail: new Blob([new Uint8Array([9, 9])], { type: 'image/jpeg' }),
    })
    const a = await loadAttachment(drive, await drive.getFile(heic))
    expect(a).toEqual({ filename: 'IMG_1.jpg', mimeType: 'image/jpeg', data: new Uint8Array([9, 9]) })
  })

  it('total over 20 MB → Hebrew error; exactly 20 MB is allowed', async () => {
    expect(() => assertTotalSize([{ data: new Uint8Array(MAX_ATTACHMENTS_BYTES) }])).not.toThrow()
    let over: unknown
    try {
      assertTotalSize([{ data: new Uint8Array(MAX_ATTACHMENTS_BYTES / 2) }, { data: new Uint8Array(MAX_ATTACHMENTS_BYTES / 2 + 1) }])
    } catch (e) {
      over = e
    }
    expect((over as AttachmentError).userMessage).toMatch(/20 MB/)
    const big = new Uint8Array(11 * 1024 * 1024)
    const f = vi.fn(async () => new Response(big, { headers: { 'Content-Type': 'image/jpeg' } }))
    const err = (await loadAttachments(urlDrive(), [img('fileId_aaaaa', 'a.jpg'), img('fileId_bbbbb', 'b.jpg')], f as unknown as typeof fetch).catch(
      (e: unknown) => e,
    )) as AttachmentError
    expect(err).toBeInstanceOf(AttachmentError)
    expect(err.userMessage).toMatch(/חורג מהמגבלה של 20 MB/)
  })

  it('attachmentFileName', () => {
    expect(attachmentFileName('photo.PNG', 'image/png')).toBe('photo.png')
    expect(attachmentFileName('תמונה.heic', 'image/jpeg')).toBe('תמונה.jpg')
    expect(attachmentFileName('noext', 'image/webp')).toBe('noext.webp')
  })
})

// ---------------------------------------------------------------------------------------------

function record(date = '2026-10-01T06:05:00.000Z'): QuoteRecord {
  return {
    schemaVersion: 1,
    date,
    draftId: 'r-1',
    model: { bidId: 'b', name: 'M', revision: 'V1' },
    customer: { name: 'דנה', email: 'd@e.co' },
    includedHardware: [],
    priceShown: 84,
    landed: 25,
    price70: 83.3,
    savedBid: { landed: 25, price70: 83.3 },
    attachments: [],
  }
}

describe('quote log (Q4, AC30): <model>/quotes/quote-YYYYMMDD-HHmm.json, marked, create-only', () => {
  it('creates the marked quotes folder once, then a new marked JSON file per quote; nothing is ever updated', async () => {
    const drive = new MemoryDrive()
    const root = drive.createRootFolder('models')
    const model = drive.addForeignFolder(root, 'Founder model')
    const now = new Date(2026, 9, 1, 9, 5)
    const first = await writeQuoteLog(drive, model, record(), now)
    expect(first.name).toBe('quote-20261001-0905.json')
    const second = await writeQuoteLog(drive, model, record(), now)
    expect(second.name).toBe('quote-20261001-0905-2.json')
    expect(second.folderId).toBe(first.folderId)

    const folders = (await drive.listChildren(model)).filter((f) => f.mimeType === FOLDER_MIME)
    expect(folders).toHaveLength(1)
    expect(folders[0]).toMatchObject({ name: QUOTES_FOLDER_NAME, appCreated: true })
    const files = await drive.listChildren(first.folderId)
    expect(files.map((f) => [f.name, f.appCreated])).toEqual([
      ['quote-20261001-0905.json', true],
      ['quote-20261001-0905-2.json', true],
    ])
    expect(JSON.parse(await drive.readText(files[0].id))).toEqual(record())
    expect(drive.writeTargets.map((w) => w.op)).toEqual(['createFolder', 'uploadFile', 'uploadFile'])
  })

  it('a Founder-made "quotes" folder is left alone (the app creates its own marked one)', async () => {
    const drive = new MemoryDrive()
    const root = drive.createRootFolder('models')
    const model = drive.addForeignFolder(root, 'M')
    const foreign = drive.addForeignFolder(model, 'quotes')
    const w = await writeQuoteLog(drive, model, record(), new Date(2026, 9, 1, 9, 5))
    expect(w.folderId).not.toBe(foreign)
    expect(await drive.listChildren(foreign)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------

function codeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? codeFiles(p) : /\.(ts|tsx|js|mjs)$/.test(n) ? [p] : []
  })
}

describe('AC29.static — no Gmail endpoint other than drafts.create in src/ or api/', () => {
  it('every Gmail API URL is the drafts.create upload URL; no send/modify/read/remove endpoints anywhere', () => {
    const offenders: string[] = []
    const endpoints: string[] = []
    for (const f of [...codeFiles(resolve(process.cwd(), 'src')), ...codeFiles(resolve(process.cwd(), 'api'))]) {
      const code = readFileSync(f, 'utf8')
      for (const m of code.matchAll(/https?:\/\/gmail\.googleapis\.com\/[^\s'"`)]*/g)) endpoints.push(m[0])
      for (const m of code.matchAll(/gmail\.googleapis\.com[^\s'"`)]*/g)) {
        if (m[0] !== 'gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media') offenders.push(`${f}: ${m[0]}`)
      }
      if (/\/gmail\/v1\/users\/[^'"`\s]*\/(messages|threads|labels|history|settings)\b/.test(code)) offenders.push(`${f}: gmail messages/threads/…`)
      if (/\/drafts\/[^'"`\s]*\/send|drafts\/send|messages\/send|\/send\b['"`]/.test(code)) offenders.push(`${f}: send endpoint`)
      if (/gmail\.(send|modify|readonly|insert|labels|metadata)\b|mail\.google\.com\/(?!mail\/#drafts)/.test(code)) offenders.push(`${f}: other Gmail scope/URL`)
    }
    expect(offenders).toEqual([])
    expect(new Set(endpoints)).toEqual(new Set([GMAIL_DRAFTS_CREATE_URL]))
  })

  it('MailStore exposes exactly one operation: createDraft', () => {
    const types = readFileSync(resolve(process.cwd(), 'src/lib/mail/types.ts'), 'utf8')
    const start = types.indexOf('export interface MailStore')
    const iface = types.slice(start, types.indexOf('\n}', start))
    const methods = [...iface.matchAll(/^\s+(\w+)\s*\(/gm)].map((m) => m[1])
    expect(methods).toEqual(['createDraft'])
  })

  it('login asks for gmail.compose only (no broader Gmail scope); vercel.json CSP allows connect to gmail.googleapis.com', () => {
    const google = readFileSync(resolve(process.cwd(), 'api/_lib/google.ts'), 'utf8')
    expect(google).toContain("'https://www.googleapis.com/auth/gmail.compose'")
    expect(google).not.toMatch(/auth\/gmail\.(send|modify|readonly)|mail\.google\.com\/'/)
    const cfg = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')) as { headers: { headers: { key: string; value: string }[] }[] }
    const csp = cfg.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy')?.value ?? ''
    const connect = (csp.split(';').find((d) => d.trim().startsWith('connect-src')) ?? '').trim().split(/\s+/)
    expect(connect).toContain('https://gmail.googleapis.com')
  })
})

// ---------------------------------------------------------------------------------------------
describe('v0.5 fix round — Gmail failure classification', () => {
  it('I2: 403 accessNotConfigured / SERVICE_DISABLED / "has not been used" → the Hebrew "Gmail API לא מופעל" message (not a permission prompt)', async () => {
    const bodies = [
      JSON.stringify({ error: { code: 403, errors: [{ reason: 'accessNotConfigured' }], message: 'Gmail API has not been used in project 123 before or it is disabled.' } }),
      JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }),
      'Gmail API has not been used in project 1 before',
    ]
    for (const body of bodies) {
      const f = vi.fn(async () => new Response(body, { status: 403 }))
      const err = (await new GmailMailStore(tokens(), f).createDraft(MIME).catch((e: unknown) => e)) as MailError
      expect(err.userMessage).toBe('Gmail API לא מופעל בפרויקט Google Cloud — יש להפעיל אותו ולנסות שוב')
      expect(err.needsPermission).toBe(false)
      expect(err.outcome).toBe('not-created')
    }
  })

  it('M1: 5xx, network error and a 2xx with a bad body → outcome "unknown"; 4xx → "not-created"', async () => {
    const outcome = async (f: () => Promise<Response>) =>
      ((await new GmailMailStore(tokens(), vi.fn(f) as unknown as typeof fetch).createDraft(MIME).catch((e: unknown) => e)) as MailError).outcome
    expect(await outcome(async () => new Response('x', { status: 500 }))).toBe('unknown')
    expect(await outcome(async () => new Response('x', { status: 503 }))).toBe('unknown')
    expect(
      await outcome(async () => {
        throw new TypeError('connection reset')
      }),
    ).toBe('unknown')
    expect(await outcome(async () => new Response('not json', { status: 200 }))).toBe('unknown')
    expect(await outcome(async () => Response.json({ nope: 1 }))).toBe('unknown')
    for (const status of [400, 404, 413, 429]) expect(await outcome(async () => new Response('x', { status }))).toBe('not-created')
  })
})
