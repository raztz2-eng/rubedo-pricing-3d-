/** Anything `new Headers(...)` accepts (the DOM `HeadersInit` type is not global under Node types). */
export type HeaderInput = ConstructorParameters<typeof Headers>[0]

/** Small HTTP helpers shared by the /api functions (Web-standard Request/Response). */

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const name = part.slice(0, i).trim()
    const value = part.slice(i + 1).trim()
    if (name && !(name in out)) out[name] = value
  }
  return out
}

export interface CookieOptions {
  path: string
  maxAge: number
}

/** Every cookie we set is HttpOnly; Secure; SameSite=Lax (brief v0.4 D-G). */
export function serializeCookie(name: string, value: string, { path, maxAge }: CookieOptions): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=${maxAge}`
}

export function clearCookie(name: string, path: string): string {
  return serializeCookie(name, '', { path, maxAge: 0 })
}

export function json(status: number, body: unknown, headers: HeaderInput = {}): Response {
  const h = new Headers(headers)
  h.set('Content-Type', 'application/json; charset=utf-8')
  h.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(body), { status, headers: h })
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** A plain Hebrew (+ English) error/info page for the browser-facing auth endpoints. */
export function htmlPage(status: number, titleHe: string, messageHe: string, messageEn: string, headers: HeaderInput = {}): Response {
  const h = new Headers(headers)
  h.set('Content-Type', 'text/html; charset=utf-8')
  h.set('Cache-Control', 'no-store')
  const body = `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RUBEDO.3D — ${escapeHtml(titleHe)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.4rem">${escapeHtml(titleHe)}</h1>
<p>${escapeHtml(messageHe)}</p>
<p dir="ltr" lang="en" style="color:#666;font-size:.9rem">${escapeHtml(messageEn)}</p>
<p><a href="/">חזרה לאפליקציה</a></p>
</body>
</html>`
  return new Response(body, { status, headers: h })
}

export function redirect(location: string, headers: HeaderInput = {}): Response {
  const h = new Headers(headers)
  h.set('Location', location)
  h.set('Cache-Control', 'no-store')
  return new Response(null, { status: 302, headers: h })
}

export function requestOrigin(req: Request): string {
  return new URL(req.url).origin
}

/** CSRF check (brief v0.4): an Origin header, when present, must be this site's own origin. */
export function isCrossOrigin(req: Request): boolean {
  const origin = req.headers.get('Origin')
  return origin !== null && origin !== requestOrigin(req)
}
