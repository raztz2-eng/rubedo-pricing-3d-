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

  it('updates content with PATCH uploadType=media after checking the app created the file', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: 'F', name: 'bid.json', mimeType: 'application/json', isAppAuthorized: true }))
      .mockResolvedValueOnce(json({ id: 'F' }))
    await new GoogleDriveStore(tokens(), fetchMock).updateFileContent('F', new Blob(['x']), 'application/json')
    const meta = new URL(String(fetchMock.mock.calls[0][0]))
    expect(meta.pathname).toBe('/drive/v3/files/F')
    expect(meta.searchParams.get('fields')).toContain('isAppAuthorized')
    const [url, init] = fetchMock.mock.calls[1]
    expect(String(url)).toBe('https://www.googleapis.com/upload/drive/v3/files/F?uploadType=media&fields=id')
    expect(init?.method).toBe('PATCH')
  })

  it('AC17: refuses to update a file the app did not create (no PATCH is sent)', async () => {
    for (const meta of [{ isAppAuthorized: false }, {}]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 'F', name: 'photo.jpg', mimeType: 'image/jpeg', ...meta }))
      const err = await new GoogleDriveStore(tokens(), fetchMock)
        .updateFileContent('F', new Blob(['x']), 'application/json')
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DriveError)
      expect((err as DriveError).status).toBe(403)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true)
    }
  })

  it('lists with thumbnailLink and isAppAuthorized and maps them', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json({ files: [{ id: '1', name: 'IMG.HEIC', mimeType: 'image/heic', thumbnailLink: 'https://lh3.googleusercontent.com/x=s220', isAppAuthorized: false }] }),
    )
    const files = await new GoogleDriveStore(tokens(), fetchMock).listChildren('D')
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('fields')).toContain('thumbnailLink')
    expect(files[0]).toMatchObject({ thumbnailLink: 'https://lh3.googleusercontent.com/x=s220', appCreated: false })
  })

  it('reads a thumbnail with the bearer token and without the 401-refresh path', async () => {
    const t = tokens()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('img', { status: 200 }))
    const store = new GoogleDriveStore(t, fetchMock)
    const blob = await store.readThumbnail('https://lh3.googleusercontent.com/abc=s800')
    expect(await blob.text()).toBe('img')
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer t0')

    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
    await expect(store.readThumbnail('https://lh3.googleusercontent.com/abc=s800')).rejects.toBeInstanceOf(DriveError)
    expect(t.refresh).not.toHaveBeenCalled()
  })

  it('never sends the token to a non-Google thumbnail host', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    await expect(new GoogleDriveStore(tokens(), fetchMock).readThumbnail('https://evil.example.com/x')).rejects.toBeInstanceOf(DriveError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('has no delete or move operation', () => {
    const proto = GoogleDriveStore.prototype as unknown as Record<string, unknown>
    for (const name of ['deleteFile', 'delete', 'trash', 'moveFile', 'move']) expect(proto[name]).toBeUndefined()
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
