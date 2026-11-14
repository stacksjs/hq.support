import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { generateStaticSite } from '@stacksjs/stx/ssg'
import { launch, navigate, waitFor, closeSharedBrowsers } from '@stacksjs/testing/browser'
import { one } from '../../app/Support/database'

/** Production STX/controller, real native HTTP/auth/SQL; only response loss is injected. */
export async function qualifyCredentialSettings(input: { api: string, browserCookie: string, project: string, projectId: number, keyId: string, oldKey: string }) {
  const root = resolve(import.meta.dir, '../..'), output = await mkdtemp(resolve(tmpdir(), 'hq-support-credential-browser-'))
  let browser: Awaited<ReturnType<typeof launch>> | undefined, host: ReturnType<typeof Bun.serve> | undefined
  let dropNextRotation = false, drops = 0
  const assertions: string[] = []
  const check = (condition: unknown, label: string) => { assert.ok(condition, label); assertions.push(label) }
  try {
    const compiled = await generateStaticSite({ pagesDir: resolve(root, 'resources/views'), outputDir: output, publicDir: resolve(root, 'public'), partialsDir: resolve(root, 'resources/partials'), componentsDir: resolve(root, 'resources/components'), router: { enabled: false }, minify: false, cache: false, sitemap: false, robots: false })
    assert.equal(compiled.failedCount, 0, 'Production views compile with installed native STX')
    const html = await Bun.file(resolve(output, 'app/settings.html')).text()
    host = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/_fixture/sign-in') return new Response(null, { status: 303, headers: { location: '/app/settings', 'set-cookie': input.browserCookie, 'cache-control': 'no-store' } })
      if (url.pathname.startsWith('/api/')) {
        const headers = new Headers(request.headers); headers.delete('host')
        const result = await fetch(new URL(url.pathname + url.search, input.api), { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body })
        if (dropNextRotation && request.method === 'POST' && url.pathname.endsWith('/rotate') && result.ok) {
          dropNextRotation = false; drops++
          await result.arrayBuffer()
          return Response.json({ error: { message: 'Test response boundary lost after native commit.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
        }
        const outgoing = new Headers(result.headers); outgoing.delete('content-encoding'); outgoing.delete('content-length')
        return new Response(result.body, { status: result.status, headers: outgoing })
      }
      if (url.pathname === '/app/settings') return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } })
      if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 })
      const file = resolve(output, '.' + decodeURIComponent(url.pathname))
      if (!file.startsWith(output + sep)) return new Response('Forbidden', { status: 403 })
      return await Bun.file(file).exists() ? new Response(Bun.file(file)) : new Response('Not found', { status: 404 })
    } })
    const origin = host.url.origin
    browser = await launch({ headless: true, shared: false, chromePath: process.env.CHROME_PATH, startTimeoutMs: 60000, commandTimeoutMs: 20000, args: process.platform === 'linux' ? ['--disable-dev-shm-usage', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])] : [] })
    const cdp = browser.cdp, errors: string[] = [], failed: string[] = []
    cdp.on('Runtime.exceptionThrown', event => errors.push(String(event.exceptionDetails.exception?.description || event.exceptionDetails.text)))
    cdp.on('Network.responseReceived', event => { if (event.response.status >= 400 && event.response.status !== 503) failed.push(`${event.response.status} ${new URL(event.response.url).pathname}`) })
    await cdp.intercept([{ urlPattern: '*' }], async (event, session) => {
      const target = new URL(event.request.url)
      if (['http:', 'https:'].includes(target.protocol) && target.origin !== origin) {
        // Layout fonts are irrelevant to credential semantics; no external network.
        await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/css' }], body: '' })
      }
      else await session.send('Fetch.continueRequest', { requestId: event.requestId })
    })
    await navigate(cdp, origin + '/_fixture/sign-in', { quietMs: 100, timeoutMs: 20000 })
    await waitFor(() => cdp.evaluate(`document.querySelector('[aria-label="Rotate key ${input.keyId}"]') !== null`), 15000, { label: 'Owner settings key metadata', intervalMs: 50 })
    check(await cdp.evaluate(`document.querySelector('#settings-project').value === ${JSON.stringify(input.project)} && !document.querySelector('button[aria-label="Rotate key ${input.keyId}"]').disabled`), 'native browser owner sees scoped metadata controls')
    await cdp.evaluate(`document.querySelector('[aria-label="Rotate key ${input.keyId}"]').click()`)
    await waitFor(() => cdp.evaluate(`document.querySelector('#rotated-key')?.value.length === 64`), 15000, { label: 'Once-shown replacement key', intervalMs: 50 })
    const replacement = (await one('SELECT id FROM support_api_keys WHERE project_id = ? ORDER BY id DESC LIMIT 1', [input.projectId]))!
    check(await cdp.evaluate(`(async()=>{const key=document.querySelector('#rotated-key').value; const result=await fetch('/api/v1/projects/${input.project}/sessions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({externalId:'browser-rotated-key'})}); return result.status===200 && !JSON.stringify({...localStorage,...sessionStorage}).includes(key)})()`), 'replacement key works and is absent from browser persistence')
    const old = await fetch(input.api + `/api/v1/projects/${input.project}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${input.oldKey}` }, body: JSON.stringify({ externalId: 'browser-revoked-key' }) })
    check(old.status === 401, 'browser rotation revokes the old key for new native requests')
    await cdp.evaluate(`document.querySelector('[aria-label="Revoke key ${replacement.id}"]').click()`)
    await waitFor(() => cdp.evaluate(`!document.querySelector('[aria-label="Revoke key ${replacement.id}"]') && !document.querySelector('#rotated-key')`), 15000, { label: 'Browser revoke and secret cleanup', intervalMs: 50 })
    check(Number((await one('SELECT revoked_at FROM support_api_keys WHERE id = ?', [replacement.id]))!.revoked_at) > 0, 'browser revoke persists the native revocation')
    await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Generate a new key pair').click()`)
    await waitFor(() => cdp.evaluate(`document.querySelector('#write-key')?.value.length === 64 && document.querySelector('#read-key')?.value.length === 64`), 15000, { label: 'Native pair once-only browser display', intervalMs: 50 })
    const read = (await one("SELECT id FROM support_api_keys WHERE project_id = ? AND scope = 'read' AND revoked_at = 0 ORDER BY id DESC LIMIT 1", [input.projectId]))!
    dropNextRotation = true
    await cdp.evaluate(`document.querySelector('[aria-label="Rotate key ${read.id}"]').click()`)
    await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='Retry key operation')`), 15000, { label: 'Lost committed response recovery control', intervalMs: 50 })
    const lostReplacement = (await one('SELECT id FROM support_api_keys WHERE project_id = ? ORDER BY id DESC LIMIT 1', [input.projectId]))!
    await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Retry key operation').click()`)
    await waitFor(() => cdp.evaluate(`document.body.textContent.includes('This operation already completed.') && !Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='Retry key operation')`), 15000, { label: 'Metadata-only retry after lost response', intervalMs: 50 })
    check(await cdp.evaluate(`!document.querySelector('#rotated-key') && !document.querySelector('#write-key') && document.body.textContent.includes('Replacement #${lostReplacement.id} is active.')`), 'lost response retry reveals metadata and explicit recovery without replaying a secret')
    check(String((await one('SELECT id FROM support_api_keys WHERE project_id = ? ORDER BY id DESC LIMIT 1', [input.projectId]))!.id) === String(lostReplacement.id) && drops === 1, 'browser retry has no duplicate key issuance')
    await cdp.evaluate(`document.querySelector('[aria-label="Rotate key ${lostReplacement.id}"]').click()`)
    await waitFor(() => cdp.evaluate(`document.querySelector('#rotated-key')?.value.length === 64`), 15000, { label: 'Explicit recovery rotation', intervalMs: 50 })
    check(await cdp.evaluate(`document.querySelector('label[for="rotated-key"]').textContent.includes('read')`), 'explicit browser recovery retains the read scope')
    await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Hide key').click()`)
    await waitFor(() => cdp.evaluate(`!document.querySelector('#rotated-key')`), 5000, { label: 'Secret explicitly hidden', intervalMs: 50 })
    const artifacts = resolve(root, 'storage/framework/runtime/credential-browser')
    await mkdir(artifacts, { recursive: true })
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await Bun.write(resolve(artifacts, 'settings.png'), Buffer.from(screenshot.data, 'base64'))
    await navigate(cdp, origin + '/app/settings', { quietMs: 100, timeoutMs: 20000 })
    await waitFor(() => cdp.evaluate(`document.querySelector('[aria-label="Project API keys"] article') !== null`), 15000, { label: 'Credential page reload', intervalMs: 50 })
    check(await cdp.evaluate(`!document.querySelector('#rotated-key') && !document.querySelector('#write-key') && !document.body.textContent.includes('digest')`), 'page reload restores metadata without secrets or digests')
    assert.deepEqual(errors, [], 'No browser runtime errors')
    assert.deepEqual(failed, [], 'No unexpected failed browser requests')
    await Bun.write(resolve(artifacts, 'report.json'), JSON.stringify({ passed: true, browser: (await cdp.send('Browser.getVersion')).product, assertions, expectedLostResponses: drops }, null, 2))
    console.info(`PASS credential browser (${assertions.length} checks)`)
  }
  finally { host?.stop(true); await browser?.close(); await closeSharedBrowsers(); await rm(output, { recursive: true, force: true }) }
}
