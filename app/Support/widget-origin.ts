import { fail } from './errors'

export function requireWidgetOrigin(request: Pick<Request, 'method' | 'headers'>, allowedOrigins: unknown): string {
  let origin = request.headers.get('origin')
  // Browsers omit Origin on same-origin reads. Fetch Metadata proves the
  // browser relationship and Referer supplies the exact registered origin.
  if (origin === null && ['GET', 'HEAD'].includes(request.method) && request.headers.get('sec-fetch-site') === 'same-origin') {
    const referer = request.headers.get('referer')
    if (referer) {
      try { origin = new URL(referer).origin } catch { /* Invalid referrers are denied. */ }
    }
  }
  const allowed: unknown = JSON.parse(String(allowedOrigins || '[]'))
  if (!origin || origin === 'null' || !Array.isArray(allowed) || !allowed.includes(origin))
    fail(403, 'origin_denied', 'Messenger origin is not allowed for this project.')
  return origin
}
