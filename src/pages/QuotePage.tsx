import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { DriveImage } from '../components/DriveImage'
import { RequireDrive, type DriveContext } from '../components/RequireDrive'
import { ErrorBox, Field, Money, Notice, Spinner } from '../components/ui'
import { loadModelFolder, type ModelFolder } from '../lib/drive/bidRepository'
import { pickCover } from '../lib/drive/folderContents'
import { writeQuoteLog } from '../lib/drive/quoteLog'
import type { DriveFile } from '../lib/drive/types'
import { errorMessage, logError } from '../lib/errors'
import { isValidAmount, parseNumber } from '../lib/format'
import { loadAttachments } from '../lib/mail/attachments'
import { buildMimeMessage } from '../lib/mail/mime'
import { GMAIL_COMPOSE_SCOPE, GMAIL_DRAFTS_URL, GMAIL_PERMISSION_MESSAGE, MailError, type DraftResult } from '../lib/mail/types'
import {
  buildQuoteRecord,
  defaultCustomerPrice,
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

/** "שליחת הצעת מחיר" (brief v0.5 Q3): builds a Gmail DRAFT — the Founder presses Send in Gmail himself. */
export function QuotePageRoute() {
  const { id = '' } = useParams()
  return <RequireDrive>{(ctx) => <QuoteLoader key={id} ctx={ctx} folderId={id} />}</RequireDrive>
}

function QuoteLoader({ ctx, folderId }: { ctx: DriveContext; folderId: string }) {
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
  return <QuoteForm ctx={ctx} folderId={folderId} data={data as ModelFolder & { bid: NonNullable<ModelFolder['bid']> }} />
}

type Phase = 'idle' | 'attachments' | 'draft' | 'log'

function QuoteForm({ ctx, folderId, data }: { ctx: DriveContext; folderId: string; data: ModelFolder & { bid: NonNullable<ModelFolder['bid']> } }) {
  const { services, grantedScopes, requestExtraPermission, recheckPermissions, accountEmail } = useApp()
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
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [draft, setDraft] = useState<DraftResult | null>(null)
  /** The draft exists but the quote log could not be written yet (retry writes only the log). */
  const [pendingLog, setPendingLog] = useState<QuoteRecord | null>(null)
  const [logName, setLogName] = useState<string | null>(null)

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
    price: priceOk ? price : 0,
    deliveryTime,
    note,
    founderEmail,
  })
  const subject = subjectOverride ?? quoteSubject(bid.name)
  const body = bodyOverride ?? generatedBody

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
  if (!priceOk) problems.push('המחיר ללקוח אינו תקין.')
  if (subject.trim() === '') problems.push('יש להזין נושא.')
  if (body.trim() === '') problems.push('תוכן המייל ריק.')
  if (!services.mail) problems.push('חיבור ל-Gmail אינו זמין במצב הזה.')

  const busy = phase !== 'idle'
  const selectedFiles: DriveFile[] = images.filter((f) => selected.has(f.id))

  const writeLog = async (record: QuoteRecord) => {
    setPhase('log')
    try {
      const written = await writeQuoteLog(ctx.drive, folderId, record)
      setLogName(written.name)
      setPendingLog(null)
    } catch (e) {
      logError('write quote log', e)
      setPendingLog(record)
      setError(`הטיוטה נוצרה ב-Gmail, אבל רישום ההצעה בתיקיית הדגם נכשל: ${errorMessage(e, 'שגיאה ב-Drive.')}`)
    } finally {
      setPhase('idle')
    }
  }

  const onCreate = async () => {
    setShowErrors(true)
    if (busy || problems.length > 0 || !gmailGranted || !services.mail) return
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
      setError(`${errorMessage(e, 'יצירת הטיוטה נכשלה.')} לא נוצרה טיוטה ולא נרשם דבר.`)
      setPhase('idle')
      return
    }
    setDraft(created)
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
      }),
    )
  }

  const startOver = () => {
    setDraft(null)
    setPendingLog(null)
    setLogName(null)
    setError(null)
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
            <Field label="שם הלקוח" required value={customerName} onChange={setCustomerName} />
            <Field
              label="מייל הלקוח"
              required
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
              hint={!priceOk ? 'מחיר לא תקין' : undefined}
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
                      <span className="truncate" dir="ltr">
                        {f.name}
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
              <textarea id="quote-body" rows={10} dir="rtl" value={body} onChange={(e) => setBodyOverride(e.target.value)} />
            </div>
            {(bodyOverride !== null || subjectOverride !== null) && (
              <button
                type="button"
                className="self-start text-sm text-accent underline"
                onClick={() => {
                  setBodyOverride(null)
                  setSubjectOverride(null)
                }}
              >
                שחזור הנוסח האוטומטי
              </button>
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
              disabled={busy || !gmailGranted || !!draft}
            >
              {phase === 'attachments' ? 'מכין תמונות…' : phase === 'draft' ? 'יוצר טיוטה…' : phase === 'log' ? 'רושם הצעה…' : 'צור טיוטה ב-Gmail'}
            </button>
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
        </aside>
      </div>
    </div>
  )
}
