import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { CustomerPicker } from '../components/CustomerPicker'
import { DriveImage } from '../components/DriveImage'
import { RequireDrive, type DriveContext } from '../components/RequireDrive'
import { ErrorBox, Field, Money, Notice, Spinner } from '../components/ui'
import { newId } from '../lib/bid'
import { findByEmail, type Customer } from '../lib/customers'
import { loadModelFolder, markQuotesChanged, type ModelFolder } from '../lib/drive/bidRepository'
import { ensureQuoteCustomer, loadCustomers } from '../lib/drive/customerStore'
import { pickCover } from '../lib/drive/folderContents'
import { writeQuoteLog } from '../lib/drive/quoteLog'
import type { DriveFile } from '../lib/drive/types'
import { errorMessage, logError } from '../lib/errors'
import { isValidAmount, ltrIsolate, parseNumber } from '../lib/format'
import { AttachmentError, loadAttachments } from '../lib/mail/attachments'
import { buildMimeMessage } from '../lib/mail/mime'
import {
  GMAIL_API_DISABLED_MESSAGE,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_DRAFTS_URL,
  GMAIL_PERMISSION_MESSAGE,
  MailError,
  type DraftResult,
} from '../lib/mail/types'
import {
  bodyHasPrice,
  buildQuoteRecord,
  defaultCustomerPrice,
  formatCustomerPrice,
  FOUNDER_EMAIL_FALLBACK,
  isValidEmail,
  quoteBodyText,
  quotePrice,
  quoteSubject,
  savedSelection,
  textToHtml,
  type QuoteRecord,
} from '../lib/quote'
import { useApp } from '../state/AppContext'

/** I1: the body was edited by hand and an input changed afterwards — the typed text was NOT regenerated. */
export const STALE_BODY_WARNING = 'התוכן נערך ידנית — המחיר/פריטים לא עודכנו'
/** M1: after an unclear failure a draft may exist. */
export const MAYBE_CREATED_MESSAGE = 'ייתכן שהטיוטה נוצרה — בדקו בטיוטות לפני שמנסים שוב.'
export const NOT_CREATED_MESSAGE = 'לא נוצרה טיוטה ולא נרשם דבר.'

/** "שליחת הצעת מחיר" (brief v0.5 Q3): builds a Gmail DRAFT — the Founder presses Send in Gmail himself. */
export function QuotePageRoute() {
  const { id = '' } = useParams()
  // v0.6 E4: "/model/:id/quote?customer=<id>" (from a customer page) prefills that customer.
  const [params] = useSearchParams()
  const customerId = params.get('customer') ?? undefined
  return <RequireDrive>{(ctx) => <QuoteLoader key={id} ctx={ctx} folderId={id} initialCustomerId={customerId} />}</RequireDrive>
}

function QuoteLoader({ ctx, folderId, initialCustomerId }: { ctx: DriveContext; folderId: string; initialCustomerId?: string }) {
  const [data, setData] = useState<ModelFolder | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    loadModelFolder(ctx.drive, folderId)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => {
        logError('load model for quote', e)
        if (!cancelled) setError(errorMessage(e, 'טעינת הדגם נכשלה.'))
      })
    return () => {
      cancelled = true
    }
  }, [ctx.drive, folderId, tick])

  if (error) return <ErrorBox onRetry={() => setTick((t) => t + 1)}>{error}</ErrorBox>
  if (!data) return <Spinner label="טוען דגם…" />
  if (!data.bid) {
    return (
      <ErrorBox>
        לדגם הזה אין עדיין הצעת מחיר, ולכן אי אפשר לשלוח אותה ללקוח.{' '}
        <Link className="underline" to={`/model/${encodeURIComponent(folderId)}`}>
          חזרה לדגם
        </Link>
      </ErrorBox>
    )
  }
  return (
    <QuoteForm
      ctx={ctx}
      folderId={folderId}
      data={data as ModelFolder & { bid: NonNullable<ModelFolder['bid']> }}
      initialCustomerId={initialCustomerId}
    />
  )
}

type Phase = 'idle' | 'attachments' | 'draft' | 'log' | 'customer'

/** Result of saving the quote's customer to the customers list (after the draft; never blocks it). */
type CustomerNotice = { tone: 'info' | 'warn'; text: string; retry?: QuoteRecord }

function QuoteForm({
  ctx,
  folderId,
  data,
  initialCustomerId,
}: {
  ctx: DriveContext
  folderId: string
  data: ModelFolder & { bid: NonNullable<ModelFolder['bid']> }
  initialCustomerId?: string
}) {
  const { services, grantedScopes, requestExtraPermission, recheckPermissions, accountEmail, markSessionLost } = useApp()
  const { bid, contents } = data
  const images = contents.images

  const [included, setIncluded] = useState<boolean[]>(() => savedSelection(bid))
  /** null = follow the default (70% price rounded up); a string once the Founder typed a price. */
  const [priceText, setPriceText] = useState<string | null>(null)
  const [customerName, setCustomerName] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [deliveryTime, setDeliveryTime] = useState('')
  const [note, setNote] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => {
    const cover = images.some((i) => i.id === bid.coverFileId) ? bid.coverFileId : pickCover(images)
    return new Set(cover ? [cover] : [])
  })
  const [subjectOverride, setSubjectOverride] = useState<string | null>(null)
  const [bodyOverride, setBodyOverride] = useState<string | null>(null)
  /** The inputs at the moment the body was first edited by hand (I1 stale-content warning). */
  const [overrideInputs, setOverrideInputs] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [draft, setDraft] = useState<DraftResult | null>(null)
  /** The draft exists but the quote log could not be written yet (retry writes only the log). */
  const [pendingLog, setPendingLog] = useState<QuoteRecord | null>(null)
  const [logName, setLogName] = useState<string | null>(null)
  /** v0.6 E4: the customers list (null while loading). A failure leaves the screen fully usable. */
  const [customers, setCustomers] = useState<Customer[] | null>(null)
  const [customersError, setCustomersError] = useState<string | null>(null)
  const [prefillMissing, setPrefillMissing] = useState(false)
  const [customerNotice, setCustomerNotice] = useState<CustomerNotice | null>(null)

  useEffect(() => {
    let cancelled = false
    loadCustomers(ctx.drive, ctx.folderId)
      .then((list) => {
        if (cancelled) return
        setCustomers(list)
        if (!initialCustomerId) return
        const c = list.find((x) => x.id === initialCustomerId)
        if (c) {
          setCustomerName(c.name)
          setCustomerEmail(c.email)
        } else setPrefillMissing(true)
      })
      .catch((e: unknown) => {
        logError('load customers', e)
        if (!cancelled) setCustomersError(errorMessage(e, 'טעינת רשימת הלקוחות נכשלה.'))
      })
    return () => {
      cancelled = true
    }
  }, [ctx.drive, ctx.folderId, initialCustomerId])

  const result = useMemo(() => quotePrice(bid, included), [bid, included])
  const autoPrice = defaultCustomerPrice(result.price70)
  const price = priceText === null ? autoPrice : parseNumber(priceText)
  const priceOk = (priceText === null || isValidAmount(priceText)) && Number.isFinite(price) && price > 0

  const founderEmail = accountEmail ?? services.auth?.email ?? FOUNDER_EMAIL_FALLBACK
  const includedNames = bid.hardware.filter((_, i) => included[i]).map((h) => h.name)
  const generatedBody = quoteBodyText({
    modelName: bid.name,
    description: bid.description,
    customerName,
    includedHardware: includedNames,
    // I1: never a 0 — an invalid price shows a placeholder (and blocks the draft).
    price: priceOk ? price : null,
    deliveryTime,
    note,
    founderEmail,
  })
  const subject = subjectOverride ?? quoteSubject(bid.name)
  const body = bodyOverride ?? generatedBody
  const inputsKey = JSON.stringify([included, priceOk ? price : null, customerName, deliveryTime, note])
  const bodyStale = bodyOverride !== null && overrideInputs !== null && overrideInputs !== inputsKey
  const formattedPrice = priceOk ? formatCustomerPrice(price) : ''
  // I1: what the customer reads must contain exactly the price that is logged as priceShown.
  const priceInBody = priceOk && bodyHasPrice(body, price)
  const priceBlock = !priceOk
    ? 'המחיר ללקוח אינו תקין — יש להזין מחיר גדול מ-0 כדי ליצור טיוטה.'
    : !priceInBody
      ? `תוכן המייל אינו כולל את המחיר ללקוח (${formattedPrice}). עדכנו את התוכן או לחצו „שחזור הנוסח האוטומטי”.`
      : null

  const gmailGranted = !permissionDenied && (grantedScopes === null || grantedScopes.includes(GMAIL_COMPOSE_SCOPE))

  // After the permission popup the Founder comes back to this tab: ask the session again.
  useEffect(() => {
    if (gmailGranted) return
    const onFocus = () => {
      void recheckPermissions().catch((e: unknown) => logError('recheck permissions', e))
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [gmailGranted, recheckPermissions])

  const problems: string[] = []
  if (customerName.trim() === '') problems.push('יש להזין שם לקוח.')
  if (!isValidEmail(customerEmail)) problems.push('כתובת המייל של הלקוח אינה תקינה.')
  if (subject.trim() === '') problems.push('יש להזין נושא.')
  if (body.trim() === '') problems.push('תוכן המייל ריק.')
  if (!services.mail) problems.push('חיבור ל-Gmail אינו זמין במצב הזה.')

  const busy = phase !== 'idle'
  const selectedFiles: DriveFile[] = images.filter((f) => selected.has(f.id))

  /**
   * v0.6 E4: only after the draft exists AND its log is written — a new e-mail joins the customers list; an e-mail
   * already there keeps its stored name. A failure here is a notice only: the draft has succeeded.
   */
  const saveCustomer = async (record: QuoteRecord) => {
    setPhase('customer')
    try {
      const r = await ensureQuoteCustomer(ctx.drive, ctx.folderId, record.customer, record.customerId)
      const email = ltrIsolate(r.customer.email)
      const notes: string[] = []
      if (r.created) {
        setCustomers((list) => (list ? [...list, r.customer] : list))
        notes.push(`${r.customer.name} נוסף/ה לרשימת הלקוחות.`)
      }
      if (r.storedNameDiffers) notes.push(`המייל ${email} כבר שמור ברשימת הלקוחות בשם „${r.customer.name}” — השם השמור לא שונה.`)
      if (r.hidden) {
        notes.push(`הלקוח/ה „${r.customer.name}” (${email}) מוסתר/ת ברשימת הלקוחות — ההצעה נרשמה עבורו/ה. אפשר להציג אותו/ה שוב בעמוד הלקוח.`)
      }
      setCustomerNotice(notes.length > 0 ? { tone: 'info', text: notes.join(' ') } : null)
    } catch (e) {
      logError('save quote customer', e)
      setCustomerNotice({
        tone: 'warn',
        text: `הטיוטה נוצרה וההצעה נרשמה, אבל שמירת הלקוח ברשימת הלקוחות נכשלה: ${errorMessage(e, 'שגיאה ב-Drive.')}`,
        retry: record,
      })
    }
  }

  const writeLog = async (record: QuoteRecord) => {
    setPhase('log')
    try {
      const written = await writeQuoteLog(ctx.drive, folderId, record)
      setLogName(written.name)
      setPendingLog(null)
      markQuotesChanged(ctx.drive)
      await saveCustomer(record)
    } catch (e) {
      logError('write quote log', e)
      setPendingLog(record)
      setError(`הטיוטה נוצרה ב-Gmail, אבל רישום ההצעה בתיקיית הדגם נכשל: ${errorMessage(e, 'שגיאה ב-Drive.')}`)
    } finally {
      setPhase('idle')
    }
  }

  const retryCustomer = async (record: QuoteRecord) => {
    setCustomerNotice(null)
    await saveCustomer(record)
    setPhase('idle')
  }

  const onCreate = async () => {
    setShowErrors(true)
    if (busy || problems.length > 0 || priceBlock || !gmailGranted || !services.mail) return
    setError(null)
    let created: DraftResult
    let attachmentNames: string[]
    try {
      setPhase('attachments')
      const attachments = await loadAttachments(ctx.drive, selectedFiles)
      attachmentNames = attachments.map((a) => a.filename)
      const mime = buildMimeMessage({
        to: { email: customerEmail.trim(), name: customerName.trim() },
        subject,
        text: body,
        html: textToHtml(body),
        attachments,
      })
      setPhase('draft')
      created = await services.mail.createDraft(mime)
    } catch (e) {
      logError('create quote draft', e)
      if (e instanceof MailError && e.needsPermission) setPermissionDenied(true)
      // M5: /api/thumb said the session is gone → "needs reconnect" (the page and the form stay).
      if (e instanceof AttachmentError && e.sessionGone) markSessionLost()
      const msg = errorMessage(e, 'יצירת הטיוטה נכשלה.')
      if (e instanceof MailError && e.userMessage === GMAIL_API_DISABLED_MESSAGE) setError(msg)
      // M1: 5xx / network / unreadable 2xx → a draft may exist; only a refusal or a failure before sending is "not created".
      else if (e instanceof MailError && e.outcome === 'unknown') setError(`${msg} ${MAYBE_CREATED_MESSAGE} לא נרשם דבר ב-Drive.`)
      else setError(`${msg} ${NOT_CREATED_MESSAGE}`)
      setPhase('idle')
      return
    }
    setDraft(created)
    // The log names the customer: a known e-mail → that customer; a new one → the id the customer gets after the draft.
    // The list failed to load → no id at all (the log is matched by e-mail later); never a made-up id.
    const customerId = customers ? (findByEmail(customers, customerEmail)?.id ?? newId()) : undefined
    // Q4: the log is written only after the draft exists.
    await writeLog(
      buildQuoteRecord({
        bid,
        included,
        result,
        customer: { name: customerName, email: customerEmail },
        priceShown: price,
        deliveryTime,
        draftId: created.draftId,
        attachments: attachmentNames,
        now: new Date(),
        customerId,
      }),
    )
  }

  const startOver = () => {
    setDraft(null)
    setPendingLog(null)
    setLogName(null)
    setError(null)
    setCustomerNotice(null)
  }

  const toggleImage = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  return (
    <div className="flex flex-col gap-4 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">שליחת הצעת מחיר — {bid.name}</h1>
        <Link to={`/model/${encodeURIComponent(folderId)}`} className="btn btn-ghost">
          חזרה לדגם
        </Link>
      </div>

      {!gmailGranted && (
        <Notice tone="warn">
          <div className="flex flex-col items-start gap-2" data-testid="gmail-permission">
            <p className="font-semibold">{GMAIL_PERMISSION_MESSAGE}</p>
            <p>
              כדי ליצור טיוטה ב-Gmail יש לאשר לאפליקציה הרשאה ליצור טיוטות (היא לעולם לא שולחת, קוראת או מוחקת מיילים). ייפתח
              חלון התחברות של Google; אחרי האישור חזרו לכאן.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  // Synchronous in the click (mobile Safari blocks popups opened after an await).
                  requestExtraPermission()
                  setPermissionDenied(false)
                }}
              >
                אישור הרשאה ל-Gmail
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void recheckPermissions().catch((e: unknown) => logError('recheck permissions', e))}
              >
                המשך
              </button>
            </div>
          </div>
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {bid.hardware.length > 0 && (
            <section className="card flex flex-col gap-2" aria-label="חומרה בהצעה">
              <h2 className="section-title">מה כלול בהצעה</h2>
              {bid.hardware.map((h, i) => (
                <label key={i} className="flex items-center gap-2 font-normal">
                  <input
                    type="checkbox"
                    checked={included[i] ?? true}
                    onChange={(e) => setIncluded((cur) => cur.map((v, j) => (j === i ? e.target.checked : v)))}
                  />
                  <span>{h.name || `רכיב ${i + 1}`}</span>
                  <span className="text-xs text-stone-500">
                    (<span className="num">{h.qty}</span> × <Money value={h.unitCost} />)
                  </span>
                </label>
              ))}
            </section>
          )}

          <section className="card flex flex-col gap-3" aria-label="פרטי הלקוח">
            <h2 className="section-title">פרטי הלקוח</h2>
            <CustomerPicker
              customers={customers ?? []}
              disabled={busy}
              onPick={(c) => {
                setCustomerName(c.name)
                setCustomerEmail(c.email)
                setPrefillMissing(false)
              }}
            />
            {customersError && (
              <p role="status" className="text-xs text-amber-800">
                {customersError} אפשר להמשיך ולהזין את פרטי הלקוח ידנית.
              </p>
            )}
            {prefillMissing && (
              <p role="status" className="text-xs text-amber-800">
                הלקוח שנבחר לא נמצא ברשימת הלקוחות — הזינו את פרטיו ידנית.
              </p>
            )}
            <Field label="שם הלקוח" required value={customerName} onChange={setCustomerName} />
            <Field
              label="מייל הלקוח"
              required
              dir="ltr"
              inputMode="email"
              autoComplete="off"
              value={customerEmail}
              onChange={setCustomerEmail}
              hint={showErrors && !isValidEmail(customerEmail) ? 'כתובת מייל לא תקינה' : undefined}
            />
            <Field
              label="מחיר ללקוח"
              type="number"
              suffix="₪"
              value={priceText ?? String(Number.isFinite(autoPrice) ? autoPrice : '')}
              onChange={(v) => setPriceText(v)}
              hint={!priceOk ? 'מחיר לא תקין — המייל יציג מקום ריק למחיר עד שיוזן מחיר' : undefined}
            />
            {priceText !== null && (
              <button type="button" className="self-start text-sm text-accent underline" onClick={() => setPriceText(null)}>
                חזרה למחיר ברירת המחדל (<span className="num">₪{autoPrice}</span>)
              </button>
            )}
            <Field label="זמן אספקה (לא חובה)" value={deliveryTime} onChange={setDeliveryTime} placeholder="למשל: 5–7 ימי עסקים" />
            <div className="flex flex-col gap-1">
              <label htmlFor="quote-note">הערה (לא חובה)</label>
              <textarea id="quote-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </section>

          <section className="card flex flex-col gap-2" aria-label="תמונות לצירוף">
            <h2 className="section-title">תמונות לצירוף</h2>
            {images.length === 0 ? (
              <p className="text-sm text-stone-500">אין תמונות בתיקיית הדגם.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {images.map((f) => (
                  <label key={f.id} className="flex flex-col gap-1 font-normal">
                    <DriveImage drive={ctx.drive} file={f} alt={f.name} size={320} className="aspect-square w-full rounded-lg object-cover" />
                    <span className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={selected.has(f.id)}
                        aria-label={`צירוף ${f.name}`}
                        onChange={(e) => toggleImage(f.id, e.target.checked)}
                      />
                      <span className="truncate">
                        <bdi dir="ltr">{f.name}</bdi>
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <p className="text-xs text-stone-500">התמונות מצורפות כ-JPEG ברוחב 1600 פיקסלים (עד 20 MB בסך הכול).</p>
          </section>

          <section className="card flex flex-col gap-3" aria-label="תצוגה מקדימה של המייל">
            <h2 className="section-title">המייל ללקוח</h2>
            <Field label="נושא" value={subject} onChange={(v) => setSubjectOverride(v)} />
            <div
              dir="rtl"
              lang="he"
              className="rounded-lg border border-stone-200 bg-white p-3 text-sm leading-relaxed"
              data-testid="email-preview"
            >
              {body
                .split(/\n{2,}/)
                .filter((p) => p.trim() !== '')
                .map((p, i) => (
                  <p key={i} className="mb-3 whitespace-pre-wrap last:mb-0">
                    {p.trim()}
                  </p>
                ))}
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="quote-body">עריכת תוכן המייל</label>
              <textarea
                id="quote-body"
                rows={10}
                dir="rtl"
                value={body}
                onChange={(e) => {
                  if (bodyOverride === null) setOverrideInputs(inputsKey)
                  setBodyOverride(e.target.value)
                }}
              />
            </div>
            {(bodyOverride !== null || subjectOverride !== null) && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="text-sm text-accent underline"
                  onClick={() => {
                    setBodyOverride(null)
                    setSubjectOverride(null)
                    setOverrideInputs(null)
                  }}
                >
                  שחזור הנוסח האוטומטי
                </button>
                {bodyStale && (
                  <span role="status" className="rounded bg-amber-50 px-2 py-0.5 text-sm text-amber-900" data-testid="stale-body-warning">
                    {STALE_BODY_WARNING}
                  </span>
                )}
              </div>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-3 lg:sticky lg:top-20">
          <section className="card flex flex-col gap-1 text-sm" aria-label="מחיר פנימי" data-testid="quote-internal">
            <h2 className="section-title">לשימוש פנימי — לא נשלח ללקוח</h2>
            <div className="flex justify-between">
              <span className="text-stone-600">עלות כוללת</span>
              <Money value={result.landed} />
            </div>
            <div className="flex justify-between font-semibold">
              <span>מחיר 70%</span>
              <span data-testid="quote-price-70">
                <Money value={result.price70} />
              </span>
            </div>
            <div className="flex justify-between text-stone-600">
              <span>ברירת מחדל ללקוח (מעוגל למעלה)</span>
              <span className="num" data-testid="quote-default-price">
                ₪{autoPrice}
              </span>
            </div>
          </section>

          {draft && !pendingLog && phase === 'idle' ? (
            <div className="card flex flex-col gap-2 border-emerald-200 bg-emerald-50 text-sm text-emerald-900" role="status" data-testid="draft-success">
              <p className="font-semibold">הטיוטה נוצרה ב-Gmail.</p>
              <p>פתחו את תיקיית הטיוטות, בדקו את המייל ולחצו „שליחה” ב-Gmail.</p>
              {logName && <p className="text-xs">ההצעה נרשמה בתיקיית הדגם (quotes/{logName}).</p>}
              {customerNotice?.tone === 'info' && (
                <p className="text-xs" data-testid="customer-notice">
                  {customerNotice.text}
                </p>
              )}
              <a className="btn btn-primary" href={GMAIL_DRAFTS_URL} target="_blank" rel="noreferrer">
                פתיחת הטיוטות ב-Gmail
              </a>
              <button type="button" className="btn btn-ghost" onClick={startOver}>
                טיוטה נוספת
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void onCreate()}
              disabled={busy || !gmailGranted || !!draft || priceBlock !== null}
            >
              {phase === 'attachments' ? 'מכין תמונות…' : phase === 'draft' ? 'יוצר טיוטה…' : phase === 'log' || phase === 'customer' ? 'רושם הצעה…' : 'צור טיוטה ב-Gmail'}
            </button>
          )}
          {priceBlock && !draft && (
            <Notice tone="warn">
              <span data-testid="price-block">{priceBlock}</span>
            </Notice>
          )}
          {showErrors && problems.length > 0 && (
            <ErrorBox>
              <span className="flex flex-col">
                {problems.map((p) => (
                  <span key={p}>{p}</span>
                ))}
              </span>
            </ErrorBox>
          )}
          {error && <ErrorBox onRetry={pendingLog ? () => void writeLog(pendingLog) : undefined}>{error}</ErrorBox>}
          {customerNotice?.tone === 'warn' && (
            // Non-blocking: the draft and its log already succeeded.
            <div role="status" className="flex flex-col items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="customer-notice">
              <span>{customerNotice.text}</span>
              {customerNotice.retry && (
                <button
                  type="button"
                  className="btn btn-secondary px-3 py-1"
                  disabled={busy}
                  onClick={() => customerNotice.retry && void retryCustomer(customerNotice.retry)}
                >
                  שמירת הלקוח שוב
                </button>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
