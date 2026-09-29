import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { DriveImage } from '../components/DriveImage'
import { RequireDrive, type DriveContext } from '../components/RequireDrive'
import { ErrorBox, Money, Notice, Spinner } from '../components/ui'
import type { IndexEntry } from '../lib/bid'
import { loadLibrary, rebuildIndex } from '../lib/drive/bidRepository'
import { errorMessage, logError } from '../lib/errors'

export function LibraryPage() {
  return <RequireDrive>{(ctx) => <Library ctx={ctx} />}</RequireDrive>
}

function Library({ ctx }: { ctx: DriveContext }) {
  const { drive, folderId } = ctx
  const [entries, setEntries] = useState<IndexEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [skipped, setSkipped] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      setEntries(await loadLibrary(drive, folderId))
    } catch (e) {
      logError('load library', e)
      setError(errorMessage(e, 'טעינת הספרייה נכשלה.'))
    } finally {
      setBusy(false)
    }
  }, [drive, folderId])

  const refresh = async () => {
    setError(null)
    setBusy(true)
    try {
      const r = await rebuildIndex(drive, folderId)
      setEntries(r.entries)
      setSkipped(r.skipped)
    } catch (e) {
      logError('rebuild index', e)
      setError(errorMessage(e, 'רענון הספרייה נכשל.'))
    } finally {
      setBusy(false)
    }
  }

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
      {error && <ErrorBox onRetry={load}>{error}</ErrorBox>}
      {skipped.length > 0 && (
        <Notice tone="warn">לא ניתן היה לקרוא את bid.json בתיקיות: {skipped.join(', ')} — הן לא מוצגות.</Notice>
      )}
      {entries === null && busy && <Spinner label="טוען ספרייה…" />}
      {entries !== null && filtered.length === 0 && (
        <p className="py-8 text-center text-stone-500">{entries.length === 0 ? 'אין עדיין דגמים שמורים.' : 'לא נמצאו דגמים בשם הזה.'}</p>
      )}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {filtered.map((e) => (
          <li key={e.id}>
            <Link
              to={`/model/${encodeURIComponent(e.id)}`}
              className="card flex h-full flex-col gap-2 p-2 transition hover:border-stone-400 hover:shadow"
              data-testid="library-card"
            >
              <DriveImage drive={drive} fileId={e.coverFileId} alt={e.name} className="aspect-square w-full rounded-lg object-cover" />
              <div className="flex flex-1 flex-col px-1 pb-1">
                <span className="line-clamp-2 font-semibold">{e.name}</span>
                {e.revision && e.revision !== 'V1' && <span className="text-xs text-stone-500">{e.revision}</span>}
                <span className="mt-auto pt-1 text-lg font-bold text-accent">
                  <Money value={e.price70} />
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
