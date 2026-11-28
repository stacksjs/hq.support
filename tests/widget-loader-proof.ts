// Plain browser host verifies the emitted public entry under a script CSP without eval.
const output = document.querySelector('#checks')!
let failed = 0
const violations: string[] = []
document.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective))
function check(condition: unknown, name: string) {
  const row = document.createElement('p')
  row.textContent = `${condition ? 'PASS' : 'FAIL'}: ${name}`
  output.append(row)
  if (!condition) failed++
}
try {
  const query = new URLSearchParams(location.search)
  const localization = query.get('localization') === '1'
  const draftValidation = query.get('draftValidation') === '1'
  const url = query.get('native') ? 'http://127.0.0.1:4411/support.js' : '/support.js'
  const module = await import(url)
  check(!customElements.get('hq-support-messenger'), 'loader import is lazy and does not register elements')
  const first = module.createSupport()
  const container = document.querySelector('#component-container')!
  const second = module.createSupport({ container })
  let ready = 0
  first.on('ready', () => ready++)
  await first.boot({ endpoint: location.origin, project: 'proof', sessionToken: 'private-bootstrap-token', nonce: 'proof-style-nonce' })
  await second.boot({ endpoint: location.origin, project: 'proof', ...(localization ? { locale: 'de' } : {}) })
  let hosts = [...document.querySelectorAll('[data-hq-support]')]
  check(hosts.length === 2, 'two controllers mount independent hosts')
  const fixedHost = document.querySelector('body > [data-hq-support]')!
  const inlineHost = container.querySelector('[data-hq-support]')!
  check(inlineHost.parentElement === container && getComputedStyle(inlineHost).position === 'relative', 'factory container owns an inline instance without body mounting')
  const messenger = fixedHost.shadowRoot!.querySelector('hq-support-messenger') as any
  const other = inlineHost.shadowRoot!.querySelector('hq-support-messenger') as any
  const launcher = fixedHost.shadowRoot!.querySelector('hq-support-launcher') as any
  check(messenger !== other && messenger.thread !== other.thread, 'customer state is isolated per instance')
  check(ready === 1, 'ready event reaches the loader controller')
  check(fixedHost.shadowRoot!.querySelector('style')!.nonce === 'proof-style-nonce', 'layout style carries the supplied nonce property')
  check(!messenger.hasAttribute('session-token') && !messenger.outerHTML.includes('private-bootstrap-token') && !messenger.outerHTML.includes('fixture-session'), 'bootstrap and session tokens never become HTML attributes')
  const requestFrame = globalThis.requestAnimationFrame
  if (localization) globalThis.requestAnimationFrame = () => 0
  try {
    first.open()
    await messenger.updateComplete
    if (localization) check(messenger.shadowRoot.activeElement?.id === 'support-close', 'opening focuses the close control as soon as the panel renders')
  }
  finally { globalThis.requestAnimationFrame = requestFrame }
  check(!!messenger.shadowRoot.querySelector('section') && !other.opened, 'open changes only the selected controller')
  check(getComputedStyle(fixedHost).position === 'fixed', 'host layout style works under the strict script CSP')
  check(getComputedStyle(messenger.shadowRoot.querySelector('section')).borderTopLeftRadius === '20px', 'native shadow styles work with the emitted CSP hashes')
  messenger.emit('unread', { count: 3 })
  check(launcher.unread === 3, 'unread event updates this instance launcher')
  if (localization) {
    second.open()
    await other.updateComplete
    check(other.shadowRoot.querySelector('section').lang === 'de' && other.shadowRoot.querySelector('h2').textContent === 'Wie können wir helfen?', 'a separate Messenger can open in German')
    if (draftValidation) {
      for (const [widget, message] of [[messenger, 'Enter a message.'], [other, 'Geben Sie eine Nachricht ein.']] as const) {
        const shadow: ShadowRoot = widget.shadowRoot
        const field = shadow.querySelector<HTMLTextAreaElement>('#support-body')!
        field.form!.requestSubmit()
        await widget.updateComplete
        const currentField = shadow.querySelector<HTMLTextAreaElement>('#support-body')!
        const errorId = currentField.getAttribute('aria-describedby')
        const error = errorId && shadow.getElementById(errorId)
        const send = shadow.querySelector<HTMLButtonElement>('#support-send')!
        check(currentField.required && currentField.getAttribute('aria-invalid') === 'true' && error && error.textContent?.trim() === message && shadow.activeElement === currentField, 'empty composer shows localized inline feedback and keeps focus')
        check(error && error.getBoundingClientRect().height > 0 && error.getBoundingClientRect().bottom <= send.getBoundingClientRect().top, 'required feedback leaves Send visible below the message')
        check(!widget.conversationId, 'an empty submission creates no conversation')
      }
      const floating = messenger.shadowRoot.querySelector('#support-body') as HTMLTextAreaElement
      floating.value = '   '
      floating.dispatchEvent(new Event('input', { bubbles: true }))
      floating.form!.requestSubmit()
      await messenger.updateComplete
      check(messenger.shadowRoot.querySelector('#support-body').getAttribute('aria-invalid') === 'true' && !messenger.conversationId, 'whitespace keeps the required feedback and creates no conversation')
    }
    const conversation = () => messenger.shadowRoot.querySelector('section') as HTMLElement
    const composer = conversation().querySelector<HTMLTextAreaElement>('#support-body')!
    composer.focus()
    composer.value = 'مرحبا بالدعم'
    composer.setSelectionRange(1, 4)
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    if (draftValidation) {
      await messenger.updateComplete
      check(conversation().querySelector('#support-body')?.getAttribute('aria-invalid') === 'false' && !conversation().querySelector('#support-body-error')?.textContent?.trim(), 'a corrected draft clears required feedback')
    }
    const session = messenger.sessionToken
    await first.update({ locale: 'ar' })
    await messenger.updateComplete
    await launcher.updateComplete
    check(ready === 1 && messenger.sessionToken === session && messenger.opened, 'switching locale preserves the open session without rebooting')
    check(conversation().lang === 'ar' && getComputedStyle(conversation()).direction === 'rtl', 'Arabic applies a semantic right-to-left direction')
    check(conversation().querySelector('#support-send').textContent.trim() === 'إرسال الرسالة' && launcher.shadowRoot.querySelector('button').getAttribute('aria-label') === 'تواصل مع الدعم', 'the composer and launcher use the active translation')
    const translatedComposer = conversation().querySelector<HTMLTextAreaElement>('#support-body')!
    check(translatedComposer.value === 'مرحبا بالدعم' && messenger.shadowRoot.activeElement === translatedComposer && translatedComposer.selectionStart === 1 && translatedComposer.selectionEnd === 4, 'live locale changes preserve the focused draft and text selection')
    check(other.shadowRoot.querySelector('section').lang === 'de', 'changing the active controller leaves the second controller language intact')
    check(conversation().getBoundingClientRect().width <= innerWidth, 'right-to-left Messenger fits the host viewport')
    const result = new Promise(resolve => messenger.addEventListener('delivery', resolve, { once: true }))
    translatedComposer.form!.requestSubmit()
    await result
    await messenger.updateComplete
    const time = conversation().querySelector('time')!
    const expectedTime = new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date('2026-01-15T17:45:00.000Z'))
    check(time?.dateTime === '2026-01-15T17:45:00.000Z' && time.textContent === expectedTime, 'stored message timestamps use the active locale')
    const deadline = Date.now() + 6000
    const typingStatus = () => conversation().querySelector('[role=status].typing-status')!
    while (!typingStatus().textContent?.trim() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    check(typingStatus().textContent?.trim() === 'فريق الدعم يكتب الآن…' && typingStatus().getAttribute('aria-atomic') === 'true', 'typing is announced in Arabic through the same live region')
    await first.update({ locale: 'en' })
    await messenger.updateComplete
    check(conversation().dir === 'ltr' && conversation().querySelector('time')?.dateTime === time.dateTime && messenger.thread.length === 1, 'returning to English retains the submitted conversation')
    let unknownLocale = false
    try { await first.update({ locale: 'fr' }) }
    catch { unknownLocale = true }
    check(unknownLocale && conversation().lang === 'en', 'unsupported locales leave the current conversation and language intact')
    if (draftValidation) {
      const inline = other.shadowRoot.querySelector('#support-body') as HTMLTextAreaElement
      inline.value = 'Eine Nachricht aus dem eingebetteten Formular.'
      inline.dispatchEvent(new Event('input', { bubbles: true }))
      await other.updateComplete
      const corrected = other.shadowRoot.querySelector('#support-body') as HTMLTextAreaElement
      check(corrected.getAttribute('aria-invalid') === 'false' && !other.shadowRoot.querySelector('#support-body-error')?.textContent?.trim(), 'corrected inline draft clears feedback')
      const delivery = new Promise(resolve => other.addEventListener('delivery', resolve, { once: true }))
      corrected.form!.requestSubmit()
      await delivery
      await other.updateComplete
      check(other.thread.some((message: { body: string }) => message.body === 'Eine Nachricht aus dem eingebetteten Formular.'), 'the inline composer delivers a corrected message')
    }
  }
  first.close()
  await messenger.updateComplete
  check(!messenger.shadowRoot.querySelector('section'), 'close hides the native panel')
  if (localization) check(launcher.shadowRoot.activeElement === launcher.shadowRoot.querySelector('button'), 'closing refocuses the current launcher after its unread update replaced the original button')
  await first.update({ sessionToken: 'private-updated-token' })
  check(ready === 2 && !messenger.outerHTML.includes('private-updated-token'), 'identity update uses the native method without reflecting its token')
  check((await first.track('loader-proof', { source: 'plain-host' })).accepted === true, 'tracking delegates to the scoped customer API')
  first.shutdown()
  hosts = [...document.querySelectorAll('[data-hq-support]')]
  check(hosts.length === 1 && messenger.sessionToken === '' && messenger.thread.length === 0, 'shutdown removes only its host and clears customer state')
  messenger.emit('ready', {})
  check(ready === 2, 'shutdown detaches native event forwarding')
  second.shutdown()
  check(document.querySelectorAll('[data-hq-support]').length === 0 && container.isConnected, 'logout removes owned hosts and preserves the caller container')
  let rejected = false
  try { first.open() }
  catch { rejected = true }
  check(rejected, 'commands after shutdown require a fresh boot')
  check(violations.length === 0, `CSP reports no violations (${violations.join(', ')})`)
}
catch (error) { check(false, error instanceof Error ? error.stack || error.message : String(error)) }
document.title = failed ? `${failed} hosted loader checks failed` : 'All hosted loader checks passed'
const result = document.createElement('strong')
result.textContent = document.title
output.append(result)
export {}
