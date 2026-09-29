import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { DriveImage } from '../components/DriveImage'
import { createObjectUrlSafe } from '../components/useObjectUrl'
import { PricePanel } from '../components/PricePanel'
import { RequireDrive, type DriveContext } from '../components/RequireDrive'
import { ErrorBox, Money, Spinner } from '../components/ui'
import type { Bid, BidFile, BidLine } from '../lib/bid'
import { loadBid } from '../lib/drive/bidRepository'
import { errorMessage, logError } from '../lib/errors'
import { formatDate, formatNumber } from '../lib/format'

export function ModelPageRoute() {
  const { id = '' } = useParams()
  return <RequireDrive>{(ctx) => <ModelPage ctx={ctx} folderId={id} />}</RequireDrive>
}

async function downloadDriveFile(ctx: DriveContext, file: BidFile) {
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

function ModelPage({ ctx, folderId }: { ctx: DriveContext; folderId: string }) {
  const [bid, setBid] = useState<Bid | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    loadBid(ctx.drive, folderId)
      .then((r) => !cancelled && setBid(r.bid))
      .catch((e: unknown) => {
        logError('load bid', e)
        if (!cancelled) setError(errorMessage(e, 'טעינת הדגם נכשלה.'))
      })
    return () => {
      cancelled = true
    }
  }, [ctx.drive, folderId, tick])

  if (error) return <ErrorBox onRetry={() => setTick((t) => t + 1)}>{error}</ErrorBox>
  if (!bid) return <Spinner label="טוען דגם…" />

  const images = bid.files.filter((f) => f.kind === 'image')
  const sliced = bid.files.filter((f) => f.kind === 'sliced')
  const models = bid.files.filter((f) => f.kind === 'model')

  const download = async (f: BidFile) => {
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
        <Link to={`/model/${encodeURIComponent(folderId)}/edit`} className="btn btn-secondary">
          עריכה
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {bid.description && (
            <section className="card">
              <h2 className="section-title">תיאור</h2>
              <p className="whitespace-pre-wrap text-stone-700">{bid.description}</p>
            </section>
          )}

          {images.length > 0 && (
            <section className="card" aria-label="תמונות">
              <h2 className="section-title">תמונות</h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {images.map((f) => (
                  <DriveImage key={f.id} drive={ctx.drive} fileId={f.id} alt={f.name} className="aspect-square w-full rounded-lg object-cover" />
                ))}
              </div>
            </section>
          )}

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
            {models.length > 0 && (
              <ul className="flex flex-col gap-1 text-sm">
                {models.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-2 rounded bg-stone-50 px-2 py-1">
                    <span className="truncate" dir="ltr">
                      {f.name}
                    </span>
                    <button type="button" className="text-accent underline" onClick={() => download(f)}>
                      הורדה
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {downloadError && <ErrorBox>{downloadError}</ErrorBox>}
          </section>
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
