import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/App'
import { BID_FILE_NAME, FOLDER_MIME, type HardwareLine } from '../../src/lib/bid'
import { newSaveSession, saveNewBid } from '../../src/lib/drive/bidRepository'
import { MemoryDrive } from '../../src/lib/drive/memoryDrive'
import { MemoryAuth } from '../../src/state/services'
import { MemoryMail } from '../../src/lib/mail/memoryMail'
import { computePrice, DEFAULT_PRICING_SETTINGS } from '../../src/lib/pricing'
import { createMemoryServices, type AppServices } from '../../src/state/services'
import { readQuoteMessage } from './mimeReader'

const DRIVE = 'https://www.googleapis.com/auth/drive'
const S = DEFAULT_PRICING_SETTINGS

function renderApp(services: AppServices, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App services={services} />
    </MemoryRouter>,
  )
}

const HARDWARE: HardwareLine[] = [
  { name: 'מבחנות זכוכית', qty: 5, unitCost: 3, included: true },
  { name: 'צמח פוטוס', qty: 1, unitCost: 20, included: false },
]

/** A priced bid (T1 + optional hardware) in a model folder with two photos (one HEIC) and a plate picture. */
async function setup(options: { scopes?: string[]; mail?: MemoryMail } = {}) {
  const drive = new MemoryDrive()
  const services = createMemoryServices(drive, undefined, options)
  const root = services.folderPointer.get() as string
  const input = { pricePerKg: 85, parts: [{ qty: 1, grams: 100, hours: 3.5 }], laborMinutes: 10, hardware: HARDWARE, hasShipping: false, packaging: [], shippingCost: 0 }
  const result = computePrice(input, S)
  const { folderId } = await saveNewBid(
    drive,
    root,
    {
      folderName: 'RootLab',
      content: {
        name: 'RootLab',
        revision: 'V1',
        description: 'תחנת ריבוי צמחים.',
        material: { name: 'PLA', pricePerKg: 85 },
        parts: [{ name: 'Base', qty: 1, grams: 100, hours: 3.5, source: 'manual' }],
        laborMinutes: 10,
        hardware: HARDWARE,
        hasShipping: false,
        packaging: [],
        shippingCost: 0,
        settingsSnapshot: { ...S },
        result,
      },
      files: [],
    },
    newSaveSession(),
  )
  const cover = drive.addForeignFile(folderId, 'a-cover.jpg', new Blob([new Uint8Array([0xff, 0xd8, 1, 2])], { type: 'image/jpeg' }), 'image/jpeg')
  const heic = drive.addForeignFile(folderId, 'b-iphone.HEIC', new Blob(['heic-bytes']), 'image/heic', {
    thumbnail: new Blob([new Uint8Array([0xff, 0xd8, 9, 9])], { type: 'image/jpeg' }),
  })
  return { drive, services, root, folderId, result, cover, heic }
}

const customerName = () => screen.getByLabelText(/שם הלקוח/)
const customerEmail = () => screen.getByLabelText(/מייל הלקוח/)
const priceInput = () => screen.getByLabelText('מחיר ללקוח') as HTMLInputElement

async function quotesFolder(drive: MemoryDrive, folderId: string) {
  return (await drive.listChildren(folderId)).find((f) => f.mimeType === FOLDER_MIME && f.name === 'quotes')
}

describe('Quote screen (Q3)', () => {
  it('model page links to /model/:id/quote and marks excluded hardware', async () => {
    const { services, folderId } = await setup()
    renderApp(services, `/model/${folderId}`)
    const link = await screen.findByRole('link', { name: 'שליחת הצעת מחיר' })
    expect(link.getAttribute('href')).toBe(`/model/${folderId}/quote`)
    expect(screen.getAllByTestId('hardware-excluded')).toHaveLength(1)
  })

  it('AC27: hardware pre-ticked from the bid; toggling reprices live; default customer price = ceil(price70)', async () => {
    const user = userEvent.setup()
    const { services, folderId, result } = await setup()
    renderApp(services, `/model/${folderId}/quote`)
    const tubes = await screen.findByRole('checkbox', { name: /מבחנות זכוכית/ })
    const plant = screen.getByRole('checkbox', { name: /צמח פוטוס/ })
    expect((tubes as HTMLInputElement).checked).toBe(true)
    expect((plant as HTMLInputElement).checked).toBe(false)
    expect(screen.getByTestId('quote-price-70').textContent).toBe(`₪${result.price70.toFixed(2)}`)
    expect(priceInput().value).toBe(String(Math.ceil(result.price70)))

    await user.click(plant)
    const withPlant = computePrice(
      { pricePerKg: 85, parts: [{ qty: 1, grams: 100, hours: 3.5 }], laborMinutes: 10, hardware: HARDWARE.map((h) => ({ ...h, included: true })), hasShipping: false, packaging: [], shippingCost: 0 },
      S,
    )
    expect(withPlant.landed - result.landed).toBeCloseTo(20, 10)
    expect(screen.getByTestId('quote-price-70').textContent).toBe(`₪${withPlant.price70.toFixed(2)}`)
    expect(priceInput().value).toBe(String(Math.ceil(withPlant.price70)))
    expect(screen.getByTestId('email-preview').textContent).toContain('צמח פוטוס')

    // A typed price is kept while toggling.
    await user.clear(priceInput())
    await user.type(priceInput(), '150')
    await user.click(tubes)
    expect(priceInput().value).toBe('150')
    expect(screen.getByTestId('email-preview').textContent).toContain('מחיר: ₪150')
  })

  it('AC28/AC30: creates ONE Gmail draft (valid MIME, cover photo only by default), then writes the marked quote log', async () => {
    const user = userEvent.setup()
    const { drive, services, folderId, result } = await setup()
    renderApp(services, `/model/${folderId}/quote`)
    await user.type(await screen.findByLabelText(/שם הלקוח/), 'דנה')
    await user.type(customerEmail(), 'dana@example.com')
    await user.type(screen.getByLabelText(/זמן אספקה/), 'שבוע')
    expect((screen.getByRole('checkbox', { name: 'צירוף a-cover.jpg' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'צירוף b-iphone.HEIC' }) as HTMLInputElement).checked).toBe(false)
    await user.click(screen.getByRole('checkbox', { name: 'צירוף b-iphone.HEIC' }))
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))

    const success = await screen.findByTestId('draft-success')
    expect(within(success).getByRole('link', { name: 'פתיחת הטיוטות ב-Gmail' }).getAttribute('href')).toBe('https://mail.google.com/mail/#drafts')

    const mail = services.mail
    expect(mail.drafts).toHaveLength(1)
    const msg = readQuoteMessage(mail.drafts[0].raw)
    expect(msg.subject).toBe('הצעת מחיר — RootLab | RUBEDO.3D')
    expect(msg.to).toBe('דנה <dana@example.com>')
    const price = Math.ceil(result.price70)
    expect(msg.text).toContain(`מחיר: ₪${price}`)
    expect(msg.text).toContain('מה כלול:\r\n• מבחנות זכוכית')
    expect(msg.text).not.toContain('צמח פוטוס')
    expect(msg.text).toContain('RUBEDO.3D — הדפסות תלת-ממד בהתאמה אישית')
    expect(msg.html).toContain('dir="rtl"')
    for (const secret of [result.landed.toFixed(2), result.price70.toFixed(2), result.price50.toFixed(2), result.price60.toFixed(2)]) {
      expect(msg.text).not.toContain(secret)
      expect(msg.html).not.toContain(secret)
    }
    expect(msg.attachments.map((a) => [a.type, a.filename])).toEqual([
      ['image/jpeg', 'a-cover.jpg'],
      ['image/jpeg', 'b-iphone.jpg'],
    ])
    expect(Array.from(msg.attachments[1].data)).toEqual([0xff, 0xd8, 9, 9])

    // Quote log: app-marked `quotes` folder + one marked JSON file with the draft id.
    const q = await quotesFolder(drive, folderId)
    expect(q?.appCreated).toBe(true)
    const logs = await drive.listChildren(q?.id as string)
    expect(logs).toHaveLength(1)
    expect(logs[0].name).toMatch(/^quote-\d{8}-\d{4}\.json$/)
    expect(logs[0].appCreated).toBe(true)
    const log = JSON.parse(await drive.readText(logs[0].id))
    expect(log).toMatchObject({
      draftId: 'draft-1',
      customer: { name: 'דנה', email: 'dana@example.com' },
      priceShown: price,
      price70: result.price70,
      landed: result.landed,
      savedBid: { landed: result.landed, price70: result.price70 },
      deliveryTime: 'שבוע',
      includedHardware: [{ name: 'מבחנות זכוכית', qty: 5, unitCost: 3 }],
    })
    // bid.json untouched.
    expect(drive.writeLog.filter((w) => w.startsWith('update:'))).toEqual([])
    expect(drive.writeLog.filter((w) => w.includes(BID_FILE_NAME))).toEqual(['upload:bid.json'])
  })

  it('AC30 + M1: Gmail refused (4xx) → "לא נוצרה טיוטה"; unclear failure (5xx/network) → "ייתכן שהטיוטה נוצרה"; NOTHING written to Drive either way', async () => {
    const user = userEvent.setup()
    const mail = new MemoryMail()
    const { drive, services, folderId } = await setup({ mail })
    renderApp(services, `/model/${folderId}/quote`)
    await user.type(await screen.findByLabelText(/שם הלקוח/), 'דנה')
    await user.type(customerEmail(), 'dana@example.com')
    const writesBefore = drive.writeLog.length

    mail.failNext('rejected')
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
    expect(await screen.findByText(/לא נוצרה טיוטה ולא נרשם דבר/)).toBeTruthy()
    expect(screen.queryByText(/ייתכן שהטיוטה נוצרה/)).toBeNull()

    mail.failNext('network')
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
    expect(await screen.findByText(/ייתכן שהטיוטה נוצרה — בדקו בטיוטות לפני שמנסים שוב/)).toBeTruthy()
    expect(screen.queryByText(/לא נוצרה טיוטה/)).toBeNull()

    expect(mail.drafts).toHaveLength(0)
    expect(drive.writeLog.length).toBe(writesBefore)
    expect(await quotesFolder(drive, folderId)).toBeUndefined()
  })

  it('draft ok but the log fails → says so; retry writes ONLY the log (no second draft)', async () => {
    const user = userEvent.setup()
    const { drive, services, folderId } = await setup()
    renderApp(services, `/model/${folderId}/quote`)
    await user.type(await screen.findByLabelText(/שם הלקוח/), 'דנה')
    await user.type(customerEmail(), 'dana@example.com')
    drive.failNext('uploadFile', (name) => name.startsWith('quote-'))
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
    expect(await screen.findByText(/הטיוטה נוצרה ב-Gmail, אבל רישום ההצעה/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'נסו שוב' }))
    await screen.findByTestId('draft-success')
    expect(services.mail.drafts).toHaveLength(1)
    const q = await quotesFolder(drive, folderId)
    expect(await drive.listChildren(q?.id as string)).toHaveLength(1)
  })

  it('invalid customer e-mail / missing name → Hebrew errors, no draft', async () => {
    const user = userEvent.setup()
    const { services, folderId } = await setup()
    renderApp(services, `/model/${folderId}/quote`)
    await user.type(await screen.findByLabelText(/מייל הלקוח/), 'not-an-email')
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
    expect(await screen.findByText('כתובת המייל של הלקוח אינה תקינה.')).toBeTruthy()
    expect(screen.getByText('יש להזין שם לקוח.')).toBeTruthy()
    expect(services.mail.drafts).toHaveLength(0)
    expect(customerName()).toBeTruthy()
  })

  it('subject and body are editable before the draft is created', async () => {
    const user = userEvent.setup()
    const { services, folderId } = await setup()
    renderApp(services, `/model/${folderId}/quote`)
    await user.type(await screen.findByLabelText(/שם הלקוח/), 'דנה')
    await user.type(customerEmail(), 'dana@example.com')
    const subject = screen.getByLabelText('נושא')
    await user.clear(subject)
    await user.type(subject, 'הצעה מיוחדת')
    const price = priceInput().value
    const body = screen.getByLabelText('עריכת תוכן המייל')
    await user.clear(body)
    await user.type(body, `טקסט חופשי — מחיר: ₪${price}`)
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
    await screen.findByTestId('draft-success')
    const msg = readQuoteMessage(services.mail.drafts[0].raw)
    expect(msg.subject).toBe('הצעה מיוחדת')
    expect(msg.text).toBe(`טקסט חופשי — מחיר: ₪${price}`)
  })

  it('attachments over 20 MB → Hebrew error, no draft, nothing written', async () => {
    const user = userEvent.setup()
    const { drive, services, folderId } = await setup()
    const big = new Uint8Array(21 * 1024 * 1024)
    drive.addForeignFile(folderId, '0-huge.jpg', new Blob([big], { type: 'image/jpeg' }), 'image/jpeg')
    renderApp(services, `/model/${folderId}/quote`)
    await user.type(await screen.findByLabelText(/שם הלקוח/), 'דנה')
    await user.type(customerEmail(), 'dana@example.com')
    // The first photo by name is the default (the bid has no explicit cover).
    expect((screen.getByRole('checkbox', { name: 'צירוף 0-huge.jpg' }) as HTMLInputElement).checked).toBe(true)
    const writes = drive.writeLog.length
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
    expect(await screen.findByText(/חורג מהמגבלה של 20 MB/)).toBeTruthy()
    expect(services.mail.drafts).toHaveLength(0)
    expect(drive.writeLog.length).toBe(writes)
  })
})

describe('AC31: session without gmail.compose', () => {
  it('quote screen shows "נדרש אישור נוסף ל-Gmail"; the button opens the popup; afterwards drafts work', async () => {
    const user = userEvent.setup()
    const { services, folderId } = await setup({ scopes: [DRIVE] })
    renderApp(services, `/model/${folderId}/quote`)
    const prompt = await screen.findByTestId('gmail-permission')
    expect(within(prompt).getByText('נדרש אישור נוסף ל-Gmail')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }) as HTMLButtonElement).disabled).toBe(true)

    await user.click(within(prompt).getByRole('button', { name: 'אישור הרשאה ל-Gmail' }))
    expect(services.auth.reconnectCalls).toBe(1)
    await user.click(within(prompt).getByRole('button', { name: 'המשך' }))
    await waitFor(() => expect(screen.queryByTestId('gmail-permission')).toBeNull())

    await user.type(customerName(), 'דנה')
    await user.type(customerEmail(), 'dana@example.com')
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
    await screen.findByTestId('draft-success')
    expect(services.mail.drafts).toHaveLength(1)
  })

  it('the rest of the app is not blocked (library, model page, new model form)', async () => {
    const { services, folderId } = await setup({ scopes: [DRIVE] })
    const lib = renderApp(services, '/library')
    expect(await screen.findByText('RootLab')).toBeTruthy()
    lib.unmount()
    const page = renderApp(services, `/model/${folderId}`)
    expect(await screen.findByRole('link', { name: 'עריכת הצעה' })).toBeTruthy()
    expect(screen.queryByText('נדרש אישור נוסף ל-Gmail')).toBeNull()
    page.unmount()
    renderApp(services, '/new')
    expect(await screen.findByRole('button', { name: 'שמירה' })).toBeTruthy()
  })

  it('Gmail answers "insufficient scope" although the session looked fine → the prompt appears', async () => {
    const user = userEvent.setup()
    const mail = new MemoryMail()
    const { services, folderId } = await setup({ mail })
    renderApp(services, `/model/${folderId}/quote`)
    await user.type(await screen.findByLabelText(/שם הלקוח/), 'דנה')
    await user.type(customerEmail(), 'dana@example.com')
    mail.failNext('permission')
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
    expect(await screen.findByTestId('gmail-permission')).toBeTruthy()
  })
})

describe('Bid form: "כלול במחיר" per hardware row (Q1, AC25)', () => {
  it('unticking a row lowers the live price by exactly its cost; the saved bid keeps it with included=false', async () => {
    const user = userEvent.setup()
    const services = createMemoryServices()
    renderApp(services, '/new')
    await user.type(await screen.findByLabelText(/^שם/), 'Station')
    await user.click(screen.getByRole('button', { name: '+ הוספת חלק ידנית' }))
    await user.type(screen.getByLabelText('משקל'), '100')
    await user.click(screen.getByRole('button', { name: '+ הוספת רכיב' }))
    await user.type(screen.getByLabelText('רכיב 1'), 'Plant')
    await user.type(screen.getByLabelText('מחיר ליחידה'), '20')
    const landedWith = screen.getByTestId('cost-landed').textContent
    const box = screen.getByRole('checkbox', { name: 'כלול במחיר — רכיב 1' }) as HTMLInputElement
    expect(box.checked).toBe(true)
    await user.click(box)
    const landedWithout = screen.getByTestId('cost-landed').textContent
    const num = (t: string | null) => Number((t ?? '').replace(/[^\d.]/g, ''))
    expect(num(landedWith) - num(landedWithout)).toBeCloseTo(20, 2)
    expect(within(screen.getByTestId('cost-hardware')).getByText('₪0.00')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    await screen.findByRole('link', { name: 'שליחת הצעת מחיר' })
    const root = services.folderPointer.get() as string
    const folder = (await services.drive.listChildren(root, { foldersOnly: true }))[0]
    const bidFile = (await services.drive.listChildren(folder.id, { name: BID_FILE_NAME }))[0]
    const bid = JSON.parse(await services.drive.readText(bidFile.id))
    expect(bid.schemaVersion).toBe(2)
    expect(bid.hardware).toEqual([{ name: 'Plant', qty: 1, unitCost: 20, included: false }])
    expect(bid.result.hardware).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// v0.5 fix round

describe('I1 — never a frozen or zero price', () => {
  it('invalid price → placeholder in the price line (never ₪0), draft button disabled with a Hebrew reason', async () => {
    const user = userEvent.setup()
    const { services, folderId } = await setup()
    renderApp(services, `/model/${folderId}/quote`)
    await user.type(await screen.findByLabelText(/שם הלקוח/), 'דנה')
    await user.type(customerEmail(), 'dana@example.com')
    for (const bad of ['abc', '0', '1,5']) {
      await user.clear(priceInput())
      await user.type(priceInput(), bad)
      const preview = screen.getByTestId('email-preview').textContent ?? ''
      expect(preview).toContain('מחיר: [יש להזין מחיר תקין]')
      expect(preview).not.toMatch(/₪0(?![\d.])/)
      expect((screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }) as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByTestId('price-block').textContent).toMatch(/המחיר ללקוח אינו תקין/)
    }
    expect(services.mail.drafts).toHaveLength(0)
  })

  it('manual body edit, then an input changes → warning next to "שחזור הנוסח האוטומטי"; reset clears it', async () => {
    const user = userEvent.setup()
    const { services, folderId } = await setup()
    renderApp(services, `/model/${folderId}/quote`)
    const body = (await screen.findByLabelText('עריכת תוכן המייל')) as HTMLTextAreaElement
    await user.type(body, ' תודה!')
    expect(screen.queryByTestId('stale-body-warning')).toBeNull()
    // Each kind of input change triggers the warning.
    for (const change of [
      () => user.click(screen.getByRole('checkbox', { name: /צמח פוטוס/ })),
      async () => {
        await user.clear(priceInput())
        await user.type(priceInput(), '99')
      },
      () => user.type(customerName(), 'X'),
      () => user.type(screen.getByLabelText(/זמן אספקה/), 'X'),
      () => user.type(screen.getByLabelText(/הערה/), 'X'),
    ]) {
      await user.click(screen.getByRole('button', { name: 'שחזור הנוסח האוטומטי' }))
      await user.type(screen.getByLabelText('עריכת תוכן המייל'), ' ערוך')
      expect(screen.queryByTestId('stale-body-warning')).toBeNull()
      await change()
      const warning = screen.getByTestId('stale-body-warning')
      expect(warning.textContent).toBe('התוכן נערך ידנית — המחיר/פריטים לא עודכנו')
      expect(warning.parentElement?.textContent).toContain('שחזור הנוסח האוטומטי')
    }
    await user.click(screen.getByRole('button', { name: 'שחזור הנוסח האוטומטי' }))
    expect(screen.queryByTestId('stale-body-warning')).toBeNull()
  })

  it('edited body without the exact price → blocked with a Hebrew reason; the logged priceShown = the price in the sent body', async () => {
    const user = userEvent.setup()
    const { drive, services, folderId } = await setup()
    renderApp(services, `/model/${folderId}/quote`)
    await user.type(await screen.findByLabelText(/שם הלקוח/), 'דנה')
    await user.type(customerEmail(), 'dana@example.com')
    await user.clear(priceInput())
    await user.type(priceInput(), '150')
    const body = screen.getByLabelText('עריכת תוכן המייל')
    // Freeze the body, then change the price: the body still says ₪150.
    await user.type(body, ' ')
    await user.clear(priceInput())
    await user.type(priceInput(), '1500')
    expect(screen.getByTestId('stale-body-warning')).toBeTruthy()
    // "₪150" is in the text, but ₪1,500 is not → blocked ("₪150" never matches "₪1500" / "₪150.5" either).
    expect((screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('price-block').textContent).toContain('תוכן המייל אינו כולל את המחיר ללקוח (₪1,500)')

    await user.click(screen.getByRole('button', { name: 'שחזור הנוסח האוטומטי' }))
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
    await screen.findByTestId('draft-success')
    const msg = readQuoteMessage(services.mail.drafts[0].raw)
    expect(msg.text).toContain('מחיר: ₪1,500')
    const q = await quotesFolder(drive, folderId)
    const [log] = await drive.listChildren(q?.id as string)
    expect(JSON.parse(await drive.readText(log.id)).priceShown).toBe(1500)
  })
})

describe('I2 — Gmail API not enabled in the Cloud project', () => {
  it('shows the Hebrew setup message; no draft, nothing written; not the permission prompt', async () => {
    const user = userEvent.setup()
    const mail = new MemoryMail()
    const { drive, services, folderId } = await setup({ mail })
    renderApp(services, `/model/${folderId}/quote`)
    await user.type(await screen.findByLabelText(/שם הלקוח/), 'דנה')
    await user.type(customerEmail(), 'dana@example.com')
    const writes = drive.writeLog.length
    mail.failNext('api-disabled')
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
    expect(await screen.findByText('Gmail API לא מופעל בפרויקט Google Cloud — יש להפעיל אותו ולנסות שוב')).toBeTruthy()
    expect(screen.queryByTestId('gmail-permission')).toBeNull()
    expect(drive.writeLog.length).toBe(writes)
  })
})

describe('M5 — /api/thumb 401 while attaching → needs reconnect', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports the lost session (onUnauthorized), shows a Hebrew error, keeps the form, creates no draft', async () => {
    const user = userEvent.setup()
    const { services, folderId } = await setup()
    // A drive that serves images by URL, like the real store (/api/thumb).
    const drive = services.drive
    const urlDrive = Object.assign(Object.create(Object.getPrototypeOf(drive)) as MemoryDrive, drive, {
      thumbnailUrl: (id: string, size: number) => `/api/thumb?id=${id}&s=${size}`,
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'no_session' }), { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = services.auth as MemoryAuth
    renderApp({ ...services, drive: urlDrive }, `/model/${folderId}/quote`)
    await user.type(await screen.findByLabelText(/שם הלקוח/), 'דנה')
    await user.type(customerEmail(), 'dana@example.com')
    await user.click(screen.getByRole('button', { name: 'צור טיוטה ב-Gmail' }))
    expect(await screen.findByText(/פג תוקף ההתחברות ל-Google/)).toBeTruthy()
    expect(auth.unauthorizedCalls).toBe(1)
    expect(fetchMock.mock.calls.some((c) => String((c as unknown[])[0]).startsWith('/api/thumb?') && String((c as unknown[])[0]).includes('s=1600'))).toBe(true)
    expect(services.mail.drafts).toHaveLength(0)
    expect((customerName() as HTMLInputElement).value).toBe('דנה')
  })
})

describe('M7 — customer e-mail field is LTR', () => {
  it('dir="ltr" (and an e-mail keyboard)', async () => {
    const { services, folderId } = await setup()
    renderApp(services, `/model/${folderId}/quote`)
    const email = (await screen.findByLabelText(/מייל הלקוח/)) as HTMLInputElement
    expect(email.getAttribute('dir')).toBe('ltr')
    expect(email.getAttribute('inputmode')).toBe('email')
  })
})
