const pending = new Map<string, Promise<void>>()

/** Loads an external script once. */
export function loadScript(src: string): Promise<void> {
  const existing = pending.get(src)
  if (existing) return existing
  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script')
    el.src = src
    el.async = true
    el.defer = true
    el.onload = () => resolve()
    el.onerror = () => {
      pending.delete(src)
      reject(new Error(`failed to load ${src}`))
    }
    document.head.appendChild(el)
  })
  pending.set(src, p)
  return p
}

export const GAPI_SRC = 'https://apis.google.com/js/api.js'
