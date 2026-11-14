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
  const url = new URLSearchParams(location.search).get('native') ? 'http://127.0.0.1:4411/support.js' : '/support.js'
  const module = await import(url)
  check(!customElements.get('hq-support-messenger'), 'loader import is lazy and does not register elements')
  const first = module.createSupport()
  const container = document.querySelector('#component-container')!
  const second = module.createSupport({ container })
  let ready = 0
  first.on('ready', () => ready++)
  await first.boot({ endpoint: location.origin, project: 'proof', sessionToken: 'private-bootstrap-token', nonce: 'proof-style-nonce' })
  await second.boot({ endpoint: location.origin, project: 'proof' })
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
  first.open()
  await messenger.updateComplete
  check(!!messenger.shadowRoot.querySelector('section') && !other.opened, 'open changes only the selected controller')
  check(getComputedStyle(fixedHost).position === 'fixed', 'host layout style works under the strict script CSP')
  check(getComputedStyle(messenger.shadowRoot.querySelector('section')).backgroundColor === 'rgb(255, 255, 255)', 'native shadow styles work with the emitted CSP hashes')
  messenger.emit('unread', { count: 3 })
  check(launcher.unread === 3, 'unread event updates this instance launcher')
  first.close()
  await messenger.updateComplete
  check(!messenger.shadowRoot.querySelector('section'), 'close hides the native panel')
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
