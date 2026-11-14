import type { RequestInstance } from '@stacksjs/types'
import { Auth } from '@stacksjs/auth/authentication'
import { authCookieToken } from '@stacksjs/auth/cookie'
import { sessionUser } from '@stacksjs/auth/session-auth'
import { config } from '@stacksjs/config'
import { readJsonBody, RequestBodyError } from '@stacksjs/router/body'
import { validateCsrfRequest } from '@stacksjs/defaults/app/Middleware/Csrf.ts'
import { createBroadcastHub, createBroadcastResponse, createDurableReplayResponse } from '@stacksjs/realtime'
import type { DurableReplayCursor } from '@stacksjs/realtime'
import type { Row, WorkspaceTransaction } from './database'
import { one, query, replayOperatorTransaction, workspaceTransaction } from './database'
import { boundedEnvelope, boundedPage, customerProjectionLimits } from './customer-projection'
import { fail, identifier, SupportError } from './errors'
import { agentReplayChannel, customerReplayChannel, supportReplayInvalidations, supportReplayStore } from './replay'
import { conversations, detail, digest, member, project } from './service'

export type RealtimeOperation = 'snapshot' | 'replay' | 'stream'
const leaseMs = 120_000, renewalMs = 30_000
const caps = { project: 1536, workspace: 2048, operator: 3072 } as const
const json = (body: unknown, status = 200) => Response.json(boundedEnvelope(body), { status, headers: { 'Cache-Control': 'no-store' } })
const snapshotRequired = () => json({ cursor: null, snapshotRequired: true }, 409)
interface Principal { project: Row, person?: Row, agentId?: number, channel: string, origin: string }

function exactOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value === 'null') return false
  try { const url = new URL(value); return url.origin === value && ['https:', 'http:'].includes(url.protocol) }
  catch { return false }
}
function cookie(request: RequestInstance, name: string) {
  const pairs = (request.headers.get('cookie') || '').split(';').map(pair => pair.trim()).filter(pair => pair.startsWith(name + '='))
  if (pairs.length !== 1) return ''
  try { return decodeURIComponent(pairs[0]!.slice(name.length + 1)) }
  catch { return '' }
}
/** Every call resolves current authority; a router's cached user never grants this transport. */
async function authority(request: RequestInstance, widget: boolean, original?: Principal): Promise<Principal> {
  if (request.headers.has('x-stacks-impersonation') || request.headers.has('x-user-id') || request.headers.has('x-workspace-id') || request.headers.has('x-contact-id')) fail(403, 'forbidden', 'Identity overrides are not supported.')
  const selected = await project(request.getParam('project'))
  if (!await one('SELECT id FROM support_workspaces WHERE id = ?', [selected.workspace_id])) fail(403, 'forbidden', 'Project workspace is unavailable.')
  const origin = request.headers.get('origin')
  if (!exactOrigin(origin)) fail(403, 'origin_denied', 'An exact allowed origin is required.')
  let principal: Principal
  if (widget) {
    let allowed: unknown
    try { allowed = JSON.parse(String(selected.allowed_origins || '[]')) }
    catch { fail(403, 'origin_denied', 'Origin is not allowed.') }
    if (!Array.isArray(allowed) || !allowed.some(value => exactOrigin(value) && value === origin)) fail(403, 'origin_denied', 'Origin is not allowed.')
    const token = /^Bearer ([^\s]{1,512})$/i.exec(request.headers.get('authorization') || '')?.[1]
    if (!token) fail(401, 'invalid_session', 'A customer session is required.')
    const person = await one('SELECT c.* FROM support_customer_sessions s JOIN support_contacts c ON c.id = s.contact_id AND c.workspace_id = s.workspace_id AND c.project_id = s.project_id WHERE s.digest = ? AND s.workspace_id = ? AND s.project_id = ? AND s.expires_at > ?', [digest(token), selected.workspace_id, selected.id, Date.now()])
    if (!person) fail(401, 'invalid_session', 'Customer session is invalid or expired.')
    principal = { project: selected, person, channel: customerReplayChannel(selected, Number(person.id)), origin }
  }
  else {
    let canonical = ''
    try { canonical = new URL(String(config.app.url)).origin }
    catch { fail(503, 'realtime_unavailable', 'Operator origin is not configured.') }
    if (origin !== canonical) fail(403, 'origin_denied', 'Origin is not allowed.')
    if (request.headers.has('authorization')) fail(401, 'unauthorized', 'A browser session is required.')
    // Native CSRF has bearer/action opt-outs. Neither is accepted on agent routes.
    await validateCsrfRequest(request as unknown as Request)
    const token = authCookieToken(request), sessionId = cookie(request, 'session_id')
    let user
    if (token) {
      if (!await Auth.validateToken(token)) fail(401, 'unauthorized', 'Browser session is no longer authorized.')
      Auth.clearState()
      user = await Auth.getUserFromToken(token)
    }
    else if (sessionId) user = await sessionUser(sessionId)
    if (!user) fail(401, 'unauthorized', 'A browser session is required.')
    await member(Number(user.id), Number(selected.workspace_id))
    principal = { project: selected, agentId: Number(user.id), channel: agentReplayChannel(selected), origin }
  }
  if (original && (Number(original.project.id) !== Number(selected.id) || Number(original.project.workspace_id) !== Number(selected.workspace_id) || original.channel !== principal.channel || original.agentId !== principal.agentId)) fail(403, 'forbidden', 'Authority changed during the request.')
  return principal
}

async function input(request: RequestInstance, operation: RealtimeOperation): Promise<Row> {
  if (new URL(request.url).search) fail(422, 'invalid_input', 'Realtime inputs belong in the request body.')
  const value = await readJsonBody(request as unknown as Request, 8192, { rejectDuplicateKeys: true })
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(422, 'invalid_input', 'Send a JSON object.')
  const row = value as Row, fields = operation === 'snapshot' ? ['conversationId'] : ['checkpoint']
  if (Object.keys(row).some(key => !fields.includes(key))) fail(422, 'invalid_input', 'Unsupported realtime field.')
  if (row.conversationId !== undefined && !(typeof row.conversationId === 'string' && /^[1-9]\d*$/.test(row.conversationId) || typeof row.conversationId === 'number' && Number.isSafeInteger(row.conversationId))) fail(422, 'invalid_identifier', 'Use a canonical conversation identifier.')
  if (row.conversationId !== undefined) identifier(row.conversationId)
  if (operation !== 'snapshot') checkpoint(row.checkpoint)
  return row
}
function checkpoint(value: unknown): DurableReplayCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(422, 'invalid_cursor', 'A snapshot checkpoint is required.')
  const cursor = value as Row
  if (Object.keys(cursor).length !== 2 || Object.keys(cursor).some(key => !['incarnation', 'seq'].includes(key)) || typeof cursor.incarnation !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(cursor.incarnation) || !Number.isSafeInteger(cursor.seq) || Number(cursor.seq) < 0) fail(422, 'invalid_cursor', 'Use the complete snapshot checkpoint.')
  return { incarnation: cursor.incarnation, seq: Number(cursor.seq) }
}

/** Global admission serializes counts. Cleanup locks workspaces/channels in deterministic order. */
async function cleanupExpired() {
  // Reserve one of the 128 cleanup slots for the requested expired incarnation.
  const rows = await query('SELECT id, workspace_id, project_id, name FROM support_replay_channels WHERE lease_until <= ? ORDER BY workspace_id, project_id, name LIMIT 127', [Date.now()])
  const groups = new Map<number, Row[]>()
  for (const row of rows) { const workspaceId = Number(row.workspace_id); groups.set(workspaceId, [...(groups.get(workspaceId) || []), row]) }
  for (const [workspaceId, channels] of groups) await workspaceTransaction(workspaceId, async tx => {
    for (const channel of channels) {
      const locked = (await tx.query('UPDATE support_replay_channels SET name = name WHERE id = ? AND workspace_id = ? AND project_id = ? AND lease_until <= ? RETURNING id', [channel.id, workspaceId, channel.project_id, Date.now()]))[0]
      if (locked) {
        await tx.query('DELETE FROM support_replay_events WHERE channel_id = ? AND workspace_id = ? AND project_id = ?', [channel.id, workspaceId, channel.project_id])
        await tx.query('DELETE FROM support_replay_channels WHERE id = ? AND workspace_id = ? AND project_id = ?', [channel.id, workspaceId, channel.project_id])
      }
    }
  })
}
async function live(principal: Principal, tx: WorkspaceTransaction) {
  return (await tx.query('UPDATE support_replay_channels SET name = name WHERE workspace_id = ? AND project_id = ? AND name = ? AND lease_until > ? RETURNING *', [principal.project.workspace_id, principal.project.id, principal.channel, Date.now()]))[0]
}
async function renew(principal: Principal, tx: WorkspaceTransaction, row: Row) {
  const now = Date.now()
  if (Number(row.lease_until) - leaseMs + renewalMs > now) return
  const updated = await tx.query('UPDATE support_replay_channels SET lease_until = ? WHERE id = ? AND workspace_id = ? AND project_id = ? AND incarnation = ? AND lease_until > ? RETURNING id', [now + leaseMs, row.id, principal.project.workspace_id, principal.project.id, row.incarnation, now])
  if (!updated.length) fail(409, 'snapshot_required', 'A new snapshot is required.')
}
async function snapshot(request: RequestInstance, widget: boolean, principal: Principal, data: Row) {
  return await replayOperatorTransaction(async () => {
    await cleanupExpired()
    return await workspaceTransaction(Number(principal.project.workspace_id), async tx => {
      const fresh = await authority(request, widget, principal)
      let row = await live(fresh, tx)
      if (!row) {
        // The target may be beyond the bounded cleanup batch. It is already workspace-locked.
        const expired = (await tx.query('UPDATE support_replay_channels SET name = name WHERE workspace_id = ? AND project_id = ? AND name = ? RETURNING id', [fresh.project.workspace_id, fresh.project.id, fresh.channel]))[0]
        if (expired) {
          await tx.query('DELETE FROM support_replay_events WHERE channel_id = ?', [expired.id])
          await tx.query('DELETE FROM support_replay_channels WHERE id = ?', [expired.id])
        }
        const total = Number((await one('SELECT COUNT(*) AS total FROM support_replay_channels'))!.total)
        const workspaceTotal = Number((await one('SELECT COUNT(*) AS total FROM support_replay_channels WHERE workspace_id = ?', [fresh.project.workspace_id]))!.total)
        const projectTotal = Number((await one('SELECT COUNT(*) AS total FROM support_replay_channels WHERE workspace_id = ? AND project_id = ?', [fresh.project.workspace_id, fresh.project.id]))!.total)
        if (total < caps.operator && workspaceTotal < caps.workspace && projectTotal < caps.project) {
          await supportReplayStore(fresh.project, tx).prune(fresh.channel)
          await tx.query('UPDATE support_replay_channels SET lease_until = ? WHERE workspace_id = ? AND project_id = ? AND name = ?', [Date.now() + leaseMs, fresh.project.workspace_id, fresh.project.id, fresh.channel])
          row = await live(fresh, tx)
        }
      }
      const list = await conversations(fresh.project, fresh.person, undefined, fresh.agentId)
      const summaries = boundedPage(list.conversations, 50, customerProjectionLimits.summaryBytes, item => item)
      const view = { conversations: summaries.items, nextCursor: summaries.nextCursor ?? list.nextCursor, ...(data.conversationId === undefined ? {} : { detail: await detail(fresh.project, data.conversationId, fresh.person) }) }
      // No current-view checkpoint is derived from older history pagination.
      const head = row ? (await supportReplayStore(fresh.project, tx).prune(fresh.channel)).head : null
      await authority(request, widget, principal)
      if (row) await renew(fresh, tx, row)
      const response = json({ snapshot: view, mode: head ? 'realtime' : 'snapshot-only', checkpoint: head, pollAfterMs: 30_000 })
      await authority(request, widget, principal)
      return response
    })
  })
}
async function replay(request: RequestInstance, widget: boolean, principal: Principal, after: DurableReplayCursor) {
  return await workspaceTransaction(Number(principal.project.workspace_id), async tx => {
    const fresh = await authority(request, widget, principal)
    const row = await live(fresh, tx)
    if (!row) { await authority(request, widget, principal); return snapshotRequired() }
    const result = await createDurableReplayResponse({ store: supportReplayStore(fresh.project, tx), channel: fresh.channel, after, authorize: async () => { await authority(request, widget, principal); return true } })
    await authority(request, widget, principal)
    if (result.status === 200) await renew(fresh, tx, row)
    const body = await result.json() as Row
    const response = json({ ...body, ...(result.status === 409 || result.status === 503 ? { cursor: null, snapshotRequired: true } : {}) }, result.status)
    await authority(request, widget, principal)
    return response
  })
}
async function stream(request: RequestInstance, widget: boolean, principal: Principal, after: DurableReplayCursor) {
  const ready = await replay(request, widget, principal, after)
  if (ready.status !== 200) return ready
  createBroadcastHub()
  const response = await createBroadcastResponse({ channels: [principal.channel], invalidations: supportReplayInvalidations(), signal: request.signal, heartbeatMs: 15_000, maxPending: 64,
    authorize: async () => {
      try {
        await authority(request, widget, principal)
        return await workspaceTransaction(Number(principal.project.workspace_id), async tx => {
          const fresh = await authority(request, widget, principal), row = await live(fresh, tx)
          if (!row || row.incarnation !== after.incarnation) return false
          await authority(request, widget, principal)
          await renew(fresh, tx, row)
          await authority(request, widget, principal)
          return true
        })
      }
      catch { return false }
    },
  })
  // Native response owns cancellation/subscription/timer cleanup after headers.
  try { await authority(request, widget, principal) }
  catch (error) { await response.body?.cancel(); throw error }
  return response.status === 200 ? response : json({ error: { code: 'realtime_unavailable', message: 'Realtime stream could not be opened.' } }, response.status)
}

export async function handleRealtime(request: RequestInstance, widget: boolean, operation: RealtimeOperation): Promise<Response> {
  let principal: Principal | undefined
  try {
    principal = await authority(request, widget)
    const data = await input(request, operation)
    const result = operation === 'snapshot' ? await snapshot(request, widget, principal, data) : operation === 'replay' ? await replay(request, widget, principal, checkpoint(data.checkpoint)) : await stream(request, widget, principal, checkpoint(data.checkpoint))
    try { await authority(request, widget, principal) }
    catch (error) { await result.body?.cancel(); throw error }
    if (widget) { result.headers.set('Access-Control-Allow-Origin', principal.origin); result.headers.set('Vary', 'Origin') }
    return result
  }
  catch (error) {
    const status = error instanceof SupportError ? error.status : error instanceof RequestBodyError ? error.status : typeof error === 'object' && error && 'statusCode' in error && error.statusCode === 403 ? 403 : 503
    const result = json({ error: { code: error instanceof SupportError ? error.code : error instanceof RequestBodyError ? 'invalid_input' : 'realtime_unavailable', message: 'Realtime request could not be completed.' } }, status)
    // A stale allowlist must never be reused on an authorization failure.
    if (widget && principal) {
      try { const current = await authority(request, true, principal); result.headers.set('Access-Control-Allow-Origin', current.origin) }
      catch { /* Current authorization, including allowlist, refused. */ }
      result.headers.set('Vary', 'Origin')
    }
    return result
  }
}
