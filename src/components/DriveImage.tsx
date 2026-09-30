import { useEffect, useState } from 'react'
import { loadPreviewBlob, NoPreviewError } from '../lib/drive/images'
import type { DriveFile, DriveStore } from '../lib/drive/types'
import { BlobImage, PlaceholderImage } from './ui'

type LoadState = { key: string; blob: Blob | null; status: 'loading' | 'ok' | 'none' | 'failed' }

/**
 * Loads an image preview from Drive (authenticated) and shows it; placeholder while loading, when the file has
 * no preview (e.g. HEIC without thumbnail) or on failure. Pass `file` when its metadata is already known
 * (folder listing), otherwise `fileId` (metadata is fetched first).
 */
export function DriveImage({
  drive,
  fileId,
  file,
  alt,
  className = '',
}: {
  drive: DriveStore
  fileId?: string
  file?: DriveFile
  alt: string
  className?: string
}) {
  const key = file?.id ?? fileId ?? ''
  const [state, setState] = useState<LoadState>({ key: '', blob: null, status: 'loading' })

  useEffect(() => {
    if (!key) return
    let cancelled = false
    const run = async () => {
      const meta = file ?? (await drive.getFile(key))
      return loadPreviewBlob(drive, meta)
    }
    run()
      .then((blob) => {
        if (!cancelled) setState({ key, blob, status: 'ok' })
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ key, blob: null, status: e instanceof NoPreviewError ? 'none' : 'failed' })
      })
    return () => {
      cancelled = true
    }
    // `file` is keyed by its id; a new object for the same id must not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drive, key])

  // Only render a result that belongs to the current file (async state tagged with its key).
  const current = state.key === key ? state : null
  if (!key || !current || !current.blob) {
    return (
      <div className="relative">
        <PlaceholderImage className={className} />
        {current?.status === 'failed' && <span className="absolute bottom-1 start-1 text-xs text-stone-500">התמונה לא נטענה</span>}
        {current?.status === 'none' && <span className="absolute bottom-1 start-1 text-xs text-stone-500">אין תצוגה מקדימה</span>}
      </div>
    )
  }
  return <BlobImage blob={current.blob} alt={alt} className={className} />
}
