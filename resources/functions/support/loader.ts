import { messengerLocale } from './messenger-locale'

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
  externalLauncher?: HTMLElement
  resumeAnonymousSession?: boolean
}
export interface SupportUpdateOptions { sessionToken?: string, locale?: string }
export interface SupportControllerOptions { container?: HTMLElement, inline?: boolean }
interface MessengerElement extends HTMLElement {
  sessionToken: string
  readonly updateComplete: Promise<void>
  boot(options: { url: string, project: string, token?: string, locale?: string }): Promise<void>
  update(options: { token?: string, locale?: string }): Promise<void>
  open(): void
  close(): void
  track(event: { event: string, attributes?: Record<string, unknown> }): Promise<{ id: string, accepted: boolean }>
  shutdown(): void
}
interface LauncherElement extends HTMLElement { unread: number, setLocale(locale: string, label?: string): void }

// Replaced by the artifact builder, relative to this hosted ESM entry.
declare const SUPPORT_ELEMENT_MODULE: string
export const supportLayoutCss = `
:host{--support-edge:16px;--support-bottom:max(var(--support-edge),env(safe-area-inset-bottom,0px));--support-viewport-height:calc(100dvh - var(--support-bottom) - 84px - env(safe-area-inset-top,0px));--support-panel-height:var(--support-viewport-height);position:fixed;right:max(var(--support-edge),env(safe-area-inset-right,0px));bottom:var(--support-bottom);z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:12px;max-width:calc(100vw - 2 * var(--support-edge))}
:host([data-inline]){--support-panel-height:var(--hq-support-inline-max-height,var(--support-viewport-height));position:relative;inset:auto;z-index:auto;align-items:flex-start;max-width:100%}
:host([data-inline]) .panel{width:var(--hq-support-inline-width,auto)}
:host([data-inline]) hq-support-messenger{--support-messenger-width:var(--hq-support-inline-width);--support-intro-display:var(--hq-support-inline-intro-display);--support-history-height:var(--hq-support-inline-history-min-height)}
:host([data-external-launcher]:not([data-inline])){bottom:calc(var(--support-bottom) + 70px)}
.panel{max-height:var(--support-panel-height);overflow:auto;border-radius:var(--hq-support-radius,20px);opacity:0;transform:translateY(8px);visibility:hidden}
.panel[data-open]{opacity:1;transform:translateY(0);visibility:visible}
hq-support-launcher{flex-shrink:0}
@media(prefers-reduced-motion:no-preference){.panel{transition:opacity .18s ease,transform .18s ease}@starting-style{.panel[data-open]{opacity:0;transform:translateY(8px)}}}
@media(max-width:480px){:host{--support-edge:12px}}
`.trim()

/** Each controller owns its DOM, session and event subscriptions. */
export function createSupport(controllerOptions: SupportControllerOptions = {}) {
  const events = new EventTarget()
  let host: HTMLElement | undefined
  let messenger: MessengerElement | undefined
  let updateLauncherLocale: ((locale: string) => void) | undefined
  let openMessenger: ((trigger?: HTMLElement) => void) | undefined
  let generation = 0
  let cleanups: (() => void)[] = []

  function shutdown() {
    generation++
    for (const cleanup of cleanups) cleanup()
    cleanups = []
    messenger?.shutdown()
    host?.remove()
    messenger = undefined
    updateLauncherLocale = undefined
    openMessenger = undefined
    host = undefined
  }
  async function boot(options: SupportBootOptions) {
    if (!options?.project?.trim()) throw new Error('A public project ID is required.')
    const locale = messengerLocale(options.locale)
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
    if (options.externalLauncher) mounted.setAttribute('data-external-launcher', '')
    const root = mounted.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    if (options.nonce) style.nonce = options.nonce
    style.textContent = supportLayoutCss
    const panel = document.createElement('div')
    panel.className = 'panel'
    const instance = document.createElement('hq-support-messenger') as MessengerElement
    const button = options.externalLauncher ? undefined : document.createElement('hq-support-launcher') as LauncherElement
    panel.append(instance)
    root.append(style, panel)
    if (button) {
      updateLauncherLocale = language => button.setLocale(language, options.launcherLabel)
      updateLauncherLocale(locale)
      root.append(button)
    }
    let opener: HTMLElement | undefined
    let focusRequest = 0
    const focusTarget = () => options.externalLauncher ?? button?.shadowRoot?.querySelector('button') ?? button
    openMessenger = (trigger = focusTarget()) => {
      opener = trigger
      const opening = ++focusRequest
      instance.open()
      void instance.updateComplete.then(() => {
        if (current === generation && opening === focusRequest && panel.hasAttribute('data-open'))
          instance.shadowRoot?.querySelector<HTMLElement>('#support-close')?.focus({ preventScroll: true })
      })
    }
    const open = () => openMessenger?.()
    const unread = (event: Event) => { if (button) button.unread = Number((event as CustomEvent).detail?.count || 0) }
    const show = () => panel.setAttribute('data-open', '')
    const restoreFocus = () => {
      focusRequest++
      panel.removeAttribute('data-open')
      if (opener) (opener.isConnected ? opener : focusTarget())?.focus({ preventScroll: true })
      opener = undefined
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !opener) return
      event.stopPropagation()
      instance.close()
    }
    button?.addEventListener('opened', open)
    instance.addEventListener('unread', unread)
    instance.addEventListener('opened', show)
    instance.addEventListener('closed', restoreFocus)
    instance.addEventListener('keydown', onKey)
    cleanups.push(() => button?.removeEventListener('opened', open), () => instance.removeEventListener('unread', unread), () => instance.removeEventListener('opened', show), () => instance.removeEventListener('closed', restoreFocus), () => instance.removeEventListener('keydown', onKey))
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
    const connection = { url: api.href.replace(/\/$/, ''), project: options.project, locale }
    const resume = options.resumeAnonymousSession && !options.sessionToken
    if (!resume) {
      await instance.boot({ ...connection, token: options.sessionToken })
      return
    }
    const key = `hq-support:anonymous:${api.href}:${options.project}`
    let saved: string | undefined
    try { saved = sessionStorage.getItem(key) ?? undefined } catch { /* Storage is optional. */ }
    try {
      await instance.boot({ ...connection, token: saved })
    }
    catch (error) {
      if (!saved || (error as { code?: string }).code !== 'invalid_session' || current !== generation) throw error
      try { sessionStorage.removeItem(key) } catch { /* Storage is optional. */ }
      await instance.boot(connection)
    }
    if (current === generation && instance.sessionToken) {
      try { sessionStorage.setItem(key, instance.sessionToken) } catch { /* Storage is optional. */ }
    }
  }
  function active() { if (!messenger) throw new Error('Boot support before using this method.'); return messenger }
  function open(trigger?: HTMLElement) { active(); openMessenger?.(trigger) }
  function close() { active().close() }
  async function update(options: SupportUpdateOptions) {
    const instance = active()
    const locale = options.locale ? messengerLocale(options.locale) : undefined
    if (locale) updateLauncherLocale?.(locale)
    await instance.update({ token: options.sessionToken, locale })
  }
  async function track(event: string, attributes?: Record<string, unknown>) { if (!event?.trim()) throw new Error('Tracking requires an event name.'); return active().track({ event, attributes }) }
  function on(name: string, listener: EventListener) { events.addEventListener(name, listener); return () => events.removeEventListener(name, listener) }
  return { boot, open, close, update, track, shutdown, on, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) }
}
export const support = createSupport()
export default support
