import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { startBrowserSession, browserSessionCookie } from '@stacksjs/auth'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { generateStaticSite } from '@stacksjs/stx/ssg'
import { launch, navigate, waitFor, closeSharedBrowsers } from '@stacksjs/testing/browser'
import { insert, one } from '../../app/Support/database'

await overridesReady
if (config.database.queryLogging) config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports(); await route.importRoutes()
const api = await route.serve({ port: 0, hostname: '127.0.0.1' }), apiOrigin = `http://127.0.0.1:${api.port}`
const root = resolve(import.meta.dir, '../..'), output = await mkdtemp(resolve(tmpdir(), 'hq-support-team-browser-')), artifacts = resolve(root, 'storage/framework/runtime/team-browser')
let host: ReturnType<typeof Bun.serve> | undefined, browser: Awaited<ReturnType<typeof launch>> | undefined
let cookie = '', csrf = '', failSend = false, failList = false
const assertions: string[] = [], runtimeErrors: string[] = []
const check = (condition: unknown, message: string) => { assert.ok(condition, message); assertions.push(message) }
async function http(path: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(apiOrigin + '/api' + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json() as any }
}
async function account(name: string) {
  const email = `${name}@team-browser.example.test`, password = 'TeamBrowserFixture2026!'
  assert.equal((await http('/register', 'POST', { name, email, password, password_confirmation: password })).status, 200)
  const login = await http('/login', 'POST', { email, password }), token = login.data.access_token ?? login.data.token
  return { token, id: Number((await one('SELECT id FROM users WHERE email = ?', [email]))!.id) }
}
try {
  const seed = await fetch(apiOrigin + '/api/csrf-token'); csrf = (await seed.json() as any).token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  const owner = await account('owner'), agent = await account('agent')
  const workspace = (await http('/support/workspaces', 'POST', { name: 'Browser team' }, owner.token)).data.workspace
  await insert('support_memberships', { workspace_id: workspace.id, user_id: agent.id, email: 'agent@team-browser.example.test', role: 'agent', status: 'active' })
  const project = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Browser brand' }, owner.token)).data.project, prefix = `/support/projects/${project.public_id}`
  const keys = (await http(prefix + '/keys', 'POST', {}, owner.token)).data
  const team = (await http(`/support/workspaces/${workspace.id}/support-teams`, 'POST', { name: 'First responders' }, owner.token)).data.team
  await http(`/support/workspaces/${workspace.id}/support-teams/${team.id}/members`, 'POST', { userId: agent.id }, owner.token)
  await http(`/support/workspaces/${workspace.id}/routing-agents`, 'POST', { userId: agent.id, capacity: 2, availability: 'available' }, owner.token)
  const inbox = (await http(prefix + '/team-inboxes', 'POST', { teamId: Number(team.id), name: 'Customer care', isDefault: true }, owner.token)).data.inbox
  const conversations = []
  for (const name of ['First request', 'Second request', 'Waiting request']) { const result = await http(`/v1/projects/${project.public_id}/conversations`, 'POST', { externalId: 'browser-customer', subject: name, body: 'Please help me', idempotencyKey: name }, keys.ingestKey); assert.equal(result.status, 201); conversations.push(result.data.conversation) }
  async function browserCookie(name: string) { const login = await http('/login', 'POST', { email: `${name}@team-browser.example.test`, password: 'TeamBrowserFixture2026!' }); const session = await startBrowserSession(login.data.access_token ?? login.data.token); assert.ok(session); return browserSessionCookie(session!) }
  const ownerCookie = await browserCookie('owner'), agentCookie = await browserCookie('agent')
  const compiled = await generateStaticSite({ pagesDir: resolve(root, 'resources/views'), outputDir: output, publicDir: resolve(root, 'public'), partialsDir: resolve(root, 'resources/partials'), componentsDir: resolve(root, 'resources/components'), router: { enabled: false }, minify: false, cache: false, sitemap: false, robots: false })
  assert.equal(compiled.failedCount, 0)
  host = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/_fixture/')) return new Response(null, { status: 303, headers: { location: '/app/team-settings', 'set-cookie': url.pathname.endsWith('/agent') ? agentCookie : ownerCookie } })
    if (url.pathname.startsWith('/api/')) {
      if (failList && request.method === 'GET' && url.pathname.endsWith('/inbox')) { failList = false; return Response.json({ error: { message: 'Fixture inbox refresh failure. Reply draft kept.' } }, { status: 503 }) }
      if (failSend && request.method === 'POST' && url.pathname.endsWith('/messages')) { failSend = false; return Response.json({ error: { message: 'Fixture transport failure. Keep this reply draft.' } }, { status: 503 }) }
      const headers = new Headers(request.headers); headers.delete('host')
      const response = await fetch(new URL(url.pathname + url.search, apiOrigin), { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body })
      const outgoing = new Headers(response.headers); outgoing.delete('content-encoding'); outgoing.delete('content-length')
      return new Response(response.body, { status: response.status, headers: outgoing })
    }
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 })
    const path = url.pathname === '/app' ? '/app.html' : url.pathname === '/app/team-settings' ? '/app/team-settings.html' : url.pathname
    const file = resolve(output, '.' + decodeURIComponent(path))
    if (!file.startsWith(output + sep)) return new Response('Forbidden', { status: 403 })
    return await Bun.file(file).exists() ? new Response(Bun.file(file), { headers: path.endsWith('.html') ? { 'content-type': 'text/html', 'cache-control': 'no-store' } : {} }) : new Response('Not found', { status: 404 })
  } })
  const origin = host.url.origin
  browser = await launch({ headless: true, shared: false, chromePath: process.env.CHROME_PATH, startTimeoutMs: 60000, commandTimeoutMs: 20000 })
  const cdp = browser.cdp
  cdp.on('Runtime.exceptionThrown', event => runtimeErrors.push(String(event.exceptionDetails.exception?.description || event.exceptionDetails.text)))
  await cdp.intercept([{ urlPattern: '*' }], async (event, session) => { const url = new URL(event.request.url); if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/css' }], body: '' }); else await session.send('Fetch.continueRequest', { requestId: event.requestId }) })
  const evaluate = (expression: string) => cdp.evaluate(expression)
  const input = (selector: string, value: string) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  const click = (text: string) => evaluate(`Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()===${JSON.stringify(text)})?.click()`)
  async function selectConversation(subject: string) { await evaluate(`Array.from(document.querySelectorAll('.conversation-row strong')).find(el=>el.textContent.trim()===${JSON.stringify(subject)})?.closest('button').click()`); await waitFor(() => evaluate(`document.querySelector('.thread-heading h2')?.textContent === ${JSON.stringify(subject)} && !document.body.textContent.includes('Loading conversation...') && document.querySelector('#reply') !== null && document.querySelector('.resolve-button')?.disabled === false`), 15000, { label: `Open ${subject}` }) }
  const text = (value: string) => waitFor(() => evaluate(`document.body.textContent.includes(${JSON.stringify(value)})`), 15000, { label: value })
  await navigate(cdp, origin + '/app/team-settings', { quietMs: 100, timeoutMs: 20000 })
  await text('Sign in')
  check(await evaluate(`!document.querySelector('#new-team-name')`), 'signed-out compiled settings expose no management forms')
  await navigate(cdp, origin + '/_fixture/owner', { quietMs: 100, timeoutMs: 20000 })
  await waitFor(() => evaluate(`document.querySelector('#new-team-name') !== null && document.body.textContent.includes('First responders')`), 15000, { label: 'Owner routing settings' })
  await input('#new-team-name', 'Browser-created team'); await click('Create team'); await text('Support team created.')
  check(Boolean(await one('SELECT id FROM support_teams WHERE workspace_id = ? AND name = ?', [workspace.id, 'Browser-created team'])), 'owner creates real tenant-scoped team from compiled settings')
  await input('#team-member', String(owner.id)); await click('Add to team'); await text('Team member added.')
  check(Boolean(await one('SELECT id FROM support_team_members WHERE team_id = ? AND user_id = ? AND active = ?', [team.id, owner.id, true])), 'owner adds actual active native workspace member through the UI')
  await input('#new-inbox-name', 'Manual review'); await input('#new-inbox-team', String(team.id)); await input('#new-inbox-mode', 'manual'); await click('Create inbox'); await text('Team inbox created.')
  const manual = (await one('SELECT * FROM support_team_inboxes WHERE project_id = ? AND name = ?', [project.id, 'Manual review']))!
  check(manual && manual.assignment_mode === 'manual' && !manual.is_default, 'owner creates real manual project inbox through native compiled forms')
  const editManual = async (name: string) => { await evaluate(`Array.from(document.querySelectorAll('tr')).find(row=>row.querySelector('td')?.textContent === ${JSON.stringify(name)})?.querySelector('button').click()`); await waitFor(() => evaluate(`document.querySelector('#edit-inbox-active') !== null`), 15000, { label: 'Inbox edit form' }) }
  await editManual('Manual review'); await input('#edit-inbox-name', 'Manual review paused'); await evaluate(`document.querySelector('#edit-inbox-active').click()`); await click('Save inbox settings'); await text('Inbox settings saved.')
  check(!Boolean((await one('SELECT active FROM support_team_inboxes WHERE id = ?', [manual.id]))!.active), 'owner can deactivate an inbox without changing the active default')
  await editManual('Manual review paused'); await evaluate(`document.querySelector('#edit-inbox-active').click()`); await click('Save inbox settings'); await waitFor(async () => Boolean((await one('SELECT active FROM support_team_inboxes WHERE id = ?', [manual.id]))!.active), 15000, { label: 'Inbox reactivated' })
  check(Boolean((await one('SELECT is_default FROM support_team_inboxes WHERE id = ?', [inbox.id]))!.is_default), 'inactive inbox recovery preserves the other project default')
  const emptyTeam = (await one('SELECT id FROM support_teams WHERE workspace_id = ? AND name = ?', [workspace.id, 'Browser-created team']))!
  await input('#support-team', String(emptyTeam.id)); await click('Disable team and release assignments'); await text('Team disabled.')
  check(!Boolean((await one('SELECT active FROM support_teams WHERE id = ?', [emptyTeam.id]))!.active), 'owner deactivates an empty team through the actual native action')
  await click('Reactivate team'); await text('Team reactivated.')
  check(Boolean((await one('SELECT active FROM support_teams WHERE id = ?', [emptyTeam.id]))!.active), 'inactive team has an actionable reactivation path')
  await mkdir(artifacts, { recursive: true }); const settingsImage = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); await Bun.write(resolve(artifacts, 'team-settings.png'), Buffer.from(settingsImage.data, 'base64'))
  // Remove the owner again so later capacity behavior has one eligible agent.
  await http(`/support/workspaces/${workspace.id}/support-teams/${team.id}/members`, 'POST', { userId: owner.id, active: false }, owner.token)
  await navigate(cdp, origin + '/app', { quietMs: 100, timeoutMs: 20000 }); await text('Waiting request')
  await input('#team-inbox', String(inbox.id)); await waitFor(() => evaluate(`document.querySelectorAll('.conversation-row').length === 3`), 15000, { label: 'Scoped inbox filter' })
  await selectConversation('Waiting request'); await waitFor(() => evaluate(`document.querySelector('#reply') !== null`), 15000, { label: 'Selected conversation' })
  await text('No available team member has capacity.')
  await input('#reply', 'Unsent draft retained on refresh')
  await evaluate(`document.querySelector('[aria-label="Refresh inbox"]').click()`); await waitFor(() => evaluate(`document.querySelector('[aria-label="Refresh inbox"]').disabled === false`), 15000, { label: 'Inbox refresh complete' })
  check(await evaluate(`document.querySelector('#reply').value === 'Unsent draft retained on refresh'`), 'inbox refresh preserves selected conversation and reply draft')
  failList = true; await evaluate(`document.querySelector('[aria-label="Refresh inbox"]').click()`); await text('Fixture inbox refresh failure.')
  check(await evaluate(`document.querySelector('#reply').value === 'Unsent draft retained on refresh' && document.querySelector('.thread-heading h2').textContent === 'Waiting request'`), 'failed inbox refresh preserves private draft and selected context')
  await evaluate(`document.querySelector('[aria-label="Refresh inbox"]').click()`); await waitFor(() => evaluate(`document.querySelector('[aria-label="Refresh inbox"]').disabled === false && !document.body.textContent.includes('Fixture inbox refresh failure.')`), 15000, { label: 'Refresh retry recovers' })

  const auditBeforeRetry = Number((await one('SELECT COUNT(*) AS count FROM support_assignment_audits WHERE conversation_id = ?', [conversations[2].id]))!.count)
  await click('Retry automatic routing'); await waitFor(async () => Number((await one('SELECT COUNT(*) AS count FROM support_assignment_audits WHERE conversation_id = ?', [conversations[2].id]))!.count) > auditBeforeRetry, 15000, { label: 'Overflow retry persisted' }); await waitFor(() => evaluate(`document.querySelector('.routing-panel button[type="submit"]').disabled === false`), 15000, { label: 'Routing operation complete' }); await text('This conversation remains unassigned')
  check(Number((await one('SELECT assignee_id FROM support_conversations WHERE id = ?', [conversations[2].id]))!.assignee_id) === 0 && await evaluate(`document.querySelector('#reply').value === 'Unsent draft retained on refresh'`), 'honest overflow retry preserves draft and does not over-admit')
  failSend = true; await click('Send reply'); await text('Fixture transport failure.')
  check(await evaluate(`document.querySelector('#reply').value === 'Unsent draft retained on refresh'`), 'failed native HTTP send retains the unsent draft')
  await selectConversation('Second request'); await input('#reply-mode', 'internal'); await input('#reply', 'Private unsent note on the second thread'); await selectConversation('Waiting request')
  check(await evaluate(`document.querySelector('#reply').value === 'Unsent draft retained on refresh' && document.querySelector('#reply-mode').value === 'public'`), 'switching threads restores the correct failed reply and its visibility')
  await selectConversation('Second request')
  check(await evaluate(`document.querySelector('#reply').value === 'Private unsent note on the second thread' && document.querySelector('#reply-mode').value === 'internal'`), 'private note drafts remain isolated per conversation')
  await selectConversation('Waiting request')
  await input('#reply', 'Edited reply after failed transport'); await click('Send reply'); await text('Reply saved.')
  check(Boolean(await one('SELECT id FROM support_messages WHERE conversation_id = ? AND body = ?', [conversations[2].id, 'Edited reply after failed transport'])), 'edited retry uses a fresh payload key and persists exactly the intended reply')
  await selectConversation('First request'); await waitFor(() => evaluate(`document.querySelector('.thread-heading h2').textContent === 'First request'`), 15000, { label: 'First assigned conversation' }); await click('Resolve'); await text('Conversation resolved.')
  await selectConversation('Waiting request'); await text('No available team member has capacity.')
  await click('Retry automatic routing'); await text('Assigned by round robin.')
  check(Number((await one('SELECT assignee_id FROM support_conversations WHERE id = ?', [conversations[2].id]))!.assignee_id) === agent.id, 'owner retries retained overflow after a real status transition releases capacity')
  await evaluate(`document.querySelector('.routing-panel details').open=true`); await text('Manual change')
  check(await evaluate(`document.querySelectorAll('.assignment-entry').length > 1`), 'compiled inbox displays persisted assignment provenance')
  await mkdir(artifacts, { recursive: true }); const image = await cdp.send('Page.captureScreenshot', { format: 'png' }); await Bun.write(resolve(artifacts, 'inbox.png'), Buffer.from(image.data, 'base64'))
  await navigate(cdp, origin + '/_fixture/agent', { quietMs: 100, timeoutMs: 20000 }); await waitFor(() => evaluate(`document.querySelector('#routing-availability') !== null`), 15000, { label: 'Agent settings' })
  check(await evaluate(`!document.querySelector('#new-team-name') && document.querySelector('#routing-capacity').disabled && document.querySelector('#routing-agent').disabled`), 'agent UI exposes scoped read settings and own availability only')
  await input('#routing-availability', 'away'); await click('Save routing preferences'); await text('Routing preferences saved.')
  check((await one('SELECT availability FROM support_routing_agents WHERE workspace_id = ? AND user_id = ?', [workspace.id, agent.id]))!.availability === 'away', 'agent saves actual own availability without capacity mutation')
  await input('#routing-availability', 'available'); await click('Save routing preferences'); await waitFor(async () => (await one('SELECT availability FROM support_routing_agents WHERE workspace_id = ? AND user_id = ?', [workspace.id, agent.id]))!.availability === 'available', 15000, { label: 'Agent available again' }); await text('Routing preferences saved.')
  await navigate(cdp, origin + '/app', { quietMs: 100, timeoutMs: 20000 }); await text('Waiting request'); await selectConversation('Waiting request'); await text('Assigned by round robin.')
  check(await evaluate(`!document.querySelector('#assignment-agent') && document.body.textContent.includes('Release my assignment')`), 'agent cannot render owner assignment controls and can release their own work')
  await click('Release my assignment'); await text('Unassigned.'); await click('Claim for myself'); await text('Manually assigned.')
  check(Number((await one('SELECT assignee_id FROM support_conversations WHERE id = ?', [conversations[2].id]))!.assignee_id) === agent.id, 'agent release and claim use native authorized routing mutations')
  console.info(`PASS team UI functional (${assertions.length} checks)`)
  await Bun.write(resolve(artifacts, 'report.json'), JSON.stringify({ passed: runtimeErrors.length === 0, functionalPassed: true, assertions, runtimeErrors, browser: (await cdp.send('Browser.getVersion')).product }, null, 2))
  assert.deepEqual(runtimeErrors, [], 'No browser runtime errors: retain this gate until the native compiler fix is published')
  console.info('PASS team browser qualification')
}
finally {
  if (browser) {
    await mkdir(artifacts, { recursive: true })
    const captured = await Promise.allSettled([browser.cdp.evaluate('document.body.textContent'), browser.cdp.send('Page.captureScreenshot', { format: 'png' })])
    await Bun.write(resolve(artifacts, 'diagnostic.json'), JSON.stringify({ assertions, runtimeErrors, body: captured[0].status === 'fulfilled' ? captured[0].value : 'Browser closed' }, null, 2))
    if (captured[1].status === 'fulfilled') await Bun.write(resolve(artifacts, 'latest.png'), Buffer.from(captured[1].value.data, 'base64'))
  }
  host?.stop(true); api.stop(true); await browser?.close(); await closeSharedBrowsers(); await rm(output, { recursive: true, force: true })
}
process.exit(0)
