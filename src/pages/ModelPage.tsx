import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { DriveImage } from '../components/DriveImage'
import { createObjectUrlSafe } from '../components/useObjectUrl'
import { PricePanel } from '../components/PricePanel'
import { RequireDrive, type DriveContext } from '../components/RequireDrive'
import { ErrorBox, Money, Notice, Spinner } from '../components/ui'
import type { BidLine } from '../lib/bid'
import { LEGACY_BID_MESSAGE, loadModelFolder, type ModelFolder } from '../lib/drive/bidRepository'
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

type Loaded = { folderId: string; data: ModelFolder }

function ModelPage({ ctx, folderId }: { ctx: DriveContext; folderId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<{ folderId: string; message: string } | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

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

  const { folder, contents, bid, legacyBid } = loaded.data
  const slicedIds = new Set([
    ...contents.sliced.map((f) => f.id),
    ...(bid?.files ?? []).filter((f) => f.kind === 'sliced').map((f) => f.id),
  ])
  // M2: native Google files (Docs, Sheets, …) have no bytes to download — they only get their Drive link.
  const sliced = contents.files.filter((f) => slicedIds.has(f.id) && !isGoogleNativeFile(f))
  const otherFiles = contents.files.filter((f) => !slicedIds.has(f.id))

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

  const title = bid?.name ?? folder.name.trim()

  const gallery = contents.images.length > 0 && (
    <section className="card" aria-label="תמונות">
      <h2 className="section-title">תמונות</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {contents.images.map((f) => (
          <a key={f.id} href={ctx.drive.fileUrl(f.id)} target="_blank" rel="noreferrer" title={`${f.name} — פתיחה בגודל מלא ב-Drive`}>
            <DriveImage drive={ctx.drive} file={f} alt={f.name} className="aspect-square w-full rounded-lg object-cover" />
          </a>
        ))}
      </div>
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
              <a className="truncate text-accent underline" dir="ltr" href={ctx.drive.fileUrl(f.id)} target="_blank" rel="noreferrer">
                {f.name}
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
        <div className="flex flex-wrap items-start gap-2">
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
        {gallery}
        {filesSection}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="me-auto min-w-0">
          <h1 className="text-2xl font-bold">{bid.name}</h1>
          <p className="text-sm text-stone-500">
            גרסה {bid.revision} · {formatDate(bid.createdAt)}
            {bid.updatedAt !== bid.createdAt && <> · עודכן {formatDate(bid.updatedAt)}</>}
          </p>
        </div>
        {legacyBid ? (
          <Link to={`/model/${encodeURIComponent(folderId)}/create`} className="btn btn-primary">
            צור הצעה מחדש
          </Link>
        ) : (
          <Link to={`/model/${encodeURIComponent(folderId)}/edit`} className="btn btn-secondary">
            עריכה
          </Link>
        )}
      </div>
      {legacyBid && (
        <Notice tone="warn">
          <span data-testid="legacy-bid-notice">{LEGACY_BID_MESSAGE}</span>
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {bid.description && (
            <section className="card">
              <h2 className="section-title">תיאור</h2>
              <p className="whitespace-pre-wrap text-stone-700">{bid.description}</p>
            </section>
          )}

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

function LinesTable({ title, lines, extra }: { title: string; lines: BidLine[]; extra?: { label: string; value: number } }) {
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
              <td className="py-1.5">{l.name}</td>
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
