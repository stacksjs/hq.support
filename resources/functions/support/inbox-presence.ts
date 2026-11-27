import { state } from '@stacksjs/stx'
import { useEventListener } from '@stacksjs/stx/composables/use-event-listener'

interface InboxViewer { userId: string, composing: boolean }
interface PresenceState { viewers: InboxViewer[], lastAgentReplyId?: string }
type RequestPresence = (path: string, options: RequestInit) => Promise<PresenceState>

export function createInboxPresence(request: RequestPresence, onReply: (id: string) => Promise<void>, onAccessLost: () => void) {
  const viewers = state<InboxViewer[]>([])
  const latestReply = state('0')
  let path = '', tabId = '', sequence = 0, composing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: AbortController | undefined
  const interval = 5_000

  function cancel() {
    clearTimeout(timer)
    active?.abort()
    active = undefined
    viewers.set([])
  }
  function payload(status: 'viewing' | 'composing' | 'away', options: RequestInit = {}) {
    return { ...options, method: 'POST', body: JSON.stringify({ tabId, sequence: ++sequence, state: status }) }
  }
  function leave(target: string) {
    if (target) void request(target, payload('away', { keepalive: true })).catch(() => undefined)
  }
  async function pulse() {
    if (!path || document.visibilityState === 'hidden') return
    clearTimeout(timer)
    active?.abort()
    const controller = new AbortController(), target = path
    active = controller
    try {
      const result = await request(target, payload(composing ? 'composing' : 'viewing', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]) }))
      if (active !== controller || path !== target) return
      viewers.set(result.viewers)
      if (result.lastAgentReplyId !== undefined && result.lastAgentReplyId !== latestReply()) {
        latestReply.set(result.lastAgentReplyId)
        void onReply(result.lastAgentReplyId).catch(() => undefined)
      }
    }
    catch (failure) {
      if (active !== controller) return
      viewers.set([])
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
  function start(target: string, baseline: string, isComposing: boolean) {
    if (!tabId) tabId = crypto.randomUUID()
    path = target
    latestReply.set(baseline)
    composing = isComposing
    void pulse()
  }
  function update(isComposing: boolean) {
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
      else void pulse()
    }, { target: document })
    const pagehide = useEventListener('pagehide', () => { cancel(); leave(path) })
    return () => { visibility.remove(); pagehide.remove() }
  }
  return { viewers, latestReply, start, stop, update, listen, refresh: pulse }
}
