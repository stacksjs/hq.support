import { useEventListener } from '@stacksjs/stx/composables/use-event-listener'

type SendPresence = (path: string, options: RequestInit) => Promise<unknown>

export function createCustomerTyping(send: SendPresence) {
  let target = '', tabId = '', sequence = 0, lastSent = 0
  let idle: ReturnType<typeof setTimeout> | undefined

  async function publish(conversation: string, state: 'composing' | 'away') {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3500)
    try {
      if (!tabId) tabId = crypto.randomUUID()
      await send('/conversations/' + encodeURIComponent(conversation) + '/presence', {
        method: 'POST', body: JSON.stringify({ tabId, sequence: ++sequence, state }),
        keepalive: state === 'away', signal: controller.signal,
      })
    }
    catch { /* Typing is best effort and never blocks the composer. */ }
    finally { clearTimeout(timeout) }
  }

  function stop() {
    clearTimeout(idle)
    const previous = target
    target = ''
    lastSent = 0
    if (previous) void publish(previous, 'away')
  }

  function input(conversation: string, hasDraft: boolean) {
    if (!conversation || !hasDraft || document.visibilityState === 'hidden') { stop(); return }
    if (target !== conversation) { stop(); target = conversation }
    const now = Date.now()
    if (now - lastSent >= 4000) { lastSent = now; void publish(conversation, 'composing') }
    clearTimeout(idle)
    idle = setTimeout(stop, 8000)
  }

  function listen() {
    const visibility = useEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stop() }, { target: document })
    const pagehide = useEventListener('pagehide', stop)
    return () => { visibility.remove(); pagehide.remove() }
  }

  return { input, listen, stop }
}
