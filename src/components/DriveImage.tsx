import { useEffect, useState } from 'react'
import type { DriveStore } from '../lib/drive/types'
import { BlobImage, PlaceholderImage } from './ui'

/** Loads an image from Drive (authenticated) and shows it; placeholder while loading or on failure. */
export function DriveImage({ drive, fileId, alt, className = '' }: { drive: DriveStore; fileId?: string; alt: string; className?: string }) {
  const [blob, setBlob] = useState<Blob | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setBlob(null)
    setFailed(false)
    if (!fileId) return
    let cancelled = false
    drive
      .readBlob(fileId)
      .then((b) => {
        if (!cancelled) setBlob(b)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [drive, fileId])

  if (!fileId || !blob) {
    return (
      <div className="relative">
        <PlaceholderImage className={className} />
        {failed && <span className="absolute bottom-1 start-1 text-xs text-stone-500">התמונה לא נטענה</span>}
      </div>
    )
  }
  return <BlobImage blob={blob} alt={alt} className={className} />
}
