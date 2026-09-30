import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { DriveImage } from '../components/DriveImage'
import { RequireDrive, type DriveContext } from '../components/RequireDrive'
import { ErrorBox, Money, Notice, Spinner } from '../components/ui'
import { isPriced, type IndexEntry } from '../lib/bid'
import { loadLibraryState, rebuildIndex } from '../lib/drive/bidRepository'
import { errorMessage, logError } from '../lib/errors'

export function LibraryPage() {
  return <RequireDrive>{(ctx) => <Library ctx={ctx} />}</RequireDrive>
}

function Library({ ctx }: { ctx: DriveContext }) {
  const { drive, folderId } = ctx
  const [entries, setEntries] = useState<IndexEntry[] | null>(null)
  // M4: the error remembers which action failed, so "try again" re-runs that action (refresh → refresh).
  const [error, setError] = useState<{ message: string; retry: 'load' | 'refresh' } | null>(null)
  const [skipped, setSkipped] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  // N5: auto-refresh at most once per opening of the library (per models folder).
  const autoRefreshedFor = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const r = await rebuildIndex(drive, folderId)
      setEntries(r.entries)
      setSkipped(r.skipped)
    } catch (e) {
      logError('rebuild index', e)
      setError({ message: errorMessage(e, 'רענון הספרייה נכשל.'), retry: 'refresh' })
    } finally {
      setBusy(false)
    }
  }, [drive, folderId])

  const load = useCallback(async () => {
    setError(null)
    setBusy(true)
    let stale = false
    try {
      const state = await loadLibraryState(drive, folderId)
      setEntries(state.entries)
      if (state.rebuilt) setSkipped(state.rebuilt.skipped)
      stale = state.stale
    } catch (e) {
      logError('load library', e)
      setError({ message: errorMessage(e, 'טעינת הספרייה נכשלה.'), retry: 'load' })
    } finally {
      setBusy(false)
    }
    if (stale && autoRefreshedFor.current !== folderId) {
      autoRefreshedFor.current = folderId
      await refresh()
    }
  }, [drive, folderId, refresh])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    return (entries ?? []).filter((e) => q === '' || e.name.toLocaleLowerCase().includes(q))
  }, [entries, query])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-2xl font-bold">ספרייה</h1>
        <button type="button" className="btn btn-secondary" onClick={refresh} disabled={busy}>
          רענון ספרייה
        </button>
        <Link to="/new" className="btn btn-primary">
          + דגם חדש
        </Link>
      </div>
      <input
        type="search"
        placeholder="חיפוש לפי שם…"
        aria-label="חיפוש לפי שם"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <ErrorBox onRetry={error.retry === 'refresh' ? refresh : load}>{error.message}</ErrorBox>}
      {skipped.length > 0 && (
        <Notice tone="warn">לא ניתן היה לקרוא את bid.json בתיקיות: {skipped.join(', ')} — הן לא מוצגות.</Notice>
      )}
      {entries === null && busy && <Spinner label="טוען ספרייה…" />}
      {entries !== null && filtered.length === 0 && (
        <p className="py-8 text-center text-stone-500">{entries.length === 0 ? 'אין עדיין דגמים שמורים.' : 'לא נמצאו דגמים בשם הזה.'}</p>
      )}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {filtered.map((e) => (
          <li key={e.id}>{isPriced(e) ? <PricedCard entry={e} ctx={ctx} /> : <NeedsSlicingCard entry={e} ctx={ctx} />}</li>
        ))}
      </ul>
    </div>
  )
}

function PricedCard({ entry: e, ctx }: { entry: IndexEntry; ctx: DriveContext }) {
  return (
    <Link
      to={`/model/${encodeURIComponent(e.id)}`}
      className="card flex h-full flex-col gap-2 p-2 transition hover:border-stone-400 hover:shadow"
      data-testid="library-card"
      data-status="priced"
    >
      <DriveImage drive={ctx.drive} fileId={e.coverFileId} alt={e.name} size={400} className="aspect-square w-full rounded-lg object-cover" />
      <div className="flex flex-1 flex-col px-1 pb-1">
        <span className="line-clamp-2 font-semibold">{e.name}</span>
        {e.revision && e.revision !== 'V1' && <span className="text-xs text-stone-500">{e.revision}</span>}
        {e.price70 !== undefined && (
          <span className="mt-auto pt-1 text-lg font-bold text-accent">
            <Money value={e.price70} />
          </span>
        )}
      </div>
    </Link>
  )
}

export const NEEDS_SLICING_BADGE = 'דורש סלייס'
export const SLICED_FOUND_BADGE = 'נמצא קובץ סלייס — צור הצעה'

/** N1: an existing model folder without bid.json — no price; badge; link to create a bid. */
function NeedsSlicingCard({ entry: e, ctx }: { entry: IndexEntry; ctx: DriveContext }) {
  const found = !!e.slicedFileId
  return (
    <div className="flex h-full flex-col gap-1">
      <Link
        to={`/model/${encodeURIComponent(e.id)}`}
        className="card flex flex-1 flex-col gap-2 p-2 transition hover:border-stone-400 hover:shadow"
        data-testid="library-card"
        data-status="needs-slicing"
      >
        <DriveImage drive={ctx.drive} fileId={e.coverFileId} alt={e.name} size={400} className="aspect-square w-full rounded-lg object-cover" />
        <div className="flex flex-1 flex-col gap-1 px-1 pb-1">
          <span className="line-clamp-2 font-semibold">{e.name}</span>
          <span
            className={`mt-auto w-fit rounded-full px-2 py-0.5 text-xs font-medium ${
              found ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'
            }`}
            data-testid="status-badge"
          >
            {found ? SLICED_FOUND_BADGE : NEEDS_SLICING_BADGE}
          </span>
        </div>
      </Link>
      <Link to={`/model/${encodeURIComponent(e.id)}/create`} className="btn btn-secondary text-sm">
        צור הצעת מחיר
      </Link>
    </div>
  )
}
