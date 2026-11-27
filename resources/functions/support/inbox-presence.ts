import { state, useBroadcastStream } from '@stacksjs/stx'
import { useEventListener } from '@stacksjs/stx/composables/use-event-listener'

interface InboxViewer { userId: string, composing: boolean }
interface PresenceState { viewers: InboxViewer[], lastAgentReplyId?: string, customerTyping?: boolean }
interface RequestPresence { <T>(path: string, options?: RequestInit): Promise<T> }
type RequestStream = (path: string, options?: RequestInit) => Promise<Response>

export function createInboxPresence(request: RequestPresence, openStream: RequestStream, onReply: (id: string) => Promise<void>, onAccessLost: () => void) {
  const viewers = state<InboxViewer[]>([])
  const customerTyping = state(false)
  const latestReply = state('0')
  let path = '', tabId = '', sequence = 0, composing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  let active: AbortController | undefined
  let typingRequest: AbortController | undefined
  let typingStream: ReturnType<typeof useBroadcastStream> | undefined
  let typingRevision = 0
  const interval = 5_000

  function cancel() {
    clearTimeout(timer)
    clearTimeout(idle)
    composing = false
    active?.abort()
    active = undefined
    typingStream?.close()
    typingStream = undefined
    typingRequest?.abort()
    typingRequest = undefined
    typingRevision++
    viewers.set([])
    customerTyping.set(false)
  }
  function payload(status: 'viewing' | 'composing' | 'away', options: RequestInit = {}) {
    return { ...options, method: 'POST', body: JSON.stringify({ tabId, sequence: ++sequence, state: status }) }
  }
  function leave(target: string) {
    if (target) void request(target + '/presence', payload('away', { keepalive: true })).catch(() => undefined)
  }

  async function refreshTyping(target: string) {
    const revision = ++typingRevision
    typingRequest?.abort()
    const controller = new AbortController()
    typingRequest = controller
    const timeout = setTimeout(() => controller.abort(), 3500)
    try {
      const result = await request<{ typing: boolean }>(target + '/typing', { signal: controller.signal })
      if (path === target && revision === typingRevision) customerTyping.set(result.typing === true)
    }
    catch { /* The presence heartbeat still reads the authoritative state. */ }
    finally {
      clearTimeout(timeout)
      if (typingRequest === controller) typingRequest = undefined
    }
  }

  function listenForTyping() {
    if (!path || typingStream || document.visibilityState === 'hidden') return
    const target = path
    const refresh = () => { if (typingStream === stream) void refreshTyping(target) }
    const stream = useBroadcastStream({
      endpoint: target + '/typing/stream',
      async request(endpoint, init) {
        const response = await openStream(endpoint, { ...init, method: 'POST' })
        if (typingStream === stream && response.status === 404) stream.close()
        return response
      },
      onConnected: refresh,
      onMessage: (frame) => { if (frame.event === 'invalidated') refresh() },
    })
    typingStream = stream
  }

  async function pulse() {
    if (!path || document.visibilityState === 'hidden') return
    clearTimeout(timer)
    active?.abort()
    const controller = new AbortController(), target = path
    const revision = typingRevision, readsTyping = !typingRequest
    active = controller
    try {
      const result = await request<PresenceState>(target + '/presence', payload(composing ? 'composing' : 'viewing', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]) }))
      if (active !== controller || path !== target) return
      viewers.set(result.viewers)
      if (readsTyping && revision === typingRevision) customerTyping.set(result.customerTyping === true)
      if (result.lastAgentReplyId !== undefined && result.lastAgentReplyId !== latestReply()) {
        latestReply.set(result.lastAgentReplyId)
        void onReply(result.lastAgentReplyId).catch(() => undefined)
      }
    }
    catch (failure) {
      if (active !== controller) return
      viewers.set([])
      if (readsTyping && revision === typingRevision) customerTyping.set(false)
      if ((failure as { status?: number }).status === 403 || (failure as { status?: number }).status === 404) {
        stop(false)
        onAccessLost()
      }
    }
    finally {
      if (active === controller && path === target) {
        active = undefined
        timer = setTimeout(() => void pulse(), interval)
      }
    }
  }
  function stop(sendLeave = true) {
    const previous = path
    path = ''
    cancel()
    latestReply.set('0')
    if (sendLeave) leave(previous)
  }
  function start(target: string, baseline: string) {
    if (!tabId) tabId = crypto.randomUUID()
    path = target
    latestReply.set(baseline)
    void pulse()
    listenForTyping()
  }
  function update(isComposing: boolean) {
    clearTimeout(idle)
    if (isComposing) idle = setTimeout(() => update(false), 8_000)
    if (composing === isComposing) return
    composing = isComposing
    void pulse()
  }
  function listen() {
    const visibility = useEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        cancel()
        leave(path)
      }
      else {
        void pulse()
        listenForTyping()
      }
    }, { target: document })
    const pagehide = useEventListener('pagehide', () => { cancel(); leave(path) })
    return () => { visibility.remove(); pagehide.remove() }
  }
  return { viewers, customerTyping, latestReply, start, stop, update, listen, refresh: pulse }
}
