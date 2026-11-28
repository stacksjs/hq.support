import assert from 'node:assert/strict'
import { click, launch, navigate, waitFor } from '@stacksjs/testing/browser'

const projectId = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const widgetRoot = "document.querySelector('[data-hq-support]')?.shadowRoot.querySelector('hq-support-messenger')?.shadowRoot"

export async function verifyHostedSiteMessenger(url: string, expectedProject?: string) {
  const site = new URL(url)
  const isLoopback = site.protocol === 'http:' && site.hostname === '127.0.0.1'
  assert.ok((site.protocol === 'https:' || isLoopback) && site.href === `${site.origin}/`, 'Provide a trusted homepage origin.')
  const request = (path: string, options?: RequestInit) => fetch(new URL(path, site), {
    ...options, redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  const configuration = await request('/api/support/site-messenger')
  assert.equal(configuration.status, 200, 'The public Messenger configuration must load.')
  const { project } = await configuration.json() as { project?: unknown }
  assert.ok(typeof project === 'string' && projectId.test(project), 'The homepage must have a configured Messenger project.')
  if (expectedProject !== undefined)
    assert.ok(project.toLowerCase() === expectedProject.trim().toLowerCase(), 'The deployed Messenger project must match the release configuration.')

  const widgetPath = `/api/widget/projects/${project}`
  const sessionUrl = new URL(`${widgetPath}/session`, site).href
  const browser = await launch({
    headless: true, shared: false, viewport: { width: 320, height: 568 },
    chromePath: process.env.CHROME_PATH, startTimeoutMs: 60_000, commandTimeoutMs: 20_000,
  })
  const cdp = browser.cdp
  const issued = new Set<string>()
  const finished = new Set<string>()
  let runtimeErrors = 0
  cdp.on('Runtime.exceptionThrown', () => { runtimeErrors++ })
  cdp.on('Network.responseReceived', ({ requestId, response }) => {
    if (response.url === sessionUrl && response.status === 201)
      issued.add(requestId)
  })
  cdp.on('Network.loadingFinished', ({ requestId }) => {
    if (issued.has(requestId)) finished.add(requestId)
  })

  try {
    await cdp.send('Network.enable')
    await cdp.send('Runtime.enable')
    assert.ok(await navigate(cdp, site.href), 'The homepage must load in Chromium.')
    assert.equal(await cdp.evaluate('location.origin'), site.origin, 'The homepage must stay on its canonical origin.')
    assert.equal(issued.size, 0, 'The homepage must leave the Messenger idle before opening.')
    await click(cdp, '#site-chat')
    await waitFor(() => cdp.evaluate(`(() => {
      const composer = ${widgetRoot}?.querySelector('#support-body')
      const panel = ${widgetRoot}?.querySelector('.messenger')?.getBoundingClientRect()
      const launcher = document.querySelector('#site-chat')
      return !!composer && !!panel && panel.width > 0 && panel.left >= 0 && panel.right <= innerWidth
        && panel.top >= 0 && panel.bottom <= innerHeight && launcher?.getAttribute('aria-expanded') === 'true'
    })()`), 15_000, { label: 'The deployed Messenger opens with a visible composer at 320 px' })
    assert.equal(issued.size, 1, 'Opening the Messenger must issue one guest session.')
    assert.equal(runtimeErrors, 0, 'The homepage and Messenger must open without browser exceptions.')
  }
  finally {
    try {
      const cleanup = await Promise.allSettled([...issued].map(async (requestId) => {
        await waitFor(() => finished.has(requestId), 5_000, { label: 'The guest session response finished' })
        const result = await cdp.send<{ body: string, base64Encoded: boolean }>('Network.getResponseBody', { requestId })
        let token: unknown
        try { token = JSON.parse(result.base64Encoded ? Buffer.from(result.body, 'base64').toString() : result.body).token }
        catch { throw new Error('The issued guest session response was invalid.') }
        assert.ok(typeof token === 'string' && /^[a-f\d]{64}$/.test(token), 'The guest session must return a revocable credential.')
        const headers = { origin: site.origin, authorization: `Bearer ${token}` }
        try {
          const history = await request(`${widgetPath}/conversations`, { headers })
          assert.equal(history.status, 200, 'The guest session must be usable.')
          const { conversations } = await history.json() as { conversations?: unknown }
          assert.ok(Array.isArray(conversations) && conversations.length === 0, 'The smoke session must have an empty conversation history.')
        }
        finally {
          const revoked = await request(`${widgetPath}/session/revoke`, { method: 'POST', headers })
          assert.equal(revoked.status, 200, 'Revoke the smoke session.')
          const denied = await request(`${widgetPath}/conversations`, { headers })
          assert.equal(denied.status, 401, 'The revoked smoke session must no longer have access.')
        }
      }))
      const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, 'The hosted Messenger session check failed.')
    }
    finally { await browser.close() }
  }
}

if (import.meta.main) {
  assert.ok(Bun.argv[2], 'Usage: bun scripts/verify-hosted-site-messenger.ts https://hq.support')
  await verifyHostedSiteMessenger(Bun.argv[2], process.env.SUPPORT_SITE_MESSENGER_PROJECT_ID)
  console.info('PASS the hosted homepage opened Messenger in Chromium, issued an empty guest session, and revoked it')
}
