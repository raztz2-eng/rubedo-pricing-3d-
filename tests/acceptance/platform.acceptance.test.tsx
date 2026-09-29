import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoogleAuth } from '../../src/lib/auth/googleAuth'
import { localFolderPointer, type AppServices } from '../../src/state/services'
import { addManualPart, newServices, renderApp, saveButton, setValue } from './helpers'

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file'
const TOKEN = 'ya29.ACCEPTANCE-SECRET-TOKEN'

function srcFiles(dir = resolve(process.cwd(), 'src')): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? srcFiles(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })
}

function allPersisted(): string {
  const vals: string[] = []
  for (const s of [localStorage, sessionStorage]) {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i) as string
      vals.push(k, s.getItem(k) ?? '')
    }
  }
  vals.push(document.cookie)
  return vals.join('|')
}

// ---------------------------------------------------------------------------------------------
describe('AC12 — only drive.file scope; access token never persisted', () => {
  afterEach(() => {
    delete (window as Window).google
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('AC12.ui: signing in through the header requests exactly drive.file; token not in local/sessionStorage or cookies; sign-out revokes', async () => {
    const configs: GoogleTokenClientConfig[] = []
    const requests: unknown[] = []
    const revoke = vi.fn()
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (c: GoogleTokenClientConfig) => {
            configs.push(c)
            return {
              requestAccessToken: (o?: unknown) => {
                requests.push(o)
                setTimeout(() => c.callback({ access_token: TOKEN, expires_in: 3600, scope: DRIVE_FILE }), 0)
              },
            }
          },
          revoke,
        },
      },
    } as unknown as Window['google']
    vi.spyOn(document.head, 'appendChild').mockImplementation((el) => {
      queueMicrotask(() => (el as HTMLScriptElement).onload?.(new Event('load')))
      return el
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const cookieWrites: string[] = []
    const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
    vi.spyOn(document, 'cookie', 'set').mockImplementation((v: string) => {
      cookieWrites.push(v)
      cookieDesc?.set?.call(document, v)
    })

    const auth = new GoogleAuth('test-client-id')
    const services: AppServices = {
      mode: 'google',
      drive: null,
      auth,
      folderPointer: localFolderPointer,
      pickFolder: async () => ({ id: 'picked-folder-id', name: 'models' }),
    }
    const user = userEvent.setup()
    renderApp(services, '/')
    await user.click(screen.getByRole('button', { name: 'התחברות עם Google' }))
    await screen.findByText('מחובר ל-Google')

    expect(configs).toHaveLength(1)
    expect(configs[0].scope).toBe(DRIVE_FILE)
    expect(configs[0].scope.split(/\s+/)).toEqual([DRIVE_FILE])
    expect(await auth.getToken()).toBe(TOKEN)

    // The folder pointer is the only thing the app may persist — and it is an ID, not a token.
    localFolderPointer.set('picked-folder-id')
    expect(allPersisted()).not.toContain(TOKEN)
    for (const call of setItem.mock.calls) expect(String(call[1])).not.toContain(TOKEN)
    for (const c of cookieWrites) expect(c).not.toContain(TOKEN)
    expect(localStorage.getItem('rubedo.modelsFolderId')).toBe('picked-folder-id')

    await user.click(screen.getByRole('button', { name: 'התנתקות' }))
    expect(revoke).toHaveBeenCalledWith(TOKEN)
    await screen.findByRole('button', { name: 'התחברות עם Google' })
    await expect(auth.getToken()).rejects.toThrow()
  })

  it('AC12.static: no other OAuth scope and no token persistence anywhere in src/', () => {
    const scopes = new Set<string>()
    const offenders: string[] = []
    for (const f of srcFiles()) {
      const code = readFileSync(f, 'utf8')
      for (const m of code.matchAll(/https:\/\/www\.googleapis\.com\/auth\/[\w.\-/]+/g)) scopes.add(m[0])
      if (/document\.cookie\s*=/.test(code)) offenders.push(`${f}: writes document.cookie`)
      if (/sessionStorage\.setItem|indexedDB\.open/.test(code)) offenders.push(`${f}: sessionStorage/indexedDB write`)
      for (const m of code.matchAll(/localStorage\.setItem\(([^)]*)\)/g)) {
        if (!/MODELS_FOLDER_KEY/.test(m[1])) offenders.push(`${f}: localStorage.setItem(${m[1]})`)
      }
    }
    expect([...scopes]).toEqual([DRIVE_FILE])
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
const HEBREW = /[֐-׿]/

/** Base (unprefixed = mobile) classes that force a width above 375 px. */
function wideClasses(root: HTMLElement): string[] {
  const bad: string[] = []
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') ?? '')
    for (const token of cls.split(/\s+/)) {
      if (!token || token.includes(':')) continue // responsive/state variants apply only above mobile
      let m = token.match(/^(?:min-)?w-\[(\d+(?:\.\d+)?)px\]$/)
      if (m && Number(m[1]) > 375) bad.push(token)
      m = token.match(/^(?:min-)?w-(\d+)$/)
      if (m && Number(m[1]) * 4 > 375) bad.push(token)
      m = token.match(/^grid-cols-\[(.+)\]$/)
      if (m) {
        const px = [...m[1].matchAll(/(\d+)px/g)].reduce((a, x) => a + Number(x[1]), 0)
        if (px > 375) bad.push(token)
      }
    }
    const w = el.style.width || el.style.minWidth
    if (/px$/.test(w) && parseFloat(w) > 375) bad.push(`style width ${w}`)
  }
  return bad
}

describe('AC13 — Hebrew RTL UI, usable at 375 px', () => {
  it('AC13.html: index.html declares lang="he", dir="rtl" and a device-width viewport', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
    const tag = html.match(/<html[^>]*>/)?.[0] ?? ''
    expect(tag).toMatch(/\blang="he"/)
    expect(tag).toMatch(/\bdir="rtl"/)
    expect(html).toMatch(/<meta[^>]+name="viewport"[^>]+width=device-width/)
  })

  it.each([
    ['/', 'Home'],
    ['/new', 'New model'],
    ['/library', 'Library'],
    ['/settings', 'Settings'],
  ])('AC13.page %s (%s): Hebrew headings/buttons, numeric inputs LTR, no fixed width > 375 px at mobile', async (path) => {
    const { services } = newServices()
    const { container } = renderApp(services, path)
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 }).length).toBeGreaterThan(0))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    for (const h of screen.getAllByRole('heading')) expect(h.textContent, 'heading text').toMatch(HEBREW)
    for (const b of [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')]) {
      const label = b.getAttribute('aria-label') ?? b.textContent ?? ''
      if (label.trim()) if (!/RUBEDO/.test(label)) expect(label, 'button/link label').toMatch(HEBREW)
    }
    for (const input of Array.from(container.querySelectorAll('input[type="number"]'))) {
      expect(input.getAttribute('dir')).toBe('ltr')
    }
    expect(wideClasses(container)).toEqual([])
  })

  it('AC13.model-page: saved model page has Hebrew headings and no fixed width > 375 px; wide tables scroll', async () => {
    const user = userEvent.setup()
    const { services } = newServices()
    const { container } = renderApp(services, '/new')
    setValue(await screen.findByLabelText(/^שם \*$/), 'דגם')
    await addManualPart(user, '100', '3.5')
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'דגם' })
    for (const h of screen.getAllByRole('heading')) expect(h.textContent).toMatch(HEBREW)
    expect(wideClasses(container)).toEqual([])
    for (const t of Array.from(container.querySelectorAll('table'))) {
      expect(t.closest('.overflow-x-auto') ?? t.closest('.card'), 'table container').not.toBeNull()
    }
  })

  it.skip('AC13.visual: actual rendering at 375 px (no horizontal scroll, tap targets, RTL mirroring) — NOT COVERABLE in jsdom (no layout engine); needs a real browser check', () => {})
})
