import { derived, state } from '@stacksjs/stx'
import { createSupportPhone } from '../support-phone'
import type { SupportPhoneState } from '../support-phone'
import { createSupportConsole } from './console'

interface PhoneChannel { id: string, label: string, status: string, verifiedAt: number, browserAvailable: boolean, aiAvailable: boolean, maxDurationSeconds: number | null, country: string | null, number: string | null, reason?: string }
interface PhoneCall { id: string, channelId: string, status: string, direction: string, from: string, to: string, mode: string, maxDurationSeconds: number, durationSeconds: number, providerState: string, settlement: string, reservedCents: number, transcript: string, lastError: string }
interface PhoneCapabilities { channels: PhoneChannel[], supportedRegions: string[], features: { outboundAi: boolean, browserIncoming: boolean, humanTakeover: boolean, outboundAgent: boolean, hold: boolean, voicemail: boolean, numberPurchase: boolean, recording: boolean } }
const terminal = ['completed', 'busy', 'failed', 'no-answer', 'canceled']
export function createPhone() {
  const workspace = createSupportConsole()
  const capabilities = state<PhoneCapabilities | null>(null)
  const calls = state<PhoneCall[]>([])
  const channelId = state('')
  const selectedId = state('')
  const selected = derived(() => calls().find(call => call.id === selectedId()))
  const channel = derived(() => capabilities()?.channels.find(item => item.id === channelId()))
  const browser = state<SupportPhoneState>({ status: 'offline' })
  const registeredChannel = state('')
  const deviceActive = derived(() => !!registeredChannel() || !['offline', 'error'].includes(browser().status))
  const destination = state('')
  const duration = state('120')
  const dialAcknowledged = state(false)
  const filter = state('all')
  const filtered = derived(() => calls().filter(call => filter() === 'all' || (filter() === 'active' ? !terminal.includes(call.status) : terminal.includes(call.status))))
  const canEnable = derived(() => !!channel()?.browserAvailable && !deviceActive() && !workspace.pending())
  const canDial = derived(() => !!capabilities()?.features.outboundAi && !!channel()?.aiAvailable && !workspace.pending() && !dialAcknowledged())
  const canTakeOver = derived(() => !!capabilities()?.features.humanTakeover && browser().status === 'ready' && !!selected() && !terminal.includes(selected()!.status) && selected()!.mode === 'ai' && selected()!.channelId === registeredChannel())
  let disposed = false
  let refreshing = false
  let revision = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let dialKey = ''
  let dialFingerprint = ''

  const device = createSupportPhone({
    token: async () => {
      try { return await workspace.request(workspace.projectPath('/phone/token'), { method: 'POST', body: JSON.stringify({ channelId: registeredChannel() }) }) }
      catch (error) { workspace.error.set(error instanceof Error ? error.message : 'The browser phone could not be authorized.'); throw error }
    },
    onState: value => {
      if (disposed) return
      browser.set(value)
      if (value.status === 'offline') registeredChannel.set('')
      if (value.callId && calls().some(call => call.id === value.callId)) selectedId.set(value.callId)
    },
  })
  async function refresh(showLoading = true) {
    if (!workspace.project() || refreshing || workspace.pending()) return
    refreshing = true
    const current = ++revision
    if (showLoading) workspace.loading.set(true)
    try {
      const results = await Promise.allSettled([
        workspace.request(workspace.projectPath('/phone/capabilities')),
        workspace.request(workspace.projectPath('/phone/calls')),
      ])
      if (disposed || current !== revision) return
      const [availability, history] = results
      if (availability?.status === 'fulfilled') {
        const value = availability.value as PhoneCapabilities
        capabilities.set(value)
        if (!value.channels.some(item => item.id === channelId())) { channelId.set(value.channels[0]?.id || ''); setDuration() }
      }
      else if (availability?.status === 'rejected') { capabilities.set(null); throw availability.reason }
      if (history?.status === 'fulfilled') {
        calls.set(history.value.calls || [])
        if (!calls().some(call => call.id === selectedId())) selectedId.set(calls()[0]?.id || '')
      }
      else if (history?.status === 'rejected') throw history.reason
    }
    catch (error) { if (!disposed && current === revision) workspace.error.set(error instanceof Error ? error.message : 'Phone could not be loaded.') }
    finally { if (!disposed && current === revision) { refreshing = false; if (showLoading) workspace.loading.set(false) } }
  }
  function setDuration() { duration.set(String(Math.min(120, channel()?.maxDurationSeconds || 120))) }
  function changeChannel() { device.destroy(); registeredChannel.set(''); setDuration() }
  async function changeProject() {
    device.destroy()
    registeredChannel.set('')
    capabilities.set(null)
    calls.set([])
    selectedId.set('')
    channelId.set('')
    destination.set('')
    dialKey = ''
    dialFingerprint = ''
    dialAcknowledged.set(false)
    revision++
    refreshing = false
    workspace.loading.set(false)
    await refresh()
  }
  async function boot() {
    await workspace.boot()
    await refresh()
    timer = setInterval(() => { if (!workspace.loading() && !workspace.pending()) void refresh(false) }, 5000)
  }
  async function enable() {
    if (!canEnable()) return
    workspace.error.set('')
    registeredChannel.set(channelId())
    await device.register()
    if (['error', 'offline'].includes(browser().status)) registeredChannel.set('')
  }
  function disable() { device.destroy(); registeredChannel.set('') }
  async function dial() {
    if (!canDial() || workspace.loading()) return
    const seconds = Number(duration()), to = destination().trim()
    if (!/^\+1\d{10}$/.test(to) || !Number.isSafeInteger(seconds) || seconds < 30 || seconds > (channel()?.maxDurationSeconds || 0)) { workspace.error.set('Use an E.164 US or Canadian number beginning +1 and a duration within the channel limit.'); return }
    const fingerprint = JSON.stringify({ project: workspace.project(), channel: channelId(), to, seconds })
    if (fingerprint !== dialFingerprint) { dialKey = crypto.randomUUID(); dialFingerprint = fingerprint }
    const result = await workspace.run(() => workspace.request(workspace.projectPath('/phone/calls'), { method: 'POST', body: JSON.stringify({ channelId: channelId(), to, mode: 'ai', maxDurationSeconds: seconds, idempotencyKey: dialKey }) }), workspace.pending)
    if (result?.call) { selectedId.set(result.call.id); dialAcknowledged.set(true); workspace.notice.set('The call request was recorded. Its current provider status appears below.') }
    await refresh(false)
  }
  async function operate(operation: 'end' | 'reconcile' | 'takeover') {
    const call = selected()
    if (!call || workspace.pending() || (operation === 'takeover' && !canTakeOver())) return
    const result = await workspace.run(() => workspace.request(workspace.projectPath(`/phone/calls/${encodeURIComponent(call.id)}/${operation}`), { method: 'POST', body: '{}' }), workspace.pending)
    if (result?.call) {
      calls.set(calls().map(item => item.id === result.call.id ? result.call : item))
      workspace.notice.set(operation === 'reconcile' ? result.pending ? 'The provider has not confirmed every charge. The reservation remains pending.' : 'Provider costs were reconciled.' : operation === 'takeover' ? 'The transfer was requested. Accept the incoming call in your browser phone.' : 'The end request was recorded.')
    }
    await refresh(false)
  }
  function accept() { device.accept() }
  function reject() { device.reject() }
  function hangUp() { device.disconnect() }
  function mute() { device.mute(!browser().muted) }
  function newCall() { if (workspace.pending()) return; destination.set(''); dialAcknowledged.set(false); dialKey = ''; dialFingerprint = '' }
  function isTerminal(status?: string) { return terminal.includes(status || '') }
  function reasonText(reason?: string) {
    if (reason === 'channel_not_ready') return 'An owner must verify this voice connection before it can be used.'
    if (reason === 'voice_configuration_or_credit_required') return 'Voice AI needs its provider connection, cost settings, available credit and positive spending ceilings.'
    if (reason === 'voice_configuration_unavailable') return 'This voice connection could not be qualified. Ask a workspace owner to review its configuration.'
    return 'AI dialing is unavailable until this channel and its spending controls are ready.'
  }
  function money(cents?: number) { return typeof cents === 'number' ? (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : 'Unavailable' }
  function destroy() { disposed = true; revision++; clearInterval(timer); device.destroy(); workspace.destroy() }
  return { workspace, capabilities, calls, channelId, channel, selectedId, selected, browser, deviceActive, destination, duration, dialAcknowledged, filter, filtered, canEnable, canDial, canTakeOver, refresh, changeChannel, changeProject, boot, enable, disable, dial, newCall, operate, accept, reject, hangUp, mute, isTerminal, reasonText, money, destroy }
}
