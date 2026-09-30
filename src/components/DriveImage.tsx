import { useEffect, useState } from 'react'
import { loadPreviewBlob, NoPreviewError, PREVIEW_SIZE } from '../lib/drive/images'
import type { DriveFile, DriveStore } from '../lib/drive/types'
import { BlobImage, PlaceholderImage } from './ui'

type LoadState = { key: string; blob: Blob | null; status: 'loading' | 'ok' | 'none' | 'failed' }

/**
 * Shows a Drive image preview; placeholder while loading, when there is no preview or on failure.
 *  - Real Drive: `<img src="/api/thumb?id=…&s=…">` — the backend fetches Drive's thumbnail with the session, so it
 *    works for every image type incl. iPhone HEIC (brief v0.4).
 *  - In-memory drive (tests, demo mode): the preview is loaded as a blob (no backend).
 * Pass `file` when its metadata is already known (folder listing), otherwise `fileId`.
 */
export function DriveImage({
  drive,
  fileId,
  file,
  alt,
  className = '',
  size = PREVIEW_SIZE,
}: {
  drive: DriveStore
  fileId?: string
  file?: DriveFile
  alt: string
  className?: string
  size?: number
}) {
  const key = file?.id ?? fileId ?? ''
  const url = key ? drive.thumbnailUrl(key, size) : null
  if (url) return <UrlImage key={url} url={url} alt={alt} className={className} />
  return <BlobDriveImage drive={drive} fileKey={key} file={file} alt={alt} className={className} size={size} />
}

function Placeholder({ className, status }: { className: string; status?: LoadState['status'] }) {
  return (
    <div className="relative">
      <PlaceholderImage className={className} />
      {status === 'failed' && <span className="absolute bottom-1 start-1 text-xs text-stone-500">התמונה לא נטענה</span>}
      {status === 'none' && <span className="absolute bottom-1 start-1 text-xs text-stone-500">אין תצוגה מקדימה</span>}
    </div>
  )
}

/** Keyed by URL by the parent, so a failure never sticks to another image. */
function UrlImage({ url, alt, className }: { url: string; alt: string; className: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <Placeholder className={className} status="none" />
  return <img src={url} alt={alt} className={className} loading="lazy" decoding="async" onError={() => setFailed(true)} />
}

function BlobDriveImage({
  drive,
  fileKey: key,
  file,
  alt,
  className,
  size,
}: {
  drive: DriveStore
  fileKey: string
  file?: DriveFile
  alt: string
  className: string
  size: number
}) {
  const [state, setState] = useState<LoadState>({ key: '', blob: null, status: 'loading' })

  useEffect(() => {
    if (!key) return
    let cancelled = false
    const run = async () => {
      const meta = file ?? (await drive.getFile(key))
      return loadPreviewBlob(drive, meta, size)
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
  }, [drive, key, size])

  // Only render a result that belongs to the current file (async state tagged with its key).
  const current = state.key === key ? state : null
  if (!key || !current || !current.blob) return <Placeholder className={className} status={current?.status} />
  return <BlobImage blob={current.blob} alt={alt} className={className} />
}
