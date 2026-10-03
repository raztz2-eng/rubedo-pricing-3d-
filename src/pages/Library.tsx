import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { DriveImage } from '../components/DriveImage'
import { RequireDrive, type DriveContext } from '../components/RequireDrive'
import { ErrorBox, Money, Notice, Spinner } from '../components/ui'
import { isArchived, isPriced, type IndexEntry } from '../lib/bid'
import { loadLibraryState, rebuildIndex, RESTORE_LABEL, setModelArchived } from '../lib/drive/bidRepository'
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
  // v0.7 A2: the archive view lives in the URL (?view=archive) so back and refresh keep it.
  const [searchParams] = useSearchParams()
  const archiveView = searchParams.get('view') === 'archive'
  /** Restore from the archive view: the folder being restored, and a failed restore (tagged with its folder). */
  const [restoring, setRestoring] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<{ id: string; name: string; message: string } | null>(null)
  useEffect(() => setRestoreError(null), [archiveView])
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

  const inView = useMemo(() => (entries ?? []).filter((e) => isArchived(e) === archiveView), [entries, archiveView])
  const archivedCount = useMemo(() => (entries ?? []).filter(isArchived).length, [entries])
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    return inView.filter((e) => q === '' || e.name.toLocaleLowerCase().includes(q))
  }, [inView, query])

  const restore = async (e: IndexEntry) => {
    if (restoring) return
    setRestoring(e.id)
    setRestoreError(null)
    try {
      await setModelArchived(drive, folderId, e.id, false)
      // The card goes back to the main library right away (the index was updated by the restore).
      setEntries((list) => (list ?? []).map((x) => (x.id === e.id ? { ...x, archived: false } : x)))
    } catch (err) {
      logError('restore model', err)
      setRestoreError({ id: e.id, name: e.name, message: errorMessage(err, 'השחזור לספרייה נכשל.') })
    } finally {
      setRestoring(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-2xl font-bold">{archiveView ? 'ארכיון' : 'ספרייה'}</h1>
        <button type="button" className="btn btn-secondary" onClick={refresh} disabled={busy}>
          רענון ספרייה
        </button>
        <Link to="/new" className="btn btn-primary">
          + דגם חדש
        </Link>
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        {archiveView ? (
          <Link to={{ search: '' }} className="text-accent underline">
            חזרה לספרייה
          </Link>
        ) : (
          <Link to={{ search: '?view=archive' }} className="text-accent underline" data-testid="archive-link">
            ארכיון (<span className="num">{archivedCount}</span>)
          </Link>
        )}
      </div>
      <input
        type="search"
        placeholder="חיפוש לפי שם…"
        aria-label="חיפוש לפי שם"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <ErrorBox onRetry={error.retry === 'refresh' ? refresh : load}>{error.message}</ErrorBox>}
      {restoreError && archiveView && (
        <ErrorBox onRetry={() => {
          const e = (entries ?? []).find((x) => x.id === restoreError.id)
          if (e) void restore(e)
        }}>
          {restoreError.name}: {restoreError.message}
        </ErrorBox>
      )}
      {skipped.length > 0 && (
        <Notice tone="warn">לא ניתן היה לקרוא את bid.json בתיקיות: {skipped.join(', ')} — הן לא מוצגות.</Notice>
      )}
      {entries === null && busy && <Spinner label="טוען ספרייה…" />}
      {entries !== null && filtered.length === 0 && (
        <p className="py-8 text-center text-stone-500">
          {inView.length > 0
            ? 'לא נמצאו דגמים בשם הזה.'
            : archiveView
              ? 'אין דגמים בארכיון.'
              : entries.length === 0
                ? 'אין עדיין דגמים שמורים.'
                : 'כל הדגמים בארכיון.'}
        </p>
      )}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-label={archiveView ? 'דגמים בארכיון' : 'דגמים'}>
        {filtered.map((e) => (
          <li key={e.id} className="flex flex-col gap-1">
            {isPriced(e) ? <PricedCard entry={e} ctx={ctx} /> : <NeedsSlicingCard entry={e} ctx={ctx} archived={archiveView} />}
            {archiveView && (
              <button
                type="button"
                className="btn btn-secondary text-sm"
                onClick={() => void restore(e)}
                disabled={restoring !== null}
                aria-label={`${RESTORE_LABEL}: ${e.name}`}
              >
                {restoring === e.id ? 'משחזר…' : RESTORE_LABEL}
              </button>
            )}
          </li>
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
function NeedsSlicingCard({ entry: e, ctx, archived = false }: { entry: IndexEntry; ctx: DriveContext; archived?: boolean }) {
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
      {!archived && (
        <Link to={`/model/${encodeURIComponent(e.id)}/create`} className="btn btn-secondary text-sm">
          צור הצעת מחיר
        </Link>
      )}
    </div>
  )
}
