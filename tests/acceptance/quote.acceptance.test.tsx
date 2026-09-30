/**
 * Addendum v0.5 — quote e-mail as a Gmail DRAFT (D-J, Q3, Q4, Q5). AC27–AC31.
 *
 * Two worlds, both outside-in:
 *  - the in-memory Drive + MemoryMail fake (createMemoryServices), and
 *  - the production objects (SessionAuth + GoogleDriveStore + GmailMailStore) through the fake browser, the real /api
 *    handlers (incl. the thumbnail proxy) and a fake Google that also fakes the Gmail API (google-world.ts).
 * Drafts are read with an independent MIME reader (mime-parse.ts), not with the app's code.
 *
 * Reference model: T0 inputs (brief §7, laborRate 20 in the bid's snapshot: landed ₪15.01, 70% ₪50.04) + optional
 * hardware "Plant cutting" 2×₪7.50 (included) and "Ceramic pot" 1×₪4 (not included).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Browser, DRIVE_SCOPE, FOUNDER, GMAIL_COMPOSE_SCOPE, GMAIL_DRAFTS_CREATE_PATHS, GoogleWorld, USERINFO_EMAIL_SCOPE } from './google-world'
import { addManualPart, navLink, newServices, renderApp, saveButton, setValue, stubObjectUrls } from './helpers'
import { attachmentName, decodeHeaderText, dispositionType, header, leaves, lineProblems, parseEntity, textOf, type MimeEntity } from './mime-parse'
import {
  bidJson,
  googleQuoteServices,
  JPG_BYTES,
  memoryQuoteModel,
  MODEL_DESCRIPTION,
  MODEL_NAME,
  numbersIn,
  PLANT,
  POT,
  stringsIn,
  worldQuoteModel,
} from './v05-fixtures'

const MODELS_FOLDER_KEY = 'rubedo.modelsFolderId'
const PERMISSION_TEXT = 'נדרש אישור נוסף ל-Gmail'
const CREATE_DRAFT = 'צור טיוטה ב-Gmail'
const SUBJECT = `הצעת מחיר — ${MODEL_NAME} | RUBEDO.3D`
const SIGNATURE = 'RUBEDO.3D — הדפסות תלת-ממד בהתאמה אישית'
const DRAFTS_URL = 'https://mail.google.com/mail/#drafts'
const HEBREW = /[֐-׿]/

/** Internal numbers of the reference quote (Plant included) that must never reach the customer. */
const INTERNAL_VALUES = ['9.35', '3.33', '2.33', '15.00', '30.01', '60.02', '75.03', '100.04', '7.50', '4.00', '0.66', '50.04']

// ---------- page helpers ----------

async function quoteReady(): Promise<HTMLInputElement> {
  return (await screen.findByLabelText('מחיר ללקוח', {}, { timeout: 4000 })) as HTMLInputElement
}

function priceField(): HTMLInputElement {
  return screen.getByLabelText('מחיר ללקוח') as HTMLInputElement
}

function hardwareBox(name: string): HTMLInputElement {
  return within(screen.getByRole('region', { name: 'חומרה בהצעה' })).getByRole('checkbox', { name: new RegExp(name) }) as HTMLInputElement
}

function internal70(): string {
  const t = screen.getByTestId('quote-price-70').textContent ?? ''
  return (t.match(/₪[\d,]+\.\d{2}/) ?? [''])[0]
}

function fillCustomer(o: { name?: string; email?: string; delivery?: string; note?: string } = {}) {
  setValue(screen.getByLabelText(/^שם הלקוח/), o.name ?? 'דנה כהן')
  setValue(screen.getByLabelText(/^מייל הלקוח/), o.email ?? 'dana@example.com')
  if (o.delivery !== undefined) setValue(screen.getByLabelText(/^זמן אספקה/), o.delivery)
  if (o.note !== undefined) setValue(screen.getByLabelText(/^הערה/), o.note)
}

async function createDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: CREATE_DRAFT }))
}

async function draftSucceeded() {
  const link = await screen.findByRole('link', { name: /טיוטות/ }, { timeout: 4000 })
  expect(link.getAttribute('href')).toBe(DRAFTS_URL)
}

// ---------- mail helpers ----------

interface ParsedDraft {
  root: MimeEntity
  subject: string
  subjectRaw: string
  text: string
  html: string
  attachments: MimeEntity[]
}

function readDraft(raw: string): ParsedDraft {
  expect(lineProblems(raw), 'RFC 5322 line rules (CRLF, 7-bit, ≤998)').toEqual([])
  const root = parseEntity(raw)
  expect(header(root, 'MIME-Version')?.trim()).toBe('1.0')
  expect(root.type).toBe('multipart/mixed')
  const [alt, ...rest] = root.parts
  expect(alt.type).toBe('multipart/alternative')
  expect(alt.parts.map((p) => p.type)).toEqual(['text/plain', 'text/html'])
  for (const p of alt.parts) expect((p.params.charset ?? '').toLowerCase()).toBe('utf-8')
  const subjectRaw = header(root, 'Subject') ?? ''
  return {
    root,
    subjectRaw,
    subject: decodeHeaderText(subjectRaw).text,
    text: textOf(alt.parts[0]),
    html: textOf(alt.parts[1]),
    attachments: rest,
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function srcAndApiFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs)$/.test(n) ? [p] : []
    })
  return [...walk(resolve(process.cwd(), 'src')), ...walk(resolve(process.cwd(), 'api'))]
}

// ---------- google world ----------

async function googleSetup(o: { grantedScope?: string; sideThumb?: Uint8Array } = {}) {
  const world = new GoogleWorld()
  const root = world.addFolder('founder-drive-root', 'models', { id: 'root_models_folder' })
  localStorage.setItem(MODELS_FOLDER_KEY, root)
  const model = worldQuoteModel(world, root, { sideThumb: o.sideThumb })
  const browser = new Browser(world)
  const cb = await browser.signInAtGoogle(FOUNDER, o.grantedScope ? { grantedScope: o.grantedScope } : {})
  expect(cb.status).toBe(302)
  // The page's own fetch (used for /api/thumb attachments) = the browser's same-origin fetch.
  vi.stubGlobal('fetch', browser.spaFetch)
  const services = googleQuoteServices(browser)
  return { world, root, model, browser, services }
}

let restoreUrls: () => void
beforeEach(() => {
  restoreUrls = stubObjectUrls()
})
afterEach(() => {
  restoreUrls()
  localStorage.clear()
  sessionStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------------------------
describe('AC27 — quote screen: toggling hardware updates the price live; default customer price = ceil(price70 of current selection)', () => {
  it('AC27.entry (Q3): a priced model page has "שליחת הצעת מחיר", which opens /model/:id/quote', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const m = await memoryQuoteModel(services, root)
    renderApp(services, `/model/${m.folderId}`)
    const link = await screen.findByRole('link', { name: 'שליחת הצעת מחיר' })
    expect(link.getAttribute('href')).toBe(`/model/${m.folderId}/quote`)
    await user.click(link)
    await quoteReady()
    expect(screen.getByRole('button', { name: CREATE_DRAFT })).toBeTruthy()
  })

  it('AC27.live: pre-ticked from the bid (Plant on, Pot off) → ₪100.04 / 101; untick Plant → T0 ₪50.04 / 51; tick Pot → ₪63.37 / 64; both → ₪113.37 / 114 — all with the bid\'s snapshot (laborRate 20), not current Settings (80)', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const m = await memoryQuoteModel(services, root)
    renderApp(services, `/model/${m.folderId}/quote`)
    await quoteReady()
    expect(hardwareBox(PLANT.name).checked).toBe(true)
    expect(hardwareBox(POT.name).checked).toBe(false)
    expect(internal70()).toBe('₪100.04')
    expect(priceField().value).toBe('101')

    await user.click(hardwareBox(PLANT.name))
    expect(internal70()).toBe('₪50.04') // = T0 (brief §7)
    expect(priceField().value).toBe('51')

    await user.click(hardwareBox(POT.name))
    expect(internal70()).toBe('₪63.37')
    expect(priceField().value).toBe('64')

    await user.click(hardwareBox(PLANT.name))
    expect(internal70()).toBe('₪113.37')
    expect(priceField().value).toBe('114')

    // The quote screen never changes the saved bid.
    const saved = JSON.parse(await services.drive.readText(m.bidFileId))
    expect(saved.hardware.map((h: { included: boolean }) => h.included)).toEqual([true, false])
  })

  it('AC27.ceil-exact: a 70% price of exactly ₪100.00 defaults to 100 (rounding UP never adds a shekel to a whole price)', async () => {
    const { services, root } = newServices()
    const folder = await services.drive.createFolder(root, 'Kit only')
    const json = bidJson({ schemaVersion: 2, name: 'Kit only', grams: 0, hours: 0, laborMinutes: 0, hardware: [{ name: 'Kit', qty: 1, unitCost: 30, included: true }] })
    await services.drive.uploadFile(folder.id, 'bid.json', new Blob([JSON.stringify(json)]), 'application/json')
    renderApp(services, `/model/${folder.id}/quote`)
    await quoteReady()
    expect(internal70()).toBe('₪100.00')
    expect(priceField().value).toBe('100')
  })

  it('AC27.editable: the customer price is an editable field (Q3)', async () => {
    const { services, root } = newServices()
    const m = await memoryQuoteModel(services, root)
    renderApp(services, `/model/${m.folderId}/quote`)
    await quoteReady()
    setValue(priceField(), '120')
    expect(priceField().value).toBe('120')
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC28 — draft MIME: multipart/mixed ⊃ multipart/alternative(text+html), RFC 2047 UTF-8 subject, base64 image/jpeg attachments; drafts.create only', () => {
  it('AC28.google: production wiring → exactly one drafts.create; valid MIME; Hebrew subject RFC 2047; the HEIC cover (default selection) attached as base64 image/jpeg via /api/thumb at 1600 px', async () => {
    const user = userEvent.setup()
    const { world, model, browser, services } = await googleSetup()
    renderApp(services, `/model/${model.folderId}/quote`)
    await quoteReady()
    fillCustomer({ delivery: '5–7 ימי עסקים', note: 'אפשר גם בצבע ירוק' })
    await createDraft(user)
    await draftSucceeded()

    // Gmail API: one call, drafts.create, nothing else.
    const gmail = world.gmailCalls()
    expect(gmail.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toHaveLength(1)
    expect(gmail[0].method).toBe('POST')
    expect(GMAIL_DRAFTS_CREATE_PATHS).toContain(new URL(gmail[0].url).pathname)
    expect(world.drafts).toHaveLength(1)

    const d = readDraft(world.drafts[0].raw)
    // RFC 2047: the Subject header is ASCII encoded-words; decoded it is the brief's subject.
    expect(d.subjectRaw).toMatch(/=\?UTF-8\?[BQ]\?/i)
    expect(decodeHeaderText(d.subjectRaw).words.length).toBeGreaterThan(0)
    expect(d.subject).toBe(SUBJECT)
    expect(header(d.root, 'To') ?? '').toContain('dana@example.com')
    expect(d.text).toMatch(HEBREW)
    expect(d.html).toMatch(/dir\s*=\s*["']?rtl/i)

    // Default photo selection = cover only (the HEIC), attached as JPEG bytes from the thumbnail.
    expect(d.attachments).toHaveLength(1)
    const a = d.attachments[0]
    expect(a.type).toBe('image/jpeg')
    expect((header(a, 'Content-Transfer-Encoding') ?? '').trim().toLowerCase()).toBe('base64')
    expect(dispositionType(a)).toBe('attachment')
    expect(Array.from(a.bytes)).toEqual(Array.from(JPG_BYTES))
    expect(attachmentName(a) ?? '').toMatch(/\.jpe?g$/i)
    const thumbReqs = browser.exchanges.filter((e) => e.path.startsWith('/api/thumb'))
    expect(thumbReqs.some((e) => e.path.includes(`id=${model.coverId}`) && /[?&]s=1600\b/.test(e.path))).toBe(true)
  })

  it('AC28.photos: ticking a second photo attaches both, each base64 image/jpeg, in a structurally valid message', async () => {
    const user = userEvent.setup()
    const { world, model, services } = await googleSetup()
    renderApp(services, `/model/${model.folderId}/quote`)
    await quoteReady()
    fillCustomer()
    const side = screen.getByRole('checkbox', { name: /side\.jpg/ }) as HTMLInputElement
    expect(side.checked).toBe(false)
    expect((screen.getByRole('checkbox', { name: /IMG_0042\.HEIC/ }) as HTMLInputElement).checked).toBe(true)
    await user.click(side)
    await createDraft(user)
    await draftSucceeded()
    const d = readDraft(world.drafts[0].raw)
    expect(d.attachments.map((x) => x.type)).toEqual(['image/jpeg', 'image/jpeg'])
    for (const x of d.attachments) expect((header(x, 'Content-Transfer-Encoding') ?? '').trim().toLowerCase()).toBe('base64')
    // Only text/plain, text/html and the images as leaves.
    expect(leaves(d.root).map((l) => l.type)).toEqual(['text/plain', 'text/html', 'image/jpeg', 'image/jpeg'])
  })

  it('AC28.cap (Q3): attachments over 20 MB → clear Hebrew error; no Gmail call, no draft, nothing written', async () => {
    const user = userEvent.setup()
    const big = new Uint8Array(21 * 1024 * 1024)
    big.set([0xff, 0xd8, 0xff, 0xe0])
    const { world, model, services } = await googleSetup({ sideThumb: big })
    renderApp(services, `/model/${model.folderId}/quote`)
    await quoteReady()
    fillCustomer()
    await user.click(screen.getByRole('checkbox', { name: /side\.jpg/ }))
    const writesBefore = world.driveWrites().length
    await createDraft(user)
    await waitFor(
      () => expect(screen.getAllByRole('alert').some((x) => /20\s*MB/.test(x.textContent ?? '') && HEBREW.test(x.textContent ?? ''))).toBe(true),
      { timeout: 8000 },
    )
    expect(world.gmailCalls()).toEqual([])
    expect(world.drafts).toEqual([])
    expect(world.driveWrites().length).toBe(writesBefore)
  }, 20000)

  it('AC28.memory: the in-memory MailStore receives the same valid structure (multipart/mixed ⊃ alternative text+html)', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const m = await memoryQuoteModel(services, root)
    renderApp(services, `/model/${m.folderId}/quote`)
    await quoteReady()
    fillCustomer()
    await createDraft(user)
    await draftSucceeded()
    expect(services.mail.drafts).toHaveLength(1)
    const d = readDraft(services.mail.drafts[0].raw)
    expect(d.subject).toBe(SUBJECT)
    expect(d.attachments).toHaveLength(1)
    for (const x of d.attachments) expect((header(x, 'Content-Transfer-Encoding') ?? '').trim().toLowerCase()).toBe('base64')
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC29 — static: no Gmail endpoint other than drafts.create in src/ or api/; no internal cost fields in the e-mail', () => {
  it('AC29.static-endpoints: every Gmail API URL in src/ and api/ is users/me/drafts (create); no send/modify/trash/delete/read endpoints', () => {
    const found: string[] = []
    const forbidden: string[] = []
    for (const f of srcAndApiFiles()) {
      const code = readFileSync(f, 'utf8')
      for (const m of code.matchAll(/[A-Za-z0-9.:/_-]*gmail\/v1\/[^\s'"`)]*/g)) found.push(`${f}: ${m[0]}`)
      for (const m of code.matchAll(/gmail\.googleapis\.com[^\s'"`)]*/g)) found.push(`${f}: ${m[0]}`)
      for (const re of [
        /users\/me\/messages/,
        /users\/[^/'"`\s]+\/(messages|threads|labels|history|settings)/,
        /drafts\/[^'"`\s?]*\/send|drafts\/send/,
        /\/send['"`?]/,
        /batchDelete|batchModify|\/modify\b|\/trash\b|\/untrash\b/,
        /messages\.send|drafts\.send|drafts\.delete|drafts\.update|drafts\.get|drafts\.list/,
        /googleapis\.com\/auth\/gmail\.(send|modify|readonly|insert|labels|metadata|settings)/,
        /['"`]https:\/\/mail\.google\.com\/['"`]/, // the full-mail OAuth scope
      ]) {
        for (const line of code.split('\n')) {
          if (re.test(line) && /gmail|mail\.google/i.test(line)) forbidden.push(`${f}: ${line.trim()}`)
        }
      }
    }
    expect(forbidden).toEqual([])
    expect(found.length, 'the drafts.create endpoint is in the code').toBeGreaterThan(0)
    for (const x of found) {
      const url = x.slice(x.indexOf(': ') + 2)
      if (url === 'gmail.googleapis.com' || /^https?:\/\/gmail\.googleapis\.com\/?$/.test(url)) continue // CSP/host only
      expect(url, x).toMatch(/gmail\/v1\/users\/me\/drafts(\?[^/]*)?$/)
    }
    // OAuth scopes anywhere in src/api: only drive, gmail.compose (+ userinfo/openid).
    const scopes = new Set<string>()
    for (const f of srcAndApiFiles()) for (const m of readFileSync(f, 'utf8').matchAll(/googleapis\.com\/auth\/[a-z.]+/g)) scopes.add(m[0])
    for (const s of scopes) expect(['googleapis.com/auth/drive', 'googleapis.com/auth/gmail.compose', 'googleapis.com/auth/userinfo.email']).toContain(s)
  })

  it('AC29.no-internal-costs: text and HTML contain greeting, description, "מה כלול" (included names only), מחיר: ₪{price}, delivery, note, signature + Founder e-mail — and no cost, margin or 50/60/70% value', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const m = await memoryQuoteModel(services, root)
    renderApp(services, `/model/${m.folderId}/quote`)
    await quoteReady()
    fillCustomer({ delivery: 'שבוע', note: 'צבע לבחירתכם' })
    await createDraft(user)
    await draftSucceeded()
    const d = readDraft(services.mail.drafts[0].raw)
    for (const body of [d.text, htmlToText(d.html)]) {
      expect(body).toContain('דנה כהן')
      expect(body).toContain(MODEL_DESCRIPTION)
      expect(body).toContain('מה כלול')
      expect(body).toContain(PLANT.name)
      expect(body).not.toContain(POT.name) // not included in this quote
      expect(body).toContain('מחיר: ₪101')
      expect(body).toContain('שבוע')
      expect(body).toContain('צבע לבחירתכם')
      expect(body).toContain(SIGNATURE)
      expect(body).toContain(FOUNDER)
      for (const v of INTERNAL_VALUES) expect(body, `internal value ${v} in the e-mail`).not.toContain(v)
      expect(body).not.toMatch(/%|עלות|רווח|מרווח|landed|margin|filament|machine/i)
    }
    expect(d.subject).not.toMatch(/\d+\.\d{2}/)
  })

  it('AC29.no-hardware: with no hardware included, the "מה כלול" section is omitted', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const m = await memoryQuoteModel(services, root)
    renderApp(services, `/model/${m.folderId}/quote`)
    await quoteReady()
    await user.click(hardwareBox(PLANT.name)) // now nothing included
    fillCustomer()
    await createDraft(user)
    await draftSucceeded()
    const d = readDraft(services.mail.drafts[0].raw)
    expect(d.text).not.toContain('מה כלול')
    expect(htmlToText(d.html)).not.toContain('מה כלול')
    expect(d.text).toContain('מחיר: ₪51')
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC30 — quote log written (marked) in <model>/quotes/ after a successful draft; nothing written if the draft fails', () => {
  function quoteLogName(now: Date): string {
    const p = (n: number) => String(n).padStart(2, '0')
    return `quote-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`
  }

  it('AC30.memory: quotes/quote-YYYYMMDD-HHmm.json (app-created folder + file) with date, customer, included hardware, price shown, bid landed & 70%, draft id; bid.json untouched', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const m = await memoryQuoteModel(services, root)
    const bidBefore = await services.drive.readText(m.bidFileId)
    renderApp(services, `/model/${m.folderId}/quote`)
    await quoteReady()
    fillCustomer()
    setValue(priceField(), '120')
    const logStart = services.drive.writeLog.length
    const t0 = new Date()
    await createDraft(user)
    await draftSucceeded()
    const t1 = new Date()

    const quotes = (await services.drive.listChildren(m.folderId, { name: 'quotes', foldersOnly: true }))
    expect(quotes).toHaveLength(1)
    expect(quotes[0].appCreated).toBe(true)
    const files = await services.drive.listChildren(quotes[0].id)
    expect(files).toHaveLength(1)
    expect(files[0].appCreated).toBe(true)
    expect(files[0].name).toMatch(/^quote-\d{8}-\d{4}\.json$/)
    expect([quoteLogName(t0), quoteLogName(t1)]).toContain(files[0].name)

    const rec = JSON.parse(await services.drive.readText(files[0].id))
    const strings = stringsIn(rec)
    const numbers = numbersIn(rec)
    expect(strings).toContain('דנה כהן')
    expect(strings).toContain('dana@example.com')
    expect(strings).toContain(services.mail.drafts[0].id) // draft id
    expect(strings.some((s) => !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}/.test(s)), 'a date').toBe(true)
    expect(JSON.stringify(rec)).toContain(PLANT.name) // included hardware
    expect(JSON.stringify(rec)).not.toContain(POT.name)
    expect(numbers).toContain(120) // price shown
    expect(numbers.some((n) => n.toFixed(2) === '30.01'), "bid's landed cost").toBe(true)
    expect(numbers.some((n) => n.toFixed(2) === '100.04'), "bid's 70% price").toBe(true)

    // Only the log was written: the quotes folder and one new file — bid.json not rewritten.
    const writes = services.drive.writeLog.slice(logStart)
    expect(writes.some((w) => /bid\.json/.test(w))).toBe(false)
    expect(writes).toHaveLength(2)
    expect(await services.drive.readText(m.bidFileId)).toBe(bidBefore)
  })

  it('AC30.fail: when drafts.create fails → Hebrew error, no quotes folder, no Drive write at all; invalid e-mail → no draft and nothing written', async () => {
    const user = userEvent.setup()
    const { services, root } = newServices()
    const m = await memoryQuoteModel(services, root)
    renderApp(services, `/model/${m.folderId}/quote`)
    await quoteReady()
    const logStart = services.drive.writeLog.length

    fillCustomer({ email: 'not-an-email' })
    await createDraft(user)
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
    expect(services.mail.drafts).toHaveLength(0)

    fillCustomer()
    services.mail.failNext('network')
    await createDraft(user)
    await waitFor(() => expect(screen.getAllByRole('alert').some((a) => HEBREW.test(a.textContent ?? ''))).toBe(true))
    expect(screen.queryByRole('link', { name: /טיוטות/ })).toBeNull()
    expect(services.mail.drafts).toHaveLength(0)
    expect(services.drive.writeLog.slice(logStart)).toEqual([])
    expect(await services.drive.listChildren(m.folderId, { name: 'quotes' })).toEqual([])
  })

  it('AC30.google: through the real Drive/Gmail stores the quotes folder and file carry appProperties.rubedo="1" and are created (POST) — no PATCH; Gmail 503 → no Drive write', async () => {
    const user = userEvent.setup()
    const { world, model, services } = await googleSetup()
    renderApp(services, `/model/${model.folderId}/quote`)
    await quoteReady()
    fillCustomer()

    world.gmailDown = true
    const w0 = world.driveWrites().length
    await createDraft(user)
    await waitFor(() => expect(screen.getAllByRole('alert').some((a) => HEBREW.test(a.textContent ?? ''))).toBe(true))
    expect(world.drafts).toEqual([])
    expect(world.driveWrites().length).toBe(w0)
    expect(world.children(model.folderId).some((n) => n.name === 'quotes')).toBe(false)

    world.gmailDown = false
    await createDraft(user)
    await draftSucceeded()
    expect(world.drafts).toHaveLength(1)
    const quotes = world.children(model.folderId).filter((n) => n.name === 'quotes')
    expect(quotes).toHaveLength(1)
    expect(quotes[0].appProperties?.rubedo).toBe('1')
    const logs = world.children(quotes[0].id)
    expect(logs).toHaveLength(1)
    expect(logs[0].name).toMatch(/^quote-\d{8}-\d{4}\.json$/)
    expect(logs[0].appProperties?.rubedo).toBe('1')
    const rec = JSON.parse(Buffer.from(logs[0].content).toString('utf8'))
    expect(stringsIn(rec)).toContain(world.drafts[0].id)
    const newWrites = world.driveWrites().slice(w0)
    for (const w of newWrites) expect(w.method, w.url).toBe('POST')
  })
})

// ---------------------------------------------------------------------------------------------
describe('AC31 — session without gmail.compose → the quote screen shows the extra-permission prompt; the rest of the app works', () => {
  const OLD_SESSION_SCOPE = `openid ${USERINFO_EMAIL_SCOPE} ${DRIVE_SCOPE}` // a session created before v0.5

  it('AC31.prompt: pre-v0.5 session → /api/auth/token reports no gmail.compose; quote screen shows "נדרש אישור נוסף ל-Gmail" + a button that opens the popup sign-in (which asks for gmail.compose); no Gmail call', async () => {
    const user = userEvent.setup()
    const { world, model, browser, services } = await googleSetup({ grantedScope: OLD_SESSION_SCOPE })
    renderApp(services, `/model/${model.folderId}/quote`)
    await quoteReady()
    const tok = browser.seenByJs.find((s) => s.path === '/api/auth/token' && s.status === 200)
    expect(tok).toBeTruthy()
    const scopes = (JSON.parse(tok!.body) as { scopes: string[] }).scopes
    expect(scopes).toContain(DRIVE_SCOPE)
    expect(scopes).not.toContain(GMAIL_COMPOSE_SCOPE)

    expect(await screen.findByText(PERMISSION_TEXT)).toBeTruthy()
    fillCustomer()
    const create = screen.queryByRole('button', { name: CREATE_DRAFT }) as HTMLButtonElement | null
    if (create && !create.disabled) await user.click(create)
    expect(world.gmailCalls()).toEqual([])

    const grant = within(screen.getByText(PERMISSION_TEXT).closest('div') as HTMLElement).getByRole('button', { name: /Gmail|אישור/ })
    await user.click(grant)
    expect(services.popups).toHaveLength(1)
    expect(services.popups[0]).toMatch(/^\/api\/auth\/login/)
    const login = await browser.request(services.popups[0])
    const scope = new URL(login.headers.get('Location') ?? '').searchParams.get('scope') ?? ''
    expect(scope.split(/\s+/)).toContain(GMAIL_COMPOSE_SCOPE)
    // Nothing else of the app was blocked: the page is still the quote form.
    expect(priceField().value).toBe('101')
  })

  it('AC31.rest-works: with the same pre-v0.5 session, library, model page and saving a new bid work and show no Gmail prompt', async () => {
    const user = userEvent.setup()
    const { world, root, model, services } = await googleSetup({ grantedScope: OLD_SESSION_SCOPE })
    renderApp(services, '/library')
    await waitFor(() => expect(screen.getAllByText(MODEL_NAME).length).toBeGreaterThan(0), { timeout: 4000 })
    expect(screen.queryByText(PERMISSION_TEXT)).toBeNull()

    await user.click(navLink('דגם חדש'))
    setValue(await screen.findByLabelText(/^שם \*$/), 'After v0.5')
    await addManualPart(user, '100', '3.5')
    setValue(screen.getByLabelText('זמן עבודה'), '10')
    await user.click(saveButton())
    await screen.findByRole('heading', { level: 1, name: 'After v0.5' }, { timeout: 4000 })
    const folder = world.children(root).find((n) => n.name === 'After v0.5')
    expect(folder).toBeTruthy()
    expect(world.children(folder!.id).some((n) => n.name === 'bid.json')).toBe(true)
    expect(screen.queryByText(PERMISSION_TEXT)).toBeNull()
    expect(world.gmailCalls()).toEqual([])
    expect(model.folderId).toBeTruthy()
  })

  it('AC31.granted: after the Founder grants gmail.compose in the popup and returns, the prompt disappears and a draft can be created', async () => {
    const user = userEvent.setup()
    const { world, model, browser, services } = await googleSetup({ grantedScope: OLD_SESSION_SCOPE })
    renderApp(services, `/model/${model.folderId}/quote`)
    await quoteReady()
    await screen.findByText(PERMISSION_TEXT)
    // The popup sign-in completes with the v0.5 scopes (new session cookie).
    expect((await browser.signInAtGoogle(FOUNDER)).status).toBe(302)
    // The Founder comes back to the app tab.
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(screen.queryByText(PERMISSION_TEXT)).toBeNull(), { timeout: 4000 })
    fillCustomer()
    await createDraft(user)
    await draftSucceeded()
    expect(world.drafts).toHaveLength(1)
  })
})
