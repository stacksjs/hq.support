type VoiceDevice = import('@twilio/voice-sdk').Device
type VoiceCall = import('@twilio/voice-sdk').Call
export interface SupportPhoneState { status: 'offline' | 'connecting' | 'ready' | 'incoming' | 'connected' | 'error', callId?: string, message?: string, muted?: boolean }

/** The official SDK is initialized only after the user chooses to enable their phone. */
export function createSupportPhone(options: { token: () => Promise<{ token: string }>, onState: (state: SupportPhoneState) => void }) {
  let device: VoiceDevice | undefined, call: VoiceCall | undefined, generation = 0
  const state = (value: SupportPhoneState) => options.onState(value)
  function bind(incoming: VoiceCall) {
    if (call) { incoming.reject(); return }
    call = incoming
    const callId = incoming.customParameters.get('call') || incoming.parameters.CallSid
    state({ status: 'incoming', callId })
    incoming.on('accept', () => state({ status: 'connected', callId, muted: false }))
    const ended = () => { if (call === incoming) { call = undefined; state({ status: 'ready' }) } }
    for (const event of ['disconnect', 'cancel', 'reject'] as const) incoming.on(event, ended)
    incoming.on('error', () => { if (call === incoming) { call = undefined; state({ status: 'error', message: 'The browser call failed.' }) } })
  }
  return {
    async register() {
      const current = ++generation
      state({ status: 'connecting' })
      try {
        const [{ Device }, credentials] = await Promise.all([import('@twilio/voice-sdk'), options.token()])
        if (current !== generation) return
        device?.destroy()
        const selected = new Device(credentials.token)
        device = selected
        selected.on('registered', () => { if (device === selected) state({ status: 'ready' }) })
        selected.on('incoming', bind)
        selected.on('error', () => { if (device === selected) state({ status: 'error', message: 'The browser phone could not connect.' }) })
        selected.on('tokenWillExpire', () => {
          void options.token().then(next => { if (device === selected) selected.updateToken(next.token) }).catch(() => { if (device === selected) { selected.destroy(); device = undefined; state({ status: 'offline' }) } })
        })
        await selected.register()
      }
      catch { if (current === generation) state({ status: 'error', message: 'The browser phone could not be enabled.' }) }
    },
    accept() { call?.accept() },
    reject() { call?.reject(); call = undefined; state({ status: device ? 'ready' : 'offline' }) },
    disconnect() { call?.disconnect(); call = undefined; state({ status: device ? 'ready' : 'offline' }) },
    mute(muted: boolean) { call?.mute(muted); if (call) state({ status: 'connected', callId: call.customParameters.get('call'), muted }) },
    destroy() { generation++; call?.disconnect(); call = undefined; device?.destroy(); device = undefined; state({ status: 'offline' }) },
  }
}
