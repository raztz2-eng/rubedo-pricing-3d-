import { useEffect, useState, type ChangeEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { DescriptionField } from '../components/DescriptionField'
import { DriveImage } from '../components/DriveImage'
import { createObjectUrlSafe } from '../components/useObjectUrl'
import { PricePanel } from '../components/PricePanel'
import { RequireDrive, type DriveContext } from '../components/RequireDrive'
import { ErrorBox, Money, Notice, Spinner } from '../components/ui'
import { DESCRIPTION_MAX_LENGTH, type BidLine, type HardwareLine } from '../lib/bid'
import { newKey } from '../lib/bidForm'
import {
  CONVERT_LEGACY_LABEL,
  displayCover,
  LEGACY_BID_MESSAGE,
  loadModelFolder,
  newSaveSession,
  setModelCover,
  setModelDescription,
  uploadModelCover,
  type LocalFile,
  type ModelFolder,
  type SaveSession,
} from '../lib/drive/bidRepository'
import { isGoogleNativeFile } from '../lib/drive/folderContents'
import type { DriveFile } from '../lib/drive/types'
import { errorMessage, logError } from '../lib/errors'
import { formatDate, formatNumber } from '../lib/format'

export function ModelPageRoute() {
  const { id = '' } = useParams()
  return <RequireDrive>{(ctx) => <ModelPage ctx={ctx} folderId={id} />}</RequireDrive>
}

async function downloadDriveFile(ctx: DriveContext, file: { id: string; name: string }) {
  const blob = await ctx.drive.readBlob(file.id)
  const url = createObjectUrlSafe(blob)
  if (!url) throw new Error('object URLs not supported')
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Picture types accepted for "upload a new photo as cover" (same as the bid form). */
const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const SET_COVER_LABEL = 'קבע כתמונה ראשית'
export const UPLOAD_COVER_LABEL = 'העלה תמונה חדשה כראשית'

type Loaded = { folderId: string; data: ModelFolder }
type Action = 'cover' | 'upload' | 'description' | null

function ModelPage({ ctx, folderId }: { ctx: DriveContext; folderId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<{ folderId: string; message: string } | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [action, setAction] = useState<Action>(null)
  /** Error of a cover/description change, with what "try again" re-runs. */
  const [actionError, setActionError] = useState<{ folderId: string; message: string; retry?: () => void } | null>(null)
  const [editingDescription, setEditingDescription] = useState(false)
  const [descriptionText, setDescriptionText] = useState('')

  useEffect(() => {
    let cancelled = false
    setError(null)
    loadModelFolder(ctx.drive, folderId)
      .then((data) => !cancelled && setLoaded({ folderId, data }))
      .catch((e: unknown) => {
        logError('load model folder', e)
        if (!cancelled) setError({ folderId, message: errorMessage(e, 'טעינת הדגם נכשלה.') })
      })
    return () => {
      cancelled = true
    }
  }, [ctx.drive, folderId, tick])

  // Async state is tagged with the folder it was loaded for; render only the current folder's data.
  if (error && error.folderId === folderId) return <ErrorBox onRetry={() => setTick((t) => t + 1)}>{error.message}</ErrorBox>
  if (!loaded || loaded.folderId !== folderId) return <Spinner label="טוען דגם…" />

  const model = loaded.data
  const { folder, contents, bid, legacyBid, meta, metaError } = model
  const slicedIds = new Set([
    ...contents.sliced.map((f) => f.id),
    ...(bid?.files ?? []).filter((f) => f.kind === 'sliced').map((f) => f.id),
  ])
  // M2: native Google files (Docs, Sheets, …) have no bytes to download — they only get their Drive link.
  const sliced = contents.files.filter((f) => slicedIds.has(f.id) && !isGoogleNativeFile(f))
  const otherFiles = contents.files.filter((f) => !slicedIds.has(f.id))
  const coverId = displayCover(model)
  /**
   * Cover and description can change on a marked bid or a folder without bid.json — never on a pre-v0.4 bid, and never
   * while the folder's `_rubedo-model.json` is damaged (it is not replaced; the Founder sees the problem, I3).
   */
  const editable = !legacyBid && !metaError
  const description = bid ? bid.description : (meta?.description ?? '')
  const currentActionError = actionError && actionError.folderId === folderId ? actionError : null

  const download = async (f: DriveFile) => {
    setDownloadError(null)
    setDownloading(f.id)
    try {
      await downloadDriveFile(ctx, f)
    } catch (e) {
      logError('download', e)
      setDownloadError(errorMessage(e, 'ההורדה נכשלה.'))
    } finally {
      setDownloading(null)
    }
  }

  /** Runs a change, then reloads the folder. On failure: Hebrew error + "try again" re-runs the same change. */
  const runAction = async (kind: Exclude<Action, null>, fn: () => Promise<void>, fallback: string): Promise<boolean> => {
    if (action) return false
    setAction(kind)
    setActionError(null)
    try {
      await fn()
      setTick((t) => t + 1)
      return true
    } catch (e) {
      logError(`model page ${kind}`, e)
      setActionError({ folderId, message: errorMessage(e, fallback), retry: () => void runAction(kind, fn, fallback) })
      return false
    } finally {
      setAction(null)
    }
  }

  const chooseCover = (f: DriveFile) =>
    void runAction('cover', () => setModelCover(ctx.drive, ctx.folderId, model, f.id), 'קביעת התמונה הראשית נכשלה.')

  const onCoverFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!COVER_TYPES.includes(file.type)) {
      setActionError({ folderId, message: `אפשר להעלות רק תמונות jpg / png / webp. לא הועלה: ${file.name}` })
      return
    }
    // "Try again" re-runs with the same session, so a picture that was already uploaded is not uploaded twice.
    const upload: LocalFile = { key: newKey('cover'), name: file.name, kind: 'image', mimeType: file.type, blob: file }
    const session: SaveSession = newSaveSession()
    void runAction('upload', () => uploadModelCover(ctx.drive, ctx.folderId, model, upload, session).then(() => undefined), 'העלאת התמונה נכשלה.')
  }

  const startDescriptionEdit = () => {
    setDescriptionText(description)
    setEditingDescription(true)
    setActionError(null)
  }

  // E3: the limit applies only to a changed description.
  const descriptionChanged = descriptionText.trim() !== description.trim()
  const descriptionBlocked = descriptionChanged && descriptionText.trim().length > DESCRIPTION_MAX_LENGTH

  const saveDescription = () => {
    if (descriptionBlocked) return
    void runAction('description', () => setModelDescription(ctx.drive, ctx.folderId, model, descriptionText), 'שמירת התיאור נכשלה.').then(
      (ok) => ok && setEditingDescription(false),
    )
  }

  const title = bid?.name ?? folder.name.trim()

  const coverThumb = (
    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-stone-200" data-testid="model-cover" data-file-id={coverId ?? ''}>
      <DriveImage drive={ctx.drive} fileId={coverId} alt={`${title} — תמונה ראשית`} size={200} className="h-16 w-16 object-cover" />
    </div>
  )

  const actionErrorBox = currentActionError && (
    <ErrorBox onRetry={currentActionError.retry}>{currentActionError.message}</ErrorBox>
  )

  const descriptionSection = (bid?.description || editable) && (
    <section className="card flex flex-col gap-2" aria-label="תיאור">
      <div className="flex items-center justify-between gap-2">
        <h2 className="section-title">תיאור</h2>
        {editable && !editingDescription && (
          <button type="button" className="btn btn-ghost px-2 py-1 text-sm" onClick={startDescriptionEdit} aria-label="עריכת תיאור">
            <span aria-hidden="true">✎</span> עריכה
          </button>
        )}
      </div>
      {editingDescription ? (
        <div className="flex flex-col gap-2">
          <DescriptionField
            label="תיאור הדגם"
            rows={5}
            value={descriptionText}
            onChange={setDescriptionText}
            autoFocus
            limitApplies={descriptionChanged}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={saveDescription}
              disabled={action !== null || descriptionBlocked}
            >
              {action === 'description' ? 'שומר…' : 'שמירת תיאור'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setEditingDescription(false)} disabled={action === 'description'}>
              ביטול
            </button>
          </div>
        </div>
      ) : description ? (
        <p className="whitespace-pre-wrap text-stone-700" data-testid="model-description">
          {description}
        </p>
      ) : (
        <p className="text-sm text-stone-500">אין עדיין תיאור.</p>
      )}
    </section>
  )

  const gallery = (contents.images.length > 0 || editable) && (
    <section className="card flex flex-col gap-2" aria-label="תמונות">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-title">תמונות</h2>
        {editable && (
          <label className={`btn btn-secondary cursor-pointer text-sm ${action ? 'pointer-events-none opacity-60' : ''}`}>
            {action === 'upload' ? 'מעלה תמונה…' : UPLOAD_COVER_LABEL}
            <input
              type="file"
              accept={COVER_TYPES.join(',')}
              className="sr-only"
              aria-label={UPLOAD_COVER_LABEL}
              onChange={onCoverFile}
              disabled={action !== null}
            />
          </label>
        )}
      </div>
      {contents.images.length === 0 ? (
        <p className="text-sm text-stone-500">אין עדיין תמונות בתיקיית הדגם.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="תמונות הדגם">
          {contents.images.map((f) => (
            <li key={f.id} className="flex flex-col gap-1">
              <a href={ctx.drive.fileUrl(f.id)} target="_blank" rel="noreferrer" title={`${f.name} — פתיחה בגודל מלא ב-Drive`}>
                <DriveImage drive={ctx.drive} file={f} alt={f.name} className="aspect-square w-full rounded-lg object-cover" />
              </a>
              {f.id === coverId ? (
                <span className="w-fit rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-dark" data-testid="cover-badge">
                  תמונה ראשית
                </span>
              ) : (
                editable && (
                  <button
                    type="button"
                    className="w-fit text-xs text-accent underline disabled:opacity-60"
                    title={f.name}
                    onClick={() => chooseCover(f)}
                    disabled={action !== null}
                  >
                    {SET_COVER_LABEL}
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )

  const filesSection = (
    <section className="card flex flex-col gap-2" aria-label="קבצים">
      <h2 className="section-title">קבצים</h2>
      <div className="flex flex-wrap gap-2">
        <a className="btn btn-secondary" href={ctx.drive.folderUrl(folderId)} target="_blank" rel="noreferrer">
          פתיחת התיקייה ב-Drive
        </a>
        {sliced.map((f) => (
          <button
            key={f.id}
            type="button"
            className="btn btn-primary"
            title="לאחר ההורדה, לחצו פעמיים על הקובץ כדי לפתוח אותו ב-Bambu Studio"
            onClick={() => download(f)}
            disabled={downloading === f.id}
          >
            {downloading === f.id ? 'מוריד…' : 'הורדה ל-Bambu Studio'}
          </button>
        ))}
      </div>
      {sliced.length > 0 && (
        <p className="text-xs text-stone-500">לאחר ההורדה, לחצו פעמיים על הקובץ כדי לפתוח אותו ב-Bambu Studio.</p>
      )}
      {contents.files.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="קבצי הדגם">
          {[...sliced, ...otherFiles].map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2 rounded bg-stone-50 px-2 py-1">
              <a className="truncate text-accent underline" href={ctx.drive.fileUrl(f.id)} target="_blank" rel="noreferrer">
                <bdi dir="ltr">{f.name}</bdi>
              </a>
              {!slicedIds.has(f.id) && !isGoogleNativeFile(f) && (
                <button type="button" className="shrink-0 text-accent underline" onClick={() => download(f)} disabled={downloading === f.id}>
                  {downloading === f.id ? 'מוריד…' : 'הורדה'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {downloadError && <ErrorBox>{downloadError}</ErrorBox>}
    </section>
  )

  if (!bid) {
    const found = contents.sliced.length > 0
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-3">
          {coverThumb}
          <div className="me-auto min-w-0">
            <h1 className="text-2xl font-bold">{title}</h1>
            <span
              className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                found ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'
              }`}
              data-testid="status-badge"
            >
              {found ? 'נמצא קובץ סלייס — צור הצעה' : 'דורש סלייס'}
            </span>
          </div>
          <Link to={`/model/${encodeURIComponent(folderId)}/create`} className="btn btn-primary">
            צור הצעת מחיר
          </Link>
        </div>
        {!found && (
          <Notice>
            אין עדיין הצעת מחיר לדגם הזה. אפשר לפרוס אותו ב-Bambu Studio (File → Export → Export plate sliced file), לשמור את
            הקובץ בתיקייה, ואז ללחוץ „צור הצעת מחיר” — או להזין את הנתונים ידנית.
          </Notice>
        )}
        {metaError && <Notice tone="warn">{metaError}</Notice>}
        {actionErrorBox}
        {descriptionSection}
        {gallery}
        {filesSection}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        {coverThumb}
        <div className="me-auto min-w-0">
          <h1 className="text-2xl font-bold">{bid.name}</h1>
          <p className="text-sm text-stone-500">
            גרסה {bid.revision} · {formatDate(bid.createdAt)}
            {bid.updatedAt !== bid.createdAt && <> · עודכן {formatDate(bid.updatedAt)}</>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {legacyBid ? (
            <Link to={`/model/${encodeURIComponent(folderId)}/create`} className="btn btn-primary">
              {CONVERT_LEGACY_LABEL}
            </Link>
          ) : (
            <Link to={`/model/${encodeURIComponent(folderId)}/edit`} className="btn btn-primary">
              <span aria-hidden="true">✎</span> עריכת הצעה
            </Link>
          )}
          <Link to={`/model/${encodeURIComponent(folderId)}/quote`} className="btn btn-secondary">
            שליחת הצעת מחיר
          </Link>
        </div>
      </div>
      {legacyBid && (
        <Notice tone="warn">
          <span data-testid="legacy-bid-notice">{LEGACY_BID_MESSAGE}</span>
        </Notice>
      )}
      {actionErrorBox}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {descriptionSection}

          {gallery}

          <section className="card" aria-label="חלקים">
            <h2 className="section-title">חלקים</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-stone-500">
                  <tr>
                    <th className="py-1 text-start font-medium">שם</th>
                    <th className="py-1 text-start font-medium">כמות</th>
                    <th className="py-1 text-start font-medium">גרם</th>
                    <th className="py-1 text-start font-medium">שעות</th>
                  </tr>
                </thead>
                <tbody>
                  {bid.parts.map((p, i) => (
                    <tr key={i} className="border-t border-stone-100">
                      <td className="py-1.5">
                        {p.name || `חלק ${i + 1}`}
                        {p.source === '3mf' && <span className="ms-1 text-xs text-stone-400">(3mf)</span>}
                      </td>
                      <td className="py-1.5"><span className="num">{p.qty}</span></td>
                      <td className="py-1.5"><span className="num">{formatNumber(p.grams, 2)}</span></td>
                      <td className="py-1.5"><span className="num">{formatNumber(p.hours, 3)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-sm text-stone-600">
              חומר: {bid.material.name} (<Money value={bid.material.pricePerKg} /> לק״ג) · עבודה: <span className="num">{bid.laborMinutes}</span> דק׳
            </p>
          </section>

          {bid.hardware.length > 0 && <LinesTable title="חומרה" lines={bid.hardware} />}
          {bid.hasShipping && (
            <LinesTable title="אריזה ומשלוח" lines={bid.packaging} extra={{ label: 'משלוח', value: bid.shippingCost }} />
          )}

          {filesSection}
        </div>

        <aside className="lg:sticky lg:top-20">
          <PricePanel result={bid.result} title="פירוט עלות ומחיר" />
        </aside>
      </div>
    </div>
  )
}

function LinesTable({
  title,
  lines,
  extra,
}: {
  title: string
  lines: (BidLine | HardwareLine)[]
  extra?: { label: string; value: number }
}) {
  return (
    <section className="card" aria-label={title}>
      <h2 className="section-title">{title}</h2>
      <table className="w-full text-sm">
        <thead className="text-stone-500">
          <tr>
            <th className="py-1 text-start font-medium">פריט</th>
            <th className="py-1 text-start font-medium">כמות</th>
            <th className="py-1 text-start font-medium">ליחידה</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} className="border-t border-stone-100">
              <td className="py-1.5">
                {l.name}
                {'included' in l && l.included === false && (
                  <span className="ms-1 rounded bg-stone-100 px-1.5 text-xs text-stone-500" data-testid="hardware-excluded">
                    לא כלול במחיר
                  </span>
                )}
              </td>
              <td className="py-1.5"><span className="num">{l.qty}</span></td>
              <td className="py-1.5">
                <Money value={l.unitCost} />
              </td>
            </tr>
          ))}
          {extra && (
            <tr className="border-t border-stone-100">
              <td className="py-1.5">{extra.label}</td>
              <td />
              <td className="py-1.5">
                <Money value={extra.value} />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  )
}
