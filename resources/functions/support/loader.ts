/** Hosted ESM entry. DOM access stays in this module, outside stx page scripts. */
export interface SupportBootOptions {
  endpoint?: string
  project: string
  sessionToken?: string
  locale?: string
  nonce?: string
  mount?: HTMLElement
  inline?: boolean
  launcherLabel?: string
}
export interface SupportUpdateOptions { sessionToken?: string, locale?: string }
export interface SupportControllerOptions { container?: HTMLElement, inline?: boolean }
interface MessengerElement extends HTMLElement {
  boot(options: { url: string, project: string, token?: string }): Promise<void>
  update(options: { token?: string }): Promise<void>
  open(): void
  close(): void
  track(event: { event: string, attributes?: Record<string, unknown> }): Promise<{ id: string, accepted: boolean }>
  shutdown(): void
}
interface LauncherElement extends HTMLElement { label: string, unread: number }

// Replaced by the artifact builder, relative to this hosted ESM entry.
declare const SUPPORT_ELEMENT_MODULE: string
export const supportLayoutCss = ':host{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:12px;max-width:calc(100vw - 32px)}:host([data-inline]){position:relative;inset:auto;z-index:auto}.panel{max-height:calc(100dvh - 100px);overflow:auto;border-radius:20px}hq-support-launcher{flex-shrink:0}@media(max-width:480px){:host{right:12px;bottom:12px;max-width:calc(100vw - 24px)}}'

/** Each controller owns its DOM, session and event subscriptions. */
export function createSupport(controllerOptions: SupportControllerOptions = {}) {
  const events = new EventTarget()
  let host: HTMLElement | undefined
  let messenger: MessengerElement | undefined
  let generation = 0
  let cleanups: (() => void)[] = []

  function shutdown() {
    generation++
    for (const cleanup of cleanups) cleanup()
    cleanups = []
    messenger?.shutdown()
    host?.remove()
    messenger = undefined
    host = undefined
  }
  async function boot(options: SupportBootOptions) {
    if (!options?.project?.trim()) throw new Error('A public project ID is required.')
    assertLocale(options.locale)
    const api = new URL(options.endpoint || new URL(import.meta.url).origin)
    if (!['http:', 'https:'].includes(api.protocol)) throw new Error('Support URL must use HTTP or HTTPS.')
    shutdown()
    const current = generation
    const moduleUrl = new URL(SUPPORT_ELEMENT_MODULE, import.meta.url)
    await import(moduleUrl.href)
    if (current !== generation) return
    await customElements.whenDefined('hq-support-messenger')
    if (current !== generation) return
    const mounted = document.createElement('div')
    mounted.setAttribute('data-hq-support', '')
    if (options.inline ?? controllerOptions.inline ?? !!controllerOptions.container) mounted.setAttribute('data-inline', '')
    const root = mounted.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    if (options.nonce) style.nonce = options.nonce
    style.textContent = supportLayoutCss
    const panel = document.createElement('div')
    panel.className = 'panel'
    const instance = document.createElement('hq-support-messenger') as MessengerElement
    const button = document.createElement('hq-support-launcher') as LauncherElement
    button.label = options.launcherLabel || 'Contact support'
    panel.append(instance)
    root.append(style, panel, button)
    const open = () => instance.open()
    const unread = (event: Event) => { button.unread = Number((event as CustomEvent).detail?.count || 0) }
    button.addEventListener('opened', open)
    instance.addEventListener('unread', unread)
    cleanups.push(() => button.removeEventListener('opened', open), () => instance.removeEventListener('unread', unread))
    for (const name of ['ready', 'opened', 'closed', 'unread', 'delivery', 'error']) {
      const forward = (event: Event) => events.dispatchEvent(new CustomEvent(name, { detail: (event as CustomEvent).detail }))
      instance.addEventListener(name, forward)
      cleanups.push(() => instance.removeEventListener(name, forward))
    }
    host = mounted
    messenger = instance
    const parent = options.mount || controllerOptions.container || document.body
    parent.append(mounted)
    // Customer identity goes straight to the method. It is never serialized into markup.
    await instance.boot({ url: api.href.replace(/\/$/, ''), project: options.project, token: options.sessionToken })
  }
  function assertLocale(locale?: string) { if (locale && locale !== 'en') throw new Error('This messenger currently supports English (en) only.') }
  function active() { if (!messenger) throw new Error('Boot support before using this method.'); return messenger }
  function open() { active().open() }
  function close() { active().close() }
  async function update(options: SupportUpdateOptions) { assertLocale(options.locale); await active().update({ token: options.sessionToken }) }
  async function track(event: string, attributes?: Record<string, unknown>) { if (!event?.trim()) throw new Error('Tracking requires an event name.'); return active().track({ event, attributes }) }
  function on(name: string, listener: EventListener) { events.addEventListener(name, listener); return () => events.removeEventListener(name, listener) }
  return { boot, open, close, update, track, shutdown, on, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) }
}
export const support = createSupport()
export default support
