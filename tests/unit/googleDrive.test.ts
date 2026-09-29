import { describe, expect, it, vi } from 'vitest'
import { buildListQuery, escapeQueryValue, GoogleDriveStore } from '../../src/lib/drive/googleDrive'
import { DriveError } from '../../src/lib/drive/types'

function tokens() {
  let n = 0
  return {
    getToken: vi.fn(async () => `t${n}`),
    refresh: vi.fn(async () => `t${++n}`),
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('query building', () => {
  it("escapes quotes and backslashes", () => {
    expect(escapeQueryValue("Raz's \\ stand")).toBe("Raz\\'s \\\\ stand")
    expect(buildListQuery('F1', { name: "a'b", foldersOnly: true })).toBe(
      "'F1' in parents and trashed = false and name = 'a\\'b' and mimeType = 'application/vnd.google-apps.folder'",
    )
  })
})

describe('GoogleDriveStore', () => {
  it('lists with q and follows pagination, sending the bearer token', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ files: [{ id: '1', name: 'a', mimeType: 'x' }], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(json({ files: [{ id: '2', name: 'b', mimeType: 'x' }] }))
    const store = new GoogleDriveStore(tokens(), fetchMock)
    const files = await store.listChildren('ROOT', { name: 'bid.json' })
    expect(files.map((f) => f.id)).toEqual(['1', '2'])
    const [url1, init1] = fetchMock.mock.calls[0]
    const u = new URL(String(url1))
    expect(u.origin + u.pathname).toBe('https://www.googleapis.com/drive/v3/files')
    expect(u.searchParams.get('q')).toBe("'ROOT' in parents and trashed = false and name = 'bid.json'")
    expect((init1?.headers as Record<string, string>).Authorization).toBe('Bearer t0')
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('pageToken')).toBe('p2')
  })

  it('uploads with multipart/related to the upload endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'new', name: 'bid.json', mimeType: 'application/json' }))
    const store = new GoogleDriveStore(tokens(), fetchMock)
    const f = await store.uploadFile('FOLDER', 'bid.json', new Blob(['{"a":1}']), 'application/json')
    expect(f.id).toBe('new')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=multipart/)
    expect(init?.method).toBe('POST')
    const ct = (init?.headers as Record<string, string>)['Content-Type']
    expect(ct).toMatch(/^multipart\/related; boundary=/)
    const boundary = ct.split('boundary=')[1]
    const text = await (init?.body as Blob).text()
    expect(text).toContain(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8`)
    expect(text).toContain('"parents":["FOLDER"]')
    expect(text).toContain('{"a":1}')
    expect(text.endsWith(`--${boundary}--`)).toBe(true)
  })

  it('uploads binary content byte-exact inside the multipart body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'bin', name: 'p.png', mimeType: 'image/png' }))
    const store = new GoogleDriveStore(tokens(), fetchMock)
    const bytes = new Uint8Array([0, 255, 137, 80])
    await store.uploadFile('FOLDER', 'p.png', new Blob([bytes], { type: 'image/png' }), 'image/png')
    const init = fetchMock.mock.calls[0][1]
    const ct = (init?.headers as Record<string, string>)['Content-Type']
    const boundary = ct.split('boundary=')[1]
    const body = new Uint8Array(await (init?.body as Blob).arrayBuffer())
    const header = new TextEncoder().encode(`\r\n--${boundary}\r\nContent-Type: image/png\r\n\r\n`)
    const footer = new TextEncoder().encode(`\r\n--${boundary}--`)
    const find = (needle: Uint8Array) => {
      outer: for (let i = 0; i <= body.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (body[i + j] !== needle[j]) continue outer
        return i
      }
      return -1
    }
    const start = find(header)
    expect(start).toBeGreaterThan(0)
    const dataStart = start + header.length
    expect(Array.from(body.slice(dataStart, dataStart + 4))).toEqual([0, 255, 137, 80])
    expect(Array.from(body.slice(dataStart + 4))).toEqual(Array.from(footer))
  })

  it('updates content with PATCH uploadType=media', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'F' }))
    await new GoogleDriveStore(tokens(), fetchMock).updateFileContent('F', new Blob(['x']), 'application/json')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://www.googleapis.com/upload/drive/v3/files/F?uploadType=media&fields=id')
    expect(init?.method).toBe('PATCH')
  })

  it('creates folders with the folder mime type', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'D', name: 'M', mimeType: 'application/vnd.google-apps.folder' }))
    await new GoogleDriveStore(tokens(), fetchMock).createFolder('P', 'M')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      name: 'M',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['P'],
    })
  })

  it('refreshes the token once on 401 and retries', async () => {
    const t = tokens()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('hello', { status: 200 }))
    const text = await new GoogleDriveStore(t, fetchMock).readText('F')
    expect(text).toBe('hello')
    expect(t.refresh).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>).Authorization).toBe('Bearer t1')
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://www.googleapis.com/drive/v3/files/F?alt=media')
  })

  it('throws a DriveError with a Hebrew message on failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 404 }))
    const err = await new GoogleDriveStore(tokens(), fetchMock).readBlob('X').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DriveError)
    expect((err as DriveError).status).toBe(404)
    expect((err as DriveError).userMessage).toMatch(/[א-ת]/)
  })
})
