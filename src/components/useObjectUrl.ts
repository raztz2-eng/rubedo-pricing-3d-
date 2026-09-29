import { useEffect, useState } from 'react'

/** Object URL for a blob, revoked on change/unmount. Where object URLs are unavailable (e.g. jsdom) → undefined. */
export function createObjectUrlSafe(blob: Blob): string | undefined {
  if (typeof URL.createObjectURL !== 'function') return undefined
  try {
    return URL.createObjectURL(blob)
  } catch {
    return undefined
  }
}

export function useObjectUrl(blob: Blob | null | undefined): string | undefined {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    const u = blob ? createObjectUrlSafe(blob) : undefined
    setUrl(u)
    return () => {
      if (u) URL.revokeObjectURL(u)
    }
  }, [blob])
  return url
}
