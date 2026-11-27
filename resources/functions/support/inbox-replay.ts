import type { DurableReplayCursor } from '@stacksjs/realtime'
import { useBroadcastStream } from '@stacksjs/stx'

interface ReplaySession {
  root: string
  controller: AbortController
  cursor?: DurableReplayCursor
  snapshotCursor?: DurableReplayCursor
  snapshotRetries: number
  stream?: ReturnType<typeof useBroadcastStream>
  interval?: ReturnType<typeof setInterval>
  hintTimer?: ReturnType<typeof setTimeout>
  running: boolean
  pending: boolean
}

interface ReplayReply {
  checkpoint?: unknown
  cursor?: unknown
  snapshotRequired?: boolean
  hasMore?: boolean
  error?: { code?: string }
}

type FetchResponse = (path: string, options?: RequestInit) => Promise<Response>

function readCursor(value: unknown): DurableReplayCursor | undefined {
  if (!value || typeof value !== 'object') return
  const cursor = value as Partial<DurableReplayCursor>
  if (typeof cursor.incarnation !== 'string' || !cursor.incarnation || cursor.incarnation.length > 128
    || typeof cursor.seq !== 'number' || !Number.isSafeInteger(cursor.seq) || cursor.seq < 0) return
  return { incarnation: cursor.incarnation, seq: cursor.seq }
}

export function createInboxReplay(request: FetchResponse, refresh: (signal: AbortSignal) => Promise<boolean>, revoked: () => void) {
  let active: ReplaySession | undefined

  function stop() {
    const session = active
    active = undefined
    if (!session) return
    session.controller.abort()
    session.stream?.close()
    clearInterval(session.interval)
    clearTimeout(session.hintTimer)
  }

  async function read(session: ReplaySession, action: 'snapshot' | 'replay', payload: object) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    const signal = session.controller.signal
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, 12_000)
    try {
      const response = await request(session.root + '/' + action, { method: 'POST', body: JSON.stringify(payload), signal: controller.signal })
      const body = await response.json().catch(() => ({})) as ReplayReply
      return { ok: response.ok, status: response.status, body }
    }
    finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
  }

  function wake(session: ReplaySession, delay = 150) {
    if (active !== session || session.hintTimer) return
    session.hintTimer = setTimeout(() => {
      session.hintTimer = undefined
      void sync(session)
    }, delay)
  }

  function connect(session: ReplaySession) {
    if (session.stream || !session.cursor) return
    session.stream = useBroadcastStream({
      endpoint: session.root + '/stream',
      async request(endpoint, init) {
        if (active !== session || !session.cursor) throw new Error('Inbox subscription ended.')
        const response = await request(endpoint, { ...init, method: 'POST', body: JSON.stringify({ checkpoint: session.cursor }) })
        if ([403, 404, 409, 503].includes(response.status)) wake(session)
        return response
      },
      onConnected() { wake(session) },
      onMessage(frame) { if (frame.event === 'invalidated' || frame.event === 'changed') wake(session) },
    })
  }

  function rejected(status: number, body: ReplayReply) {
    if (status !== 403 && status !== 404) return false
    stop()
    if (body.error?.code === 'forbidden' || body.error?.code === 'not_found') revoked()
    return true
  }

  async function snapshot(session: ReplaySession) {
    if (!session.snapshotCursor) {
      const response = await read(session, 'snapshot', {})
      if (active !== session) return
      if (rejected(response.status, response.body) || !response.ok) return
      session.snapshotCursor = readCursor(response.body.checkpoint)
    }
    const applied = await refresh(session.controller.signal)
    if (active !== session) return
    if (!applied && session.snapshotCursor && session.snapshotRetries < 5) {
      const delay = 250 * 2 ** session.snapshotRetries
      session.snapshotRetries++
      wake(session, delay)
      return
    }
    if (applied) session.cursor = session.snapshotCursor
    session.snapshotCursor = undefined
    session.snapshotRetries = 0
    if (applied) connect(session)
  }

  async function sync(session: ReplaySession) {
    if (active !== session) return
    if (session.running) { session.pending = true; return }
    session.running = true
    try {
      const before = session.cursor
      if (!before) { await snapshot(session); return }
      const response = await read(session, 'replay', { checkpoint: before })
      if (active !== session) return
      if (rejected(response.status, response.body)) return
      if (response.body.snapshotRequired) {
        session.cursor = undefined
        session.stream?.close()
        session.stream = undefined
        await snapshot(session)
        return
      }
      const cursor = readCursor(response.body.cursor)
      if (!response.ok || !cursor || cursor.incarnation !== before.incarnation || cursor.seq <= before.seq) return
      // Keep the old checkpoint until the authenticated inbox applied its fresh state.
      if (!await refresh(session.controller.signal) || active !== session) return
      session.cursor = cursor
      if (response.body.hasMore) session.pending = true
    }
    catch { /* The next hint or finite poll recovers a temporary transport failure. */ }
    finally {
      session.running = false
      if (active === session && session.pending) {
        session.pending = false
        wake(session)
      }
    }
  }

  function start(project: string) {
    const root = `/api/support/projects/${encodeURIComponent(project)}/realtime`
    if (active?.root === root) return
    stop()
    if (!project) return
    const session: ReplaySession = { root, controller: new AbortController(), running: false, pending: false, snapshotRetries: 0 }
    active = session
    session.interval = setInterval(() => void sync(session), 30_000)
    void sync(session)
  }

  return { start, stop }
}
