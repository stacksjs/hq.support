// Official SDK stand-in for a native stx browser fixture, never a production import.
type Listener = (...values: unknown[]) => void
function observed(phase: string) { document.dispatchEvent(new CustomEvent('phone-fixture-event', { detail: phase })) }
class FixtureCall {
  customParameters: Map<string, string>
  parameters = { CallSid: 'CA-local-browser-fixture' }
  private listeners = new Map<string, Listener[]>()
  constructor(id: string) { this.customParameters = new Map([['call', id]]) }
  on(event: string, listener: Listener) { this.listeners.set(event, [...this.listeners.get(event) || [], listener]); return this }
  emit(event: string) { for (const listener of this.listeners.get(event) || []) listener() }
  accept() {
    void fetch('/fixture/info').then(response => response.json()).then(info => {
      if (info.microphoneDenied) { observed('microphone-denied'); this.emit('error') }
      else { observed('accepted'); this.emit('accept') }
    })
  }
  reject() { observed('rejected'); this.emit('reject') }
  disconnect() { observed('disconnected'); this.emit('disconnect') }
  mute(value: boolean) { observed(value ? 'muted' : 'unmuted') }
}
export class Device {
  private listeners = new Map<string, Listener[]>()
  private timer: ReturnType<typeof setInterval> | undefined
  private seen = new Set<string>()
  private destroyed = false
  constructor(token: string) { if (!token) throw new Error('Native phone authorization is required.') }
  on(event: string, listener: Listener) { this.listeners.set(event, [...this.listeners.get(event) || [], listener]); return this }
  private emit(event: string, value?: unknown) { for (const listener of this.listeners.get(event) || []) listener(value) }
  async register() {
    const info = await fetch('/fixture/info').then(response => response.json())
    if (info.registrationDenied) { observed('registration-denied'); throw new Error('Simulated device registration failure.') }
    observed('registered')
    this.emit('registered')
    const poll = async () => {
      const response = await fetch(`/api/support/projects/${encodeURIComponent(info.project)}/phone/calls`)
      if (!response.ok || this.destroyed) return
      const data = await response.json()
      const call = data.calls.find((item: { id: string, mode: string, status: string }) => item.mode === 'agent' && !['completed', 'canceled', 'failed', 'busy', 'no-answer'].includes(item.status) && !this.seen.has(item.id))
      if (!call || this.destroyed) return
      this.seen.add(call.id)
      observed('incoming')
      this.emit('incoming', new FixtureCall(call.id))
    }
    this.timer = setInterval(() => void poll(), 300)
    await poll()
  }
  updateToken(token: string) { if (!token) throw new Error('Native refreshed authorization is required.'); observed('token-refreshed') }
  destroy() { this.destroyed = true; clearInterval(this.timer); this.listeners.clear(); observed('destroyed') }
}
