import type { RequestInstance } from '@stacksjs/types'
import type { Row } from './database'
import { project } from './service'
import { fail } from './errors'

export function exactOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value === 'null') return false
  try { const url = new URL(value); return url.origin === value && ['https:', 'http:'].includes(url.protocol) }
  catch { return false }
}

/** Origin permission is independent of customer authority; it never grants access to data. */
export function customerOrigin(request: Pick<RequestInstance, 'headers'>, selected: Row): string {
  const origin = request.headers.get('origin')
  let allowed: unknown
  try { allowed = JSON.parse(String(selected.allowed_origins || '[]')) }
  catch { fail(403, 'origin_denied', 'Origin is not allowed.') }
  if (!exactOrigin(origin) || !Array.isArray(allowed) || !allowed.some(value => exactOrigin(value) && value === origin)) fail(403, 'origin_denied', 'Origin is not allowed.')
  return origin
}

/** Re-read current project policy even for missing/expired/revoked bearer errors. No cookies. */
export async function customerResponse(request: RequestInstance, response: Response): Promise<Response> {
  response.headers.delete('Access-Control-Allow-Origin')
  response.headers.delete('Access-Control-Allow-Credentials')
  if (!response.headers.get('Vary')?.split(',').some(value => value.trim().toLowerCase() === 'origin')) response.headers.append('Vary', 'Origin')
  try {
    const current = await project(request.getParam('project'))
    response.headers.set('Access-Control-Allow-Origin', customerOrigin(request, current))
  }
  catch { /* Missing/deleted projects, unreadable policy and disallowed Origins remain opaque. */ }
  return response
}
