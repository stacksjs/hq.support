import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { startBrowserSession, browserSessionCookie } from '@stacksjs/auth'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { runJob } from '@stacksjs/queue'
import NativeSessionAction from '@stacksjs/defaults/app/Actions/Support/SessionAction.ts'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { generateStaticSite } from '@stacksjs/stx/ssg'
import { launch, navigate, waitFor, closeSharedBrowsers } from '@stacksjs/testing/browser'
import { insert, one, query } from '../../app/Support/database'

await overridesReady
if (config.database.queryLogging) config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports(); await route.importRoutes()
route.post('/api/_native/support/session', NativeSessionAction).middleware('auth')
const api = await route.serve({ port: 0, hostname: '127.0.0.1' }), apiOrigin = `http://127.0.0.1:${api.port}`
const root = resolve(import.meta.dir, '../..'), output = await mkdtemp(resolve(tmpdir(), 'hq-support-team-browser-')), artifacts = resolve(root, 'storage/framework/runtime/team-browser')
let host: ReturnType<typeof Bun.serve> | undefined, browser: Awaited<ReturnType<typeof launch>> | undefined, peer: Awaited<ReturnType<typeof launch>> | undefined
let cookie = '', csrf = '', peerCookie = '', migrationCookie = '', failSend = false, failList = false, simulatePeerDisconnect = false
let agentStreams = 0, agentSnapshots = 0, finiteAgentReads = 0, suppressReplayHints = false, suppressedReplayHints = 0
let failAgentReplay = false, refusedAgentReplay = 0
let retentionGate: { path: string, entered: ReturnType<typeof Promise.withResolvers<void>>, release: ReturnType<typeof Promise.withResolvers<void>> } | undefined
let incompleteRetentionPath: string | undefined
let inconsistentMigrationTotals = false
let migrationGate: { entered: ReturnType<typeof Promise.withResolvers<void>>, release: ReturnType<typeof Promise.withResolvers<void>> } | undefined
let savedReplyGate: { entered: ReturnType<typeof Promise.withResolvers<void>>, release: ReturnType<typeof Promise.withResolvers<void>> } | undefined
const presenceTiming: Record<string, number> = {}
const assertions: string[] = [], runtimeErrors: string[] = []
const searchTraffic: Array<{ q: string | null, inboxId: string | null, status: string | null, cursor: string | null, limit: string | null, path: string }> = []
let searchGate: { query: string, used: boolean, entered: ReturnType<typeof Promise.withResolvers<void>>, release: ReturnType<typeof Promise.withResolvers<void>> } | undefined
function holdSearch(query: string) { searchGate = { query, used: false, entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }; return searchGate }
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
  const owner = await account('owner'), agent = await account('agent'), admin = await account('admin')
  const workspace = (await http('/support/workspaces', 'POST', { name: 'Browser team' }, owner.token)).data.workspace
  await insert('support_memberships', { workspace_id: workspace.id, user_id: agent.id, email: 'agent@team-browser.example.test', role: 'agent', status: 'active' })
  await insert('support_memberships', { workspace_id: workspace.id, user_id: admin.id, email: 'admin@team-browser.example.test', role: 'admin', status: 'active' })
  const project = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Browser brand' }, owner.token)).data.project, prefix = `/support/projects/${project.public_id}`
  const keys = (await http(prefix + '/keys', 'POST', {}, owner.token)).data
  const team = (await http(`/support/workspaces/${workspace.id}/support-teams`, 'POST', { name: 'First responders' }, owner.token)).data.team
  await http(`/support/workspaces/${workspace.id}/support-teams/${team.id}/members`, 'POST', { userId: agent.id }, owner.token)
  await http(`/support/workspaces/${workspace.id}/routing-agents`, 'POST', { userId: agent.id, capacity: 2, availability: 'available' }, owner.token)
  const inbox = (await http(prefix + '/team-inboxes', 'POST', { teamId: Number(team.id), name: 'Customer care', isDefault: true }, owner.token)).data.inbox
  const conversations = []
  for (const name of ['First request', 'Second request', 'Waiting request']) { const result = await http(`/v1/projects/${project.public_id}/conversations`, 'POST', { externalId: 'browser-customer', subject: name, body: 'Please help me', idempotencyKey: name }, keys.ingestKey); assert.equal(result.status, 201); conversations.push(result.data.conversation) }
  const retentionPath = (id: string) => `/support/workspaces/${workspace.id}/enterprise/retention/conversations/${id}`
  await insert('support_enterprise_retention_policies', { workspace_id: workspace.id, days: 30, enabled: true, last_run_at: 0 })
  await insert('support_enterprise_retention_holds', { workspace_id: workspace.id, conversation_id: conversations[2].id, active: true, reason: 'Protected fixture hold reason' })
  const audit = await insert('support_enterprise_audit_events', { workspace_id: workspace.id, actor_id: owner.id, action: 'retention.conversation.redacted', target_id: String(conversations[2].id), detail: '{}' })
  async function browserCookie(name: string) { const login = await http('/login', 'POST', { email: `${name}@team-browser.example.test`, password: 'TeamBrowserFixture2026!' }); const session = await startBrowserSession(login.data.access_token ?? login.data.token); assert.ok(session); return browserSessionCookie(session!) }
  const ownerCookie = await browserCookie('owner'), agentCookie = await browserCookie('agent'), adminCookie = await browserCookie('admin')
  const compiled = await generateStaticSite({ pagesDir: resolve(root, 'resources/views'), outputDir: output, publicDir: resolve(root, 'public'), partialsDir: resolve(root, 'resources/partials'), componentsDir: resolve(root, 'resources/components'), router: { enabled: false }, minify: false, cache: false, sitemap: false, robots: false })
  assert.equal(compiled.failedCount, 0)
  host = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/realtime/stream')) server.timeout(request, 0)
    if (url.pathname.startsWith('/_fixture/')) return new Response(null, { status: 303, headers: { location: '/app/team-settings', 'set-cookie': url.pathname.endsWith('/migration') ? migrationCookie : url.pathname.endsWith('/peer') ? peerCookie : url.pathname.endsWith('/agent') ? agentCookie : url.pathname.endsWith('/admin') ? adminCookie : ownerCookie } })
    if (url.pathname === '/case-fixture') return new Response('<!doctype html><html lang="en"><head><title>Support case fixture</title></head><body></body></html>', { headers: { 'content-type': 'text/html' } })
    if (url.pathname.startsWith('/api/')) {
      if (failAgentReplay && url.pathname.startsWith('/api/support/projects/') && url.pathname.includes('/realtime/')) {
        refusedAgentReplay++
        return Response.json({ error: { code: 'realtime_unavailable' } }, { status: 503 })
      }
      if (simulatePeerDisconnect && request.method === 'POST' && url.pathname.endsWith('/presence')) {
        const payload = await request.clone().json() as { state: string }
        if (payload.state === 'away') return Response.json({ viewers: [] })
      }
      if (failList && request.method === 'GET' && url.pathname.endsWith('/inbox')) { failList = false; return Response.json({ error: { message: 'Fixture inbox refresh failure. Reply draft kept.' } }, { status: 503 }) }
      if (failSend && request.method === 'POST' && url.pathname.endsWith('/messages')) { failSend = false; return Response.json({ error: { message: 'Fixture transport failure. Keep this reply draft.' } }, { status: 503 }) }
      if (request.method === 'GET' && url.pathname.endsWith('/inbox')) searchTraffic.push({ q: url.searchParams.get('q'), inboxId: url.searchParams.get('inboxId'), status: url.searchParams.get('status'), cursor: url.searchParams.get('cursor'), limit: url.searchParams.get('limit'), path: url.pathname })
      const headers = new Headers(request.headers); headers.delete('host')
      const response = await fetch(new URL(url.pathname + url.search, apiOrigin), { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body })
      if (response.ok && request.method === 'GET' && url.pathname === incompleteRetentionPath) {
        incompleteRetentionPath = undefined
        const evidence = await response.json() as { content: { messageBodies?: number } }
        delete evidence.content.messageBodies
        return Response.json(evidence)
      }
      if (inconsistentMigrationTotals && response.ok && request.method === 'POST' && url.pathname.endsWith('/imports/intercom')) {
        inconsistentMigrationTotals = false
        const report = await response.json() as { compatibleRecords: number, reviewRecords: number }
        report.compatibleRecords++
        report.reviewRecords--
        return Response.json(report)
      }
      const heldMigration = migrationGate
      if (heldMigration && request.method === 'POST' && url.pathname.endsWith('/imports/intercom')) {
        heldMigration.entered.resolve()
        await heldMigration.release.promise
      }
      const heldSavedReplies = savedReplyGate
      if (heldSavedReplies && request.method === 'GET' && url.pathname.endsWith('/saved-replies')) {
        heldSavedReplies.entered.resolve()
        await heldSavedReplies.release.promise
      }
      const heldRetention = retentionGate
      if (heldRetention && request.method === 'GET' && url.pathname === heldRetention.path) {
        heldRetention.entered.resolve()
        await heldRetention.release.promise
      }
      const held = searchGate
      if (request.method === 'GET' && url.pathname.endsWith('/inbox') && held && !held.used && held.query === url.searchParams.get('q')) { held.used = true; held.entered.resolve(); await held.release.promise }
      const outgoing = new Headers(response.headers); outgoing.delete('content-encoding'); outgoing.delete('content-length')
      let body = response.body
      if (response.ok && url.pathname.startsWith('/api/support/projects/') && url.pathname.endsWith('/realtime/replay')) finiteAgentReads++
      if (response.ok && url.pathname.startsWith('/api/support/projects/') && url.pathname.endsWith('/realtime/snapshot')) agentSnapshots++
      if (response.ok && body && url.pathname.startsWith('/api/support/projects/') && url.pathname.endsWith('/realtime/stream')) {
        agentStreams++
        body = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            if (suppressReplayHints && /invalidated|"event":"changed"/.test(new TextDecoder().decode(chunk))) suppressedReplayHints++
            else controller.enqueue(chunk)
          },
        }))
      }
      return new Response(body, { status: response.status, headers: outgoing })
    }
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 })
    const path = ['/app', '/app/settings', '/app/team-settings', '/app/reports', '/app/ticket-settings', '/app/usage', '/login'].includes(url.pathname) ? `${url.pathname}.html` : url.pathname
    const file = resolve(output, '.' + decodeURIComponent(path))
    if (!file.startsWith(output + sep)) return new Response('Forbidden', { status: 403 })
    return await Bun.file(file).exists() ? new Response(Bun.file(file), { headers: path.endsWith('.html') ? { 'content-type': 'text/html', 'cache-control': 'no-store' } : {} }) : new Response('Not found', { status: 404 })
  } })
  const origin = host.url.origin
  config.app.url = origin
  browser = await launch({ headless: true, shared: false, chromePath: process.env.CHROME_PATH, startTimeoutMs: 60000, commandTimeoutMs: 20000 })
  const cdp = browser.cdp
  cdp.on('Runtime.exceptionThrown', event => runtimeErrors.push(String(event.exceptionDetails.exception?.description || event.exceptionDetails.text)))
  await cdp.intercept([{ urlPattern: '*' }], async (event, session) => { const url = new URL(event.request.url); if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/css' }], body: '' }); else await session.send('Fetch.continueRequest', { requestId: event.requestId }) })
  const evaluate = (expression: string) => cdp.evaluate(expression)
  const input = (selector: string, value: string) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  const click = (text: string) => evaluate(`Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()===${JSON.stringify(text)})?.click()`)
  async function selectConversation(subject: string) { await evaluate(`Array.from(document.querySelectorAll('.conversation-row strong')).find(el=>el.textContent.trim()===${JSON.stringify(subject)})?.closest('button').click()`); await waitFor(() => evaluate(`document.querySelector('.thread-heading h2')?.textContent === ${JSON.stringify(subject)} && !document.body.textContent.includes('Loading conversation...') && document.querySelector('#reply') !== null && document.querySelector('.resolve-button')?.disabled === false`), 15000, { label: `Open ${subject}` }) }
  const text = (value: string) => waitFor(() => evaluate(`document.body.textContent.includes(${JSON.stringify(value)})`), 15000, { label: value })
  function readEvidence(id: string) {
    return waitFor(() => evaluate(`document.querySelector('#retention-evidence-result code')?.textContent === ${JSON.stringify(String(id))}`), 15000, { label: 'Selected case evidence' })
  }
  await navigate(cdp, origin + '/app/team-settings', { quietMs: 100, timeoutMs: 20000 })
  await text('Sign in')
  check(await evaluate(`!document.querySelector('#new-team-name')`), 'signed-out compiled settings expose no management forms')
  await navigate(cdp, origin + '/_fixture/admin', { quietMs: 100, timeoutMs: 20000 })
  await navigate(cdp, origin + '/app', { quietMs: 100, timeoutMs: 20000 })
  await text('Waiting request'); await selectConversation('Waiting request')
  await click('Read case evidence'); await readEvidence(conversations[2].id)
  check(await evaluate(`document.querySelector('#retention-evidence-result dl')?.textContent.includes('30 days · Enabled')`), 'admin reads protected case evidence on the compiled inbox')
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
  await click('Read case evidence'); await readEvidence(conversations[2].id)
  check(await evaluate(`Array.from(document.querySelectorAll('#retention-evidence-result code')).at(-1).textContent === ${JSON.stringify(String(audit.id))} && !document.querySelector('#retention-evidence-result').textContent.includes('Protected fixture hold reason')`), 'owner sees the audit reference without the hold reason')
  await evaluate(`document.querySelector('.case-retention').scrollIntoView({ block: 'start' })`)
  const desktopRetention = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await Bun.write(resolve(artifacts, 'desktop-retention.png'), Buffer.from(desktopRetention.data, 'base64'))
  await input('#inbox-language', 'de'); await text('Aufbewahrungsnachweis')
  await input('#inbox-language', 'ar'); await text('أدلة الاحتفاظ')
  await input('#inbox-language', 'en'); await text('Retention evidence')
  incompleteRetentionPath = '/api' + retentionPath(conversations[2].id)
  await click('Refresh case evidence'); await text('Could not read case evidence. Try again.')
  check(await evaluate(`!document.querySelector('#retention-evidence-result dl')`), 'missing counts show retry feedback without displaying incomplete evidence')
  await click('Read case evidence'); await readEvidence(conversations[2].id)
  const gate = { path: '/api' + retentionPath(conversations[2].id), entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
  retentionGate = gate
  try {
    await click('Refresh case evidence')
    await Promise.race([gate.entered.promise, Bun.sleep(10000).then(() => { throw new Error('Evidence request did not reach the fixture') })])
    await selectConversation('First request')
    await click('Read case evidence'); await readEvidence(conversations[0].id)
  }
  finally { retentionGate = undefined; gate.release.resolve() }
  await readEvidence(conversations[0].id)
  await selectConversation('Waiting request')
  check(await evaluate(`!document.querySelector('#retention-evidence-result dl')`), 'changing conversation clears the previous evidence and invalidates an in-flight read')
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
  await runJob('DrainInboxOverflow')
  await selectConversation('Waiting request')
  await evaluate(`document.querySelector('.routing-panel details').open=true`); await text('Automatic overflow assignment')
  check(Number((await one('SELECT assignee_id FROM support_conversations WHERE id = ?', [conversations[2].id]))!.assignee_id) === agent.id, 'scheduled routing moves waiting work after a real status transition releases capacity')
  check(await evaluate(`document.querySelectorAll('.assignment-entry').length > 1`), 'compiled inbox displays persisted assignment provenance')
  await input('#reply', 'Draft retained through rejected assignment and narrow drawer')
  const assignmentBeforeFailure = JSON.stringify(await one('SELECT assignee_id, inbox_id, status FROM support_conversations WHERE id = ?', [conversations[2].id]))
  await http(`/support/workspaces/${workspace.id}/routing-agents`, 'POST', { userId: agent.id, availability: 'offline' }, owner.token)
  await click('Save assignment'); await text('The requested agent is inactive, unavailable, outside the team or at capacity.')
  check(await evaluate(`!document.querySelector('.routing-error').textContent.includes('reopened') && !document.querySelector('.routing-error').textContent.includes('unassigned') && document.querySelector('#reply').value === 'Draft retained through rejected assignment and narrow drawer'`) && JSON.stringify(await one('SELECT assignee_id, inbox_id, status FROM support_conversations WHERE id = ?', [conversations[2].id])) === assignmentBeforeFailure, 'actual rejected assignment shows backend error without inventing a reopen, unassignment or clearing the draft')
  await http(`/support/workspaces/${workspace.id}/routing-agents`, 'POST', { userId: agent.id, availability: 'available' }, owner.token)
  async function resize(width: number, height: number) { await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 760 }); await waitFor(() => evaluate(`getComputedStyle(document.querySelector('#customer-details')).display === 'none'`), 5000, { label: 'Narrow panel initially closed' }) }
  async function openPanel(keyboard = false) {
    await evaluate(`document.querySelector('[aria-label="Toggle customer details"]').focus()`)
    if (keyboard) { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }) }
    else await evaluate(`document.querySelector('[aria-label="Toggle customer details"]').click()`)
    await waitFor(() => evaluate(`getComputedStyle(document.querySelector('#customer-details')).display !== 'none' && document.activeElement.id === 'customer-details-close'`), 5000, { label: 'Drawer opens with close-button focus' })
  }
  async function panelClosed() { await waitFor(() => evaluate(`getComputedStyle(document.querySelector('#customer-details')).display === 'none' && document.activeElement === document.querySelector('[aria-label="Toggle customer details"]') && !document.querySelector('.conversation-pane').inert`), 5000, { label: 'Drawer closes and restores trigger focus' }) }
  await resize(1024, 800); await openPanel()
  check(await evaluate(`document.querySelector('#customer-details').getAttribute('role') === 'dialog' && document.querySelector('.conversation-pane').inert && document.querySelector('#assignment-agent') !== null`), 'tablet drawer exposes real assignment controls and makes the conversation behind it inert')
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  check(await evaluate(`document.querySelector('#customer-details').contains(document.activeElement) && document.activeElement.id !== 'customer-details-close'`), 'Shift-Tab wraps focus within the open assignment drawer')
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  check(await evaluate(`document.activeElement.id === 'customer-details-close'`), 'Tab wraps back to the drawer close button')
  await input('#assignment-agent', '0'); await click('Save assignment'); await waitFor(async () => Number((await one('SELECT assignee_id FROM support_conversations WHERE id = ?', [conversations[2].id]))!.assignee_id) === 0, 10000, { label: 'Tablet unassignment persisted' }); await waitFor(() => evaluate(`document.querySelector('.routing-panel button[type="submit"]').disabled === false`), 10000, { label: 'Tablet routing completed' })
  await input('#assignment-agent', String(agent.id)); await click('Save assignment'); await waitFor(async () => Number((await one('SELECT assignee_id FROM support_conversations WHERE id = ?', [conversations[2].id]))!.assignee_id) === agent.id, 10000, { label: 'Tablet assignment persisted' })
  check(await evaluate(`document.querySelector('#reply').value === 'Draft retained through rejected assignment and narrow drawer'`), 'tablet assignment uses actual native admission without clearing the private reply draft')
  await evaluate(`document.querySelector('.customer-backdrop').click()`); await panelClosed()
  check(true, 'tablet backdrop closes the drawer and returns focus to its trigger')
  await resize(375, 812); await openPanel(true)
  await click('Read case evidence'); await readEvidence(conversations[2].id)
  await evaluate(`document.querySelector('.case-retention').scrollIntoView({ block: 'start' })`)
  const retentionImage = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await Bun.write(resolve(artifacts, 'phone-retention.png'), Buffer.from(retentionImage.data, 'base64'))
  check(await evaluate(`document.querySelector('#customer-details').getBoundingClientRect().width <= 375 && document.querySelector('.conversation-pane').inert`), '375px phone opens the assignment drawer by keyboard within the viewport')
  const narrowImage = await cdp.send('Page.captureScreenshot', { format: 'png' }); await mkdir(artifacts, { recursive: true }); await Bun.write(resolve(artifacts, 'phone-drawer.png'), Buffer.from(narrowImage.data, 'base64'))
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await panelClosed()
  check(await evaluate(`document.querySelector('#reply').value === 'Draft retained through rejected assignment and narrow drawer'`), 'phone Escape restores focus and preserves the draft')
  await mkdir(artifacts, { recursive: true }); const image = await cdp.send('Page.captureScreenshot', { format: 'png' }); await Bun.write(resolve(artifacts, 'inbox.png'), Buffer.from(image.data, 'base64'))
  await navigate(cdp, origin + '/_fixture/agent', { quietMs: 100, timeoutMs: 20000 }); await waitFor(() => evaluate(`document.querySelector('#routing-availability') !== null`), 15000, { label: 'Agent settings' })
  check(await evaluate(`!document.querySelector('#new-team-name') && document.querySelector('#routing-capacity').disabled && document.querySelector('#routing-agent').disabled`), 'agent UI exposes scoped read settings and own availability only')
  await input('#routing-availability', 'away'); await click('Save routing preferences'); await text('Routing preferences saved.')
  check((await one('SELECT availability FROM support_routing_agents WHERE workspace_id = ? AND user_id = ?', [workspace.id, agent.id]))!.availability === 'away', 'agent saves actual own availability without capacity mutation')
  await input('#routing-availability', 'available'); await click('Save routing preferences'); await waitFor(async () => (await one('SELECT availability FROM support_routing_agents WHERE workspace_id = ? AND user_id = ?', [workspace.id, agent.id]))!.availability === 'available', 15000, { label: 'Agent available again' }); await text('Routing preferences saved.')
  await navigate(cdp, origin + '/app', { quietMs: 100, timeoutMs: 20000 }); await text('Waiting request'); await selectConversation('Waiting request'); await text('Assigned by round robin.')
  await openPanel(true)
  check(await evaluate(`!document.querySelector('#assignment-agent') && document.body.textContent.includes('Release my assignment')`), 'agent cannot render owner assignment controls and can release their own work')
  check(await evaluate(`!document.querySelector('#read-retention-evidence')`), 'agent cannot open case evidence in the inbox')
  check((await http(retentionPath(conversations[2].id), 'GET', undefined, agent.token)).status === 403, 'native API refuses a direct agent evidence request')
  await click('Release my assignment'); await waitFor(async () => Number((await one('SELECT assignee_id FROM support_conversations WHERE id = ?', [conversations[2].id]))!.assignee_id) === 0 && await evaluate(`Array.from(document.querySelectorAll('.routing-panel button')).some(button=>button.textContent.trim()==='Claim for myself' && !button.disabled)`), 10000, { label: 'Phone release completed' })
  await click('Claim for myself'); await waitFor(async () => Number((await one('SELECT assignee_id FROM support_conversations WHERE id = ?', [conversations[2].id]))!.assignee_id) === agent.id, 10000, { label: 'Phone claim persisted' })
  check(Number((await one('SELECT assignee_id FROM support_conversations WHERE id = ?', [conversations[2].id]))!.assignee_id) === agent.id, 'agent release and claim use native authorized routing mutations')
  await evaluate(`document.querySelector('#customer-details-close').click()`); await panelClosed(); check(true, 'phone close button restores focus after an actual agent release and claim')
  // Persisted history is created through real native HTTP, not browser response mocks.
  const archive = (await http(prefix + '/team-inboxes', 'POST', { teamId: Number(team.id), name: 'Archive search', assignmentMode: 'manual' }, owner.token)).data.inbox
  async function archived(subject: string, body: string, box = Number(archive.id), status = 'open') {
    const created = await http(`/v1/projects/${project.public_id}/conversations`, 'POST', { externalId: 'archive-customer', subject, body, idempotencyKey: `search-${subject}` }, keys.ingestKey)
    assert.equal(created.status, 201)
    assert.equal((await http(prefix + `/conversations/${created.data.conversation.id}/routing`, 'POST', { inboxId: box, assigneeId: 0, status }, owner.token)).status, 200)
    return created.data.conversation
  }
  const oldBody = await archived('Archive case 000', 'nebularoute archivedsecretneedle only exists in the old message body')
  for (let index = 1; index < 55; index++) await archived(`Archive case ${String(index).padStart(3, '0')}`, 'Historical message about nebularoute')
  const otherBox = await archived('Matching other inbox', 'nebularoute', Number(inbox.id))
  const closedMatch = await archived('Matching resolved case', 'nebularoute', Number(archive.id), 'closed')
  await archived('No transcript match', 'A different topic entirely')
  await archived('Late result must stay hidden', 'stalequerytoken projectstaletoken logoutstaletoken')
  const sibling = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Sibling search brand' }, owner.token)).data.project
  const siblingKeys = (await http(`/support/projects/${sibling.public_id}/keys`, 'POST', {}, owner.token)).data
  const siblingRecord = (await http(`/v1/projects/${sibling.public_id}/conversations`, 'POST', { externalId: 'sibling-customer', subject: 'Sibling-only request', body: 'archivedsecretneedle', idempotencyKey: 'sibling-search' }, siblingKeys.ingestKey)).data.conversation
  await navigate(cdp, origin + '/app', { quietMs: 100, timeoutMs: 20000 }); await waitFor(() => evaluate(`document.querySelectorAll('.conversation-row').length === 50`), 15000, { label: 'Initial native fifty-conversation page' })
  check(!await evaluate(`document.body.textContent.includes('Archive case 000')`), 'historical body-only target is outside the initial fifty loaded conversations')
  const searchInput = '[aria-label="Search subjects and messages"]'
  const beforeShort = searchTraffic.length
  await input(searchInput, 'n'); await text('Enter at least 2 characters'); await Bun.sleep(400)
  check(searchTraffic.length === beforeShort && await evaluate(`document.querySelectorAll('.conversation-row').length === 0`), 'one-character input shows validation without querying or silently falling back to all conversations')
  await input(searchInput, 'archivedsecretneedle'); await waitFor(() => evaluate(`document.querySelectorAll('.conversation-row').length === 1 && document.querySelector('.conversation-row strong')?.textContent === 'Archive case 000' && document.querySelector('[aria-label="Refresh inbox"]').disabled === false`), 15000, { label: 'Historical server search result' })
  check(await evaluate(`document.querySelectorAll('.conversation-row').length === 1`) && searchTraffic.at(-1)?.q === 'archivedsecretneedle', 'server search returns an old body-only match without client subject filtering or sibling-project leakage')
  await selectConversation('Archive case 000'); await input('#reply', 'Private draft retained while searching persisted history')
  await input('#team-inbox', String(archive.id)); await input(searchInput, 'nebularoute')
  await waitFor(() => evaluate(`document.querySelectorAll('.conversation-row').length === 50 && document.body.textContent.includes('Load more conversations')`), 15000, { label: 'Combined native search page' })
  const combined = searchTraffic.at(-1)!
  check(combined.q === 'nebularoute' && combined.inboxId === String(archive.id) && combined.status === 'open' && !combined.cursor && !await evaluate(`document.body.textContent.includes('Matching other inbox') || document.body.textContent.includes('Matching resolved case')`), 'query, status and team inbox compose in the actual native HTTP request')
  const searchPath = prefix + '/inbox?' + new URLSearchParams({ q: 'nebularoute', inboxId: String(archive.id), status: 'open' })
  const originalCursor = (await http(searchPath, 'GET', undefined, owner.token)).data.nextCursor
  assert.ok(originalCursor)
  const arrival = await archived('New matching arrival', 'nebularoute')
  const originalContinuation = await http(searchPath + '&cursor=' + encodeURIComponent(originalCursor), 'GET', undefined, owner.token)
  check(originalContinuation.data.conversations.length === 5 && originalContinuation.data.conversations.every((row: { id: string }) => row.id !== arrival.id), 'the original native cursor excludes the newer arrival from the historical continuation')
  await click('Load more conversations')
  await waitFor(() => evaluate(`document.querySelectorAll('.conversation-row').length === 56 && document.body.textContent.includes('New matching arrival') && document.body.textContent.includes('Archive case 000')`), 15000, { label: 'Live filtered arrivals and historical search results coexist' })
  check(searchTraffic.some(entry => entry.q === 'nebularoute' && entry.inboxId === String(archive.id) && entry.status === 'open' && entry.cursor)
    && await evaluate(`new Set(Array.from(document.querySelectorAll('.conversation-row strong')).map(row=>row.textContent)).size === 56`), 'live list refresh and cursor continuation retain the active filters and avoid duplicate results')
  check(await evaluate(`document.querySelector('#reply').value === 'Private draft retained while searching persisted history'`), 'search and pagination preserve the selected historical conversation draft')
  for (let index = 55; index < 160; index++) await archived(`Archive case ${String(index).padStart(3, '0')}`, 'Historical message about nebularoute')
  await evaluate(`document.querySelector('[aria-label="Refresh inbox"]').click()`)
  const matchingRows = (count: number) => evaluate(`document.querySelectorAll('.conversation-row').length === ${count} && !document.querySelector('[aria-label="Refresh inbox"]').disabled`)
  await waitFor(() => matchingRows(50), 15000, { label: 'First page of the long filtered inbox' })
  await click('Load more conversations')
  await waitFor(() => matchingRows(100), 15000, { label: 'Second page of the long filtered inbox' })
  await click('Load more conversations')
  await waitFor(() => matchingRows(150), 15000, { label: 'Third page of the long filtered inbox' })
  const olderCase = await one('SELECT id FROM support_conversations WHERE project_id = ? AND subject = ?', [project.id, 'Archive case 012'])
  const previousBoundary = await one('SELECT id FROM support_conversations WHERE project_id = ? AND subject = ?', [project.id, 'Archive case 011'])
  assert.ok(olderCase && previousBoundary)
  await evaluate(`document.querySelector('#reply').focus()`)
  const beforeLiveRead = searchTraffic.length
  assert.equal((await http(prefix + `/conversations/${olderCase.id}/routing`, 'POST', { inboxId: Number(archive.id), assigneeId: 0, status: 'closed' }, owner.token)).status, 200)
  await waitFor(() => searchTraffic.slice(beforeLiveRead).some(entry => entry.q === 'nebularoute' && entry.inboxId === String(archive.id) && entry.status === 'open' && entry.limit === '100' && !entry.cursor), 15000, { label: 'Fresh live read of the filtered list after the independent status change' })
  await waitFor(() => evaluate(`!document.body.textContent.includes('Archive case 012') && document.querySelectorAll('.conversation-row').length === 149`), 12000, { label: 'Live replay removes a case that left the filter on the third loaded page' })
  check(await evaluate(`document.body.textContent.includes('Archive case 011') && document.querySelector('#reply').value === 'Private draft retained while searching persisted history' && document.activeElement.id === 'reply'`), 'live refresh keeps the other historical row, unsent draft, and composer focus')
  const beforeContinuation = searchTraffic.length
  await click('Load more conversations')
  await waitFor(() => matchingRows(160), 15000, { label: 'Manual continuation below the refreshed range' })
  check(searchTraffic.slice(beforeContinuation).some(entry => entry.q === 'nebularoute' && entry.inboxId === String(archive.id) && entry.status === 'open' && entry.cursor === String(previousBoundary.id))
    && await evaluate(`new Set(Array.from(document.querySelectorAll('.conversation-row strong')).map(row => row.textContent)).size === 160`), 'continuation uses the refreshed boundary and returns each remaining result once')
  const fallbackCase = await one('SELECT id FROM support_conversations WHERE project_id = ? AND subject = ?', [project.id, 'Archive case 010'])
  assert.ok(fallbackCase)
  const failedReads = refusedAgentReplay
  failAgentReplay = true
  try {
    assert.equal((await http(prefix + `/conversations/${fallbackCase.id}/routing`, 'POST', { inboxId: Number(archive.id), assigneeId: 0, status: 'closed' }, owner.token)).status, 200)
    await waitFor(() => refusedAgentReplay > failedReads, 15000, { label: 'Replay outage reaches the browser after the second status change' })
    await evaluate(`document.dispatchEvent(new Event('visibilitychange'))`)
    await waitFor(() => matchingRows(159), 12000, { label: 'Visible inbox refresh with replay unavailable' })
    check(!await evaluate(`document.body.textContent.includes('Archive case 010')`) && await evaluate(`document.querySelector('#reply').value === 'Private draft retained while searching persisted history'`), 'visible fallback refresh applies the same filtered range and preserves the draft when replay is unavailable')
  }
  finally { failAgentReplay = false }
  const refreshArrival = 'New arrival for explicit refresh'
  await archived(refreshArrival, 'nebularoute')
  const beforeExplicitRefresh = searchTraffic.length
  await evaluate(`document.querySelector('[aria-label="Refresh inbox"]').click()`)
  await waitFor(
    () => searchTraffic.slice(beforeExplicitRefresh).some(entry =>
      entry.q === 'nebularoute' && entry.inboxId === String(archive.id) && entry.status === 'open' && !entry.cursor && !entry.limit),
    15000, { label: 'Explicit native refresh request with no continuation cursor' },
  )
  await waitFor(() => matchingRows(50), 15000, { label: 'Explicit refresh renders the first filtered page' })
  check(await evaluate(`document.querySelector('#team-inbox').value === ${JSON.stringify(String(archive.id))}
    && document.querySelector('.conversation-row strong')?.textContent === ${JSON.stringify(refreshArrival)}`), 'explicit refresh starts a new query page with the current filters and includes new arrivals')
  const beforeClearSearch = searchTraffic.length
  await input(searchInput, '')
  await waitFor(
    () => searchTraffic.slice(beforeClearSearch).some(entry =>
      entry.q === null && entry.inboxId === String(archive.id) && entry.status === 'open' && !entry.cursor && !entry.limit),
    15000, { label: 'First-page request without a search query' },
  )
  await waitFor(() => matchingRows(50), 15000, { label: 'Cleared search renders the first inbox page' })
  check(await evaluate(`document.querySelector(${JSON.stringify(searchInput)}).value === ''
    && document.querySelector('#team-inbox').value === ${JSON.stringify(String(archive.id))}`), 'empty search omits q and preserves the status and inbox filters')
  const beforeLong = searchTraffic.length; await input(searchInput, 'a'.repeat(201)); await text('Search is limited to 200 characters.'); await Bun.sleep(400)
  check(searchTraffic.length === beforeLong, 'oversized programmatic input never sends an unbounded search request')
  const stale = holdSearch('stalequerytoken'); await input(searchInput, 'stalequerytoken'); await stale.entered.promise
  const beforeInvalidEdit = searchTraffic.length; await input(searchInput, 'x'); await text('Enter at least 2 characters'); stale.release.resolve(); await Bun.sleep(400)
  check(searchTraffic.length === beforeInvalidEdit && await evaluate(`document.querySelectorAll('.conversation-row').length === 0 && !document.body.textContent.includes('Late result must stay hidden')`), 'query edit invalidates an older in-flight result before debounce even when the replacement query is invalid')
  const beforeDebounce = searchTraffic.length; await input(searchInput, 'ar'); await input(searchInput, 'archived'); await input(searchInput, 'archivedsecretneedle'); await waitFor(() => evaluate(`document.querySelectorAll('.conversation-row').length === 1 && document.querySelector('.conversation-row strong')?.textContent === 'Archive case 000' && document.querySelector('[aria-label="Refresh inbox"]').disabled === false`), 15000, { label: 'Historical server search result' })
  check(searchTraffic.length === beforeDebounce + 1 && searchTraffic.at(-1)?.q === 'archivedsecretneedle', 'rapid valid edits debounce to the final bounded query')
  const oldProject = holdSearch('projectstaletoken'); await input(searchInput, 'projectstaletoken'); await oldProject.entered.promise
  await input('#project', String(sibling.public_id)); await text('Sibling-only request'); oldProject.release.resolve(); await Bun.sleep(200)
  check(await evaluate(`document.querySelector(${JSON.stringify(searchInput)}).value === '' && document.querySelector('#team-inbox').value === '' && document.querySelectorAll('.conversation-row').length === 1 && !document.body.textContent.includes('Late result must stay hidden')`) && searchTraffic.at(-1)?.path.includes(String(sibling.public_id)), 'project change cancels old query/cursor scope and cannot append a late result from another project')
  await input('#project', String(project.public_id)); await waitFor(() => evaluate(`document.querySelectorAll('.conversation-row').length === 50`), 15000, { label: 'Original project restored' }); await input(searchInput, 'archivedsecretneedle'); await waitFor(() => evaluate(`document.querySelectorAll('.conversation-row').length === 1 && document.querySelector('.conversation-row strong')?.textContent === 'Archive case 000' && document.querySelector('[aria-label="Refresh inbox"]').disabled === false`), 15000, { label: 'Historical server search result' }); await selectConversation('Archive case 000')
  check(await evaluate(`document.querySelector('#reply').value === 'Private draft retained while searching persisted history'`), 'project switching preserves only the matching project/conversation draft in memory')
  const pendingLogout = holdSearch('logoutstaletoken'); await input(searchInput, 'logoutstaletoken'); await pendingLogout.entered.promise
  const logout = await evaluate(`(async()=>{const seed=await (await fetch('/api/csrf-token')).json();return (await fetch('/api/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':seed.token},body:'{}'})).status})()`)
  check(logout === 200, 'native authenticated logout completes without browser identity overrides')
  await input(searchInput, 'archivedsecretneedle'); await text('Sign in to open your workspace.'); pendingLogout.release.resolve(); await Bun.sleep(200)
  check(await evaluate(`!document.querySelector('#reply') && document.querySelectorAll('.conversation-row').length === 0 && document.querySelector(${JSON.stringify(searchInput)}).value === '' && !document.body.textContent.includes('Archive case 000')`), 'logout cleanup discards private search results, drafts and late query responses')
  check(Number(arrival.id) > Number(oldBody.id) && Number(otherBox.id) !== Number(closedMatch.id) && siblingRecord.id, 'search qualification uses distinct persisted native records and real new arrivals')

  await navigate(cdp, origin + '/_fixture/owner', { quietMs: 100, timeoutMs: 20000 })
  const reportScope = { workspace_id: workspace.id, project_id: project.id }
  const reportContact = await insert('support_contacts', { ...reportScope, external_id: 'channel-report-browser' })
  const reportThread = await insert('support_conversations', { ...reportScope, contact_id: reportContact.id, channel: 'discord', subject: 'Browser channel report' })
  const reportSource = { ...reportScope, contact_id: reportContact.id, conversation_id: reportThread.id, visibility: 'public' }
  await insert('support_messages', { ...reportSource, author_type: 'customer', body: 'Provider inquiry' })
  const reportReply = await insert('support_messages', { ...reportSource, author_type: 'agent', author_id: owner.id, delivery_status: 'accepted', body: 'Provider acknowledgement' })
  const reportChannel = await insert('support_channels', { ...reportScope, public_id: crypto.randomUUID(), provider: 'discord' })
  const reportBinding = await insert('support_channel_threads', { ...reportScope, conversation_id: reportThread.id, contact_id: reportContact.id, channel_id: reportChannel.id, remote_key: 'browser-report', recipient: 'discord-fixture' })
  await insert('support_channel_deliveries', { ...reportScope, channel_id: reportChannel.id, thread_id: reportBinding.id, message_id: reportReply.id, operation_key: 'browser-report', request_hash: '', public_id: crypto.randomUUID(), provider_message_id: 'discord-fixture-response', status: 'accepted', accepted_at: Date.now() })
  const reportTicket = await insert('support_tickets', { ...reportScope, contact_id: reportContact.id, title: 'SLA report fixture' })
  await insert('support_ticket_sla_clocks', { ...reportScope, ticket_id: reportTicket.id, cycle: 1, phase: 'resolved', first_response_at: Date.now(), resolved_at: Date.now(), first_working_ms: 60_000, resolution_working_ms: 120_000 })
  await navigate(cdp, origin + '/app/reports', { quietMs: 100, timeoutMs: 20000 })
  const timingCards = `Array.from(document.querySelectorAll('[aria-labelledby="report-messenger-heading"] .metric-cell'))`
  await waitFor(() => evaluate(`${timingCards}.length === 3`), 15000, { label: 'Compiled Messenger timing cards' })
  check(await evaluate(`${timingCards}.some(card => card.textContent.includes('First human reply') && card.textContent.includes('1 sample') && card.querySelector('strong').textContent !== 'No data')`), 'Reports renders a measured human reply from the native inbox')
  const channelRow = 'document.querySelector(\'[aria-labelledby="report-channels-heading"] tbody tr\')'
  await waitFor(() => evaluate(`${channelRow}?.cells.length === 4`), 15000, { label: 'Provider timing table cells' })
  check(await evaluate(`${channelRow}.cells[0].textContent === 'Discord' && ${channelRow}.cells[1].textContent.includes('1 sample') && ${channelRow}.cells[2].textContent.includes('No data')`), 'Reports renders the native provider acknowledgement with a sample count and explicit missing measures')
  const slaCards = `Array.from(document.querySelectorAll('[aria-labelledby="report-sla-heading"] .metric-cell'))`
  await waitFor(() => evaluate(`${slaCards}.length === 2`), 15000, { label: 'Ticket SLA timing cards' })
  check(await evaluate(`${slaCards}.every(card => card.textContent.includes('1 sample') && card.querySelector('strong').textContent !== 'No data')`), 'Reports renders both business-time SLA averages')
  await input('#report-project', String(sibling.public_id))
  await waitFor(() => evaluate(`${timingCards}.length === 3 && ${timingCards}.every(card => card.querySelector('strong').textContent === 'No data')`), 15000, { label: 'Project without measured replies' })
  check(await evaluate(`document.querySelector('#report-project').value === ${JSON.stringify(String(sibling.public_id))}`), 'Reports switches projects without retaining the previous project’s timing values')
  check(await evaluate(`!${channelRow}`), 'Project switching clears the previous project’s provider timing table')
  check(await evaluate(`${slaCards}.length === 2 && ${slaCards}.every(card => card.querySelector('strong').textContent === 'No data')`), 'Project switching clears the previous project’s completed SLA samples')

  await navigate(cdp, origin + '/app/usage', { quietMs: 100, timeoutMs: 20000 })
  await waitFor(() => evaluate(`document.querySelector('#project-daily-limit') !== null && !document.querySelector('#usage-project').disabled`), 15000, { label: 'Self-hosted project spending settings' })
  await input('#usage-project', String(project.public_id))
  await waitFor(() => evaluate(`document.querySelector('#project-daily-limit') !== null && !document.querySelector('#usage-project').disabled`), 15000, { label: 'Selected project spending settings' })
  await input('#project-daily-limit', '12.34')
  await click('Save project ceilings')
  await text('Project spending ceilings saved.')
  const wallet = (await http(prefix + '/wallet', 'GET', undefined, owner.token)).data
  check(wallet.dailyLimitCents === 1234 && wallet.monthlyLimitCents === null, 'self-hosted Usage saves the selected project cap and preserves the inherited monthly ceiling')
  await input('#usage-project', String(sibling.public_id))
  await waitFor(() => evaluate(`document.querySelector('#project-daily-limit')?.value === '' && !document.querySelector('#usage-project').disabled`), 15000, { label: 'Uncapped sibling project' })
  check((await http(`/support/projects/${sibling.public_id}/wallet`, 'GET', undefined, owner.token)).data.dailyLimitCents === null, 'changing projects resets the cap form without changing the sibling budget')

  await navigate(cdp, origin + '/app/ticket-settings', { quietMs: 100, timeoutMs: 20000 })
  await waitFor(() => evaluate(`document.querySelector('#type-opens-conversation')?.checked === false`), 15000, { label: 'Inbox option defaults off for new customer types' })
  await input('#type-name', 'Private account help')
  await evaluate(`document.querySelector('#type-opens-conversation').click()`)
  await click('Create ticket type'); await text('Ticket type created.')
  check(Number((await one('SELECT opens_conversation FROM support_ticket_types WHERE project_id = ? AND name = ?', [project.id, 'Private account help']))?.opens_conversation) === 1, 'owner enables private inbox admission through compiled ticket settings')
  await http(prefix, 'PATCH', { allowedOrigins: [origin], anonymousEnabled: true }, owner.token)

  const widget = `/api/widget/projects/${project.public_id}`
  ;(config.services as unknown as Record<string, unknown>).supporthq = { enabled: true, url: apiOrigin, key: keys.ingestKey, project: project.public_id }
  const formRoot = `document.querySelector('hq-support-ticket-form').shadowRoot`
  for (const signedIn of [false, true]) {
    await navigate(cdp, origin + '/case-fixture', { quietMs: 100, timeoutMs: 20000 })
    await evaluate(`(async()=>{
      await import('/widgets/bundle.js');
      const headers = { 'Content-Type': 'application/json' };
      if (${signedIn}) headers['X-CSRF-Token'] = (await (await fetch('/api/csrf-token')).json()).token;
      const response = await fetch(${JSON.stringify(signedIn ? '/api/_native/support/session' : widget + '/session')}, { method: 'POST', credentials: '${signedIn ? 'same-origin' : 'omit'}', headers, body: '{}' });
      if (!response.ok) throw new Error('Case fixture session ' + response.status);
      const form = document.createElement('hq-support-ticket-form');
      Object.assign(form, { apiUrl: location.origin, projectId: ${JSON.stringify(project.public_id)}, sessionToken: (await response.json()).token });
      form.addEventListener('delivery', event => { form.dataset.conversation = event.detail.ticket.conversation_id });
      document.body.append(form);
    })()`)
    const audience = signedIn ? 'signed-in' : 'guest'
    await waitFor(() => evaluate(`${formRoot}.querySelector('#ticket-type')?.selectedOptions[0]?.textContent === 'Private account help' && !${formRoot}.querySelector('fieldset').disabled`), 15000, { label: `Compiled ${audience} case form ready` })
    await evaluate(`(()=>{const root=${formRoot}; for (const [selector,value] of [['#ticket-subject','Private ${audience} request'],['#ticket-body','Please answer in this private case.']]) { const field=root.querySelector(selector); field.value=value; field.dispatchEvent(new Event('input',{bubbles:true})); } root.querySelector('form').requestSubmit();})()`)
    await waitFor(() => evaluate(`Boolean(document.querySelector('hq-support-ticket-form').dataset.conversation)`), 15000, { label: `${audience} form returns a linked conversation` })
    const conversationId = await evaluate(`document.querySelector('hq-support-ticket-form').dataset.conversation`)
    const record = await one('SELECT c.inbox_id, p.external_id FROM support_conversations c JOIN support_contacts p ON p.id = c.contact_id AND p.project_id = c.project_id WHERE c.id = ? AND c.project_id = ?', [conversationId, project.id])
    check(Number(record?.inbox_id) === Number(inbox.id), `${audience} form submission reaches the default project inbox`)
    check(signedIn ? record?.external_id === `user:${owner.id}` : String(record?.external_id).startsWith('anonymous:'), `${audience} form preserves the server-bound contact`)
  }
  const collisionSubject = 'Simultaneous agent replies'
  const collisionCase = await http(`/v1/projects/${project.public_id}/conversations`, 'POST', { externalId: 'collision-customer', subject: collisionSubject, body: 'Please coordinate this response.', idempotencyKey: 'browser-presence' }, keys.ingestKey)
  assert.equal(collisionCase.status, 201)
  await navigate(cdp, origin + '/app', { quietMs: 100, timeoutMs: 20000 })
  await text(collisionSubject)
  await selectConversation(collisionSubject)
  peerCookie = await browserCookie('agent')
  peer = await launch({ headless: true, shared: false, chromePath: process.env.CHROME_PATH, startTimeoutMs: 60000, commandTimeoutMs: 20000 })
  const peerCdp = peer.cdp
  peerCdp.on('Runtime.exceptionThrown', event => runtimeErrors.push(String(event.exceptionDetails.exception?.description || event.exceptionDetails.text)))
  await peerCdp.intercept([{ urlPattern: '*' }], async (event, session) => {
    const url = new URL(event.request.url)
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/css' }], body: '' })
    else await session.send('Fetch.continueRequest', { requestId: event.requestId })
  })
  await navigate(peerCdp, origin + '/_fixture/peer', { quietMs: 100, timeoutMs: 20000 })
  await navigate(peerCdp, origin + '/app', { quietMs: 100, timeoutMs: 20000 })
  await waitFor(() => peerCdp.evaluate(`document.body.textContent.includes(${JSON.stringify(collisionSubject)})`), 15000, { label: 'Independent agent opens the same inbox' })
  const joined = performance.now()
  await peerCdp.evaluate(`Array.from(document.querySelectorAll('.conversation-row strong')).find(el => el.textContent.trim() === ${JSON.stringify(collisionSubject)})?.closest('button').click()`)
  await waitFor(() => peerCdp.evaluate(`document.querySelector('#reply')?.disabled === false && document.body.textContent.includes('Also viewing · owner')`), 15000, { label: 'Peer sees owner in the selected conversation' })
  await text('Also viewing · agent')
  presenceTiming.joinMs = Math.round(performance.now() - joined)
  check(await evaluate(`document.querySelector('.thread-heading [role="status"]').textContent.trim() === 'Also viewing · agent'`), 'two independent signed-in browsers see only the other agent on the same thread')
  await input('#reply', 'Owner draft preserved during collaboration')
  const beganComposing = performance.now()
  await peerCdp.evaluate(`(()=>{const field=document.querySelector('#reply'); field.value='Agent reply sent first'; field.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await text('agent composing a public reply.')
  presenceTiming.composingMs = Math.round(performance.now() - beganComposing)
  check(await evaluate(`document.querySelector('#reply').value === 'Owner draft preserved during collaboration' && document.querySelector('#reply-collision').getAttribute('role') === 'status' && document.querySelector('.composer-footer button').disabled`), 'composing warning is announced, keeps the draft and holds the default send')
  await waitFor(() => peerCdp.evaluate(`document.body.textContent.includes('owner composing a public reply.')`), 15000, { label: 'Peer also sees owner composing' })
  await peerCdp.evaluate(`Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === 'Send my reply anyway')?.click()`)
  const sent = performance.now()
  await text('A teammate sent a public reply while you were writing.')
  presenceTiming.replyWarningMs = Math.round(performance.now() - sent)
  await click('Review conversation')
  await text('Agent reply sent first')
  check(await evaluate(`document.querySelector('#reply').value === 'Owner draft preserved during collaboration' && document.querySelector('#reply').getAttribute('aria-describedby') === 'reply-collision'`), 'reviewing a new reply refreshes the transcript without consuming the draft')
  await click('Send my reply anyway'); await text('Reply saved.')
  const collisionThreadId = collisionCase.data.conversation.id
  check(Number((await one("SELECT COUNT(*) AS total FROM support_messages WHERE conversation_id = ? AND author_type = 'agent' AND visibility = 'public'", [collisionThreadId]))?.total) === 2, 'explicit confirmation sends one additional reply after the other agent’s message')
  simulatePeerDisconnect = true
  const disconnected = performance.now()
  await peer.close()
  peer = undefined
  await waitFor(() => evaluate(`!document.querySelector('.thread-heading [role="status"]').textContent.includes('agent')`), 35_000, { label: 'Unclean browser disconnect expires without a leave request' })
  simulatePeerDisconnect = false
  presenceTiming.disconnectMs = Math.round(performance.now() - disconnected)
  check(presenceTiming.disconnectMs <= 32_000, 'a disappeared browser stops appearing after its lease expires')
  const secondWorkspace = (await http('/support/workspaces', 'POST', { name: 'Other migration workspace' }, owner.token)).data.workspace
  const secondProject = (await http(`/support/workspaces/${secondWorkspace.id}/projects`, 'POST', { name: 'Other brand' }, owner.token)).data.project
  const bundleFile = resolve(output, 'intercom-preview-fixture.json')
  await Bun.write(bundleFile, JSON.stringify({
    version: 1, provider: 'intercom', format: 'plaintext',
    contacts: [{ id: 'compatible-preview' }, ...Array.from({ length: 26 }, (_, index) => ({ id: `invalid@${index}` }))],
    conversations: [],
  }))
  async function openMigrationSettings(role: string) {
    migrationCookie = await browserCookie(role)
    await navigate(cdp, origin + '/_fixture/migration', { quietMs: 100, timeoutMs: 20000 })
    await navigate(cdp, origin + '/app/settings', { quietMs: 100, timeoutMs: 20000 })
    await waitFor(() => evaluate(`document.querySelector('#settings-project')?.options.length > 1`), 15000, { label: 'Project settings loaded' })
  }
  await openMigrationSettings('agent')
  check(await evaluate(`!document.querySelector('#migration-file')`), 'ordinary agent settings hide the migration preview')
  await openMigrationSettings('admin')
  await waitFor(() => evaluate(`!!document.querySelector('#migration-file')`), 15000, { label: 'Admin migration control' })
  check(true, 'workspace admin can access the migration upload control')
  const beforePreview = await one('SELECT COUNT(*) AS total FROM support_import_runs')
  await openMigrationSettings('owner')
  await input('#settings-project', String(project.public_id))
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true })
  async function chooseBundle() {
    const { root: documentRoot } = await cdp.send('DOM.getDocument')
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: '#migration-file' })
    assert.ok(nodeId)
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [bundleFile] })
    await waitFor(() => evaluate(`!document.querySelector('#migration-heading + p + form button').disabled`), 5000, { label: 'Preview form is ready' })
  }
  await chooseBundle()
  await evaluate(`document.querySelector('#migration-heading + p + form button').focus()`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await text('Preview complete.')
  check(await evaluate(`document.querySelector('#migration-result').getBoundingClientRect().width <= 375
    && document.querySelectorAll('#migration-result li').length === 25 && document.querySelector('#migration-review-only').checked`),
  'keyboard submits a real dry run and the phone shows a bounded review inventory')
  await click('Next')
  await waitFor(() => evaluate(`document.querySelector('#migration-result li')?.textContent.includes('Position 26')`), 5000, { label: 'Second review page' })
  await input('#migration-page-number', '1')
  await waitFor(() => evaluate(`document.querySelector('#migration-result li')?.textContent.includes('Position 1 ·')`), 5000, { label: 'Jump directly to a page' })
  await evaluate(`document.querySelector('#migration-review-only').click()`)
  await waitFor(() => evaluate(`document.querySelector('#migration-result li')?.textContent.includes('compatible-preview')`), 5000, { label: 'All source outcomes' })
  check(await evaluate(`document.querySelector('#migration-result').textContent.includes('27 supplied records') && !document.querySelector('#migration-result').textContent.includes('invalid@')`), 'inventory pages and filters outcomes without displaying malformed IDs')
  await evaluate(`document.querySelector('#migration-result').scrollIntoView({ block: 'start' })`)
  const migrationImage = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await Bun.write(resolve(artifacts, 'phone-migration-preview.png'), Buffer.from(migrationImage.data, 'base64'))

  inconsistentMigrationTotals = true
  await click('Preview bundle')
  await text('The migration preview response was incomplete. Try again.')
  check(await evaluate(`!document.querySelector('#migration-result')`), 'a preview with contradictory counts does not render an inventory')
  await click('Preview bundle')
  await text('Preview complete.')

  const delayedMigration = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
  migrationGate = delayedMigration
  try {
    await click('Preview bundle')
    await Promise.race([delayedMigration.entered.promise, Bun.sleep(10_000).then(() => { throw new Error('Delayed migration did not reach the native endpoint') })])
    await input('#settings-project', String(secondProject.public_id))
    await waitFor(() => evaluate(`document.querySelector('#migration-file')?.files.length === 0`), 5000, { label: 'Workspace switch clears the file' })
  }
  finally { migrationGate = undefined; delayedMigration.release.resolve() }
  await waitFor(() => evaluate(`!document.querySelector('#migration-result') && document.querySelector('#migration-heading + p + form button').disabled`), 5000, { label: 'Workspace switch clears preview' })
  check(Number((await one('SELECT COUNT(*) AS total FROM support_import_runs'))?.total) === Number(beforePreview?.total),
    'preview and project changes create no import run')
  await input('#settings-project', String(project.public_id))
  await chooseBundle()
  await click('Preview bundle')
  await text('Preview complete.')
  await click('Sign out of your account')
  await waitFor(() => evaluate(`location.pathname === '/login' && !document.querySelector('#migration-result')`), 15000, { label: 'Signed-out settings clear the preview' })
  check(true, 'sign-out clears the migration file and visible preview')

  await openMigrationSettings('owner')
  await input('#settings-project', String(project.public_id))
  await input('#settings-saved-reply-name', 'Refund outline')
  await input('#settings-saved-reply-body', 'Your refund has started.')
  await click('Save reply')
  await text('Saved reply saved.')
  await waitFor(() => evaluate(`!!document.querySelector('[aria-label="Edit Refund outline"]')`), 5000, { label: 'Created saved reply is listed' })
  await evaluate(`document.querySelector('[aria-label="Edit Refund outline"]').click()`)
  await input('#settings-saved-reply-body', 'Your refund will post within five business days.')
  await click('Save reply')
  await text('Your refund will post within five business days.')
  await input('#settings-project', String(secondProject.public_id))
  await text('No saved replies found.')
  check(await evaluate(`!document.querySelector('[aria-label="Edit Refund outline"]') && document.querySelector('#settings-saved-reply-body').value === ''`), 'project settings never retain another project’s reply or editor draft')

  const customerIdentity = { externalId: 'saved-reply-customer' }
  const createCasePath = `/v1/projects/${project.public_id}/conversations`
  const savedCase = await http(createCasePath, 'POST', { ...customerIdentity, subject: 'Question about a refund', body: 'When will it post?', idempotencyKey: 'saved-reply-browser-case' }, keys.ingestKey)
  const otherCase = await http(createCasePath, 'POST', { ...customerIdentity, subject: 'Another saved reply case', body: 'Another question', idempotencyKey: 'saved-reply-browser-other' }, keys.ingestKey)
  assert.equal(savedCase.status, 201)
  assert.equal(otherCase.status, 201)
  await openMigrationSettings('agent')
  check(await evaluate(`!document.querySelector('#saved-replies-settings')`), 'ordinary agents use saved replies without seeing project management')
  await navigate(cdp, origin + '/app', { quietMs: 100, timeoutMs: 20000 })
  await selectConversation('Question about a refund')
  await input('#reply', 'I checked your order.')
  async function pressEnter() {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  await evaluate(`document.querySelector('#saved-reply-toggle').focus()`)
  await pressEnter()
  await waitFor(() => evaluate(`document.activeElement?.id === 'saved-reply-search'`), 5000, { label: 'Keyboard opens and focuses the saved reply search' })
  await input('#saved-reply-search', 'Refund')
  await pressEnter()
  await text('Refund outline')
  check(Number((await one("SELECT COUNT(*) AS total FROM support_messages WHERE conversation_id = ? AND author_type = 'agent'", [savedCase.data.conversation.id]))?.total) === 0, 'Enter in the saved reply search never submits the composer')
  await evaluate(`document.querySelector('#saved-reply-picker li button').focus()`)
  await pressEnter()
  await waitFor(() => evaluate(`document.activeElement?.id === 'reply'`), 5000, { label: 'Focus returns to the edited draft' })
  check(await evaluate(`document.querySelector('#reply').value === 'I checked your order.\\n\\nYour refund will post within five business days.'`), 'keyboard insertion preserves the existing draft and appends the selected text')
  check(Number((await one("SELECT COUNT(*) AS total FROM support_messages WHERE conversation_id = ? AND author_type = 'agent'", [savedCase.data.conversation.id]))?.total) === 0, 'inserting a reply changes the draft without sending it')
  const editedReply = 'I checked your order. Your refund should post by Friday.'
  await input('#reply', editedReply)
  await click('Send reply')
  await text(editedReply)
  assert.equal((await http(prefix, 'PATCH', { allowedOrigins: [origin] }, owner.token)).status, 200)
  const customer = (await http(`/v1/projects/${project.public_id}/sessions`, 'POST', customerIdentity, keys.ingestKey)).data.token
  const visible = await fetch(apiOrigin + `/api/widget/projects/${project.public_id}/conversations/${savedCase.data.conversation.id}`, { headers: { origin, authorization: `Bearer ${customer}` } })
  const visibleDetail = await visible.json() as { messages?: Array<{ body: string }> }
  check(visible.status === 200 && visibleDetail.messages?.some(message => message.body === editedReply), 'the customer sees the edited reply through the public transcript')

  await selectConversation('Another saved reply case')
  await input('#reply', 'Draft for the other case.')
  await selectConversation('Question about a refund')
  const delayedSavedReplies = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
  const nextSavedReplies = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
  await evaluate(`(() => {
    const original = window.fetch
    window.fixtureSavedReplyFetch = original
    window.fixtureOldSavedReplyRead = false
    let holdFirst = true
    window.fetch = (url, options) => {
      if (!holdFirst || !String(url).includes('/saved-replies?')) return original.call(window, url, options)
      holdFirst = false
      // Deliver the old body even after the picker aborts its request.
      return original.call(window, url, { ...options, signal: undefined }).then(response => {
        const json = response.json.bind(response)
        response.json = async () => {
          const result = await json()
          setTimeout(() => { window.fixtureOldSavedReplyRead = true }, 0)
          return result
        }
        return response
      })
    }
  })()`)
  savedReplyGate = delayedSavedReplies
  try {
    await click('Saved replies')
    await Promise.race([delayedSavedReplies.entered.promise, Bun.sleep(10_000).then(() => { throw new Error('Saved replies did not reach the native endpoint') })])
    await selectConversation('Another saved reply case')
    await waitFor(() => evaluate(`!document.querySelector('#saved-reply-picker')`), 5000, { label: 'Switching conversations closes the saved reply picker' })
    savedReplyGate = nextSavedReplies
    await click('Saved replies')
    await Promise.race([nextSavedReplies.entered.promise, Bun.sleep(10_000).then(() => { throw new Error('The second saved reply search did not reach the native endpoint') })])
    delayedSavedReplies.release.resolve()
    await waitFor(() => evaluate(`window.fixtureOldSavedReplyRead === true`), 5000, { label: 'The old saved reply response reached the browser' })
    check(await evaluate(`document.querySelector('#saved-reply-picker li button') === null && document.querySelector('#reply').value === 'Draft for the other case.'`), 'a late saved reply list cannot populate the next conversation picker or alter its draft')
  }
  finally {
    savedReplyGate = undefined
    delayedSavedReplies.release.resolve()
    nextSavedReplies.release.resolve()
    await evaluate(`window.fetch = window.fixtureSavedReplyFetch; delete window.fixtureSavedReplyFetch; delete window.fixtureOldSavedReplyRead`)
  }
  await text('Refund outline')

  await selectConversation('Question about a refund')
  const snoozedCase = savedCase.data.conversation.id
  const followUpDraft = 'Draft kept while scheduling follow-up.'
  await input('#reply', followUpDraft)
  async function openSnoozeByKeyboard() {
    await evaluate(`document.querySelector('#snooze-conversation-toggle').focus()`)
    await pressEnter()
    await waitFor(() => evaluate(`document.activeElement?.id === 'snooze-conversation-time'`), 5000, { label: 'Keyboard focuses the follow-up time' })
  }
  await openSnoozeByKeyboard()
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await waitFor(() => evaluate(`document.activeElement?.id === 'snooze-conversation-toggle' && !document.querySelector('#snooze-conversation-form')`), 5000, { label: 'Escape returns focus to Snooze' })
  check(true, 'keyboard opens the snooze editor and Escape returns focus without changing the case')
  await openSnoozeByKeyboard()
  await input('#snooze-conversation-time', '2000-01-01T00:00')
  await click('Set follow-up')
  await text('Choose a valid future time.')
  check((await one('SELECT snoozed_until FROM support_conversations WHERE id = ?', [snoozedCase]))?.snoozed_until === null, 'past local time produces accessible feedback and no write')
  const dateInput = await cdp.evaluate<string>(`new Date(Date.now() + 7_200_000 - new Date(Date.now() + 7_200_000).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)`)
  const expectedWake = await cdp.evaluate<number>(`new Date(${JSON.stringify(dateInput)}).getTime()`)
  async function scheduleFollowUp() {
    await input('#snooze-conversation-time', dateInput)
    await evaluate(`document.querySelector('#snooze-conversation-form button[type="submit"]').focus()`)
    await pressEnter()
    await waitFor(() => evaluate(`!!document.querySelector('#conversation-snooze-time') && document.activeElement?.id === 'snooze-conversation-toggle'`), 10000, { label: 'Follow-up is visible and keyboard focus returns' })
  }
  await scheduleFollowUp()
  check(Number((await one('SELECT snoozed_until FROM support_conversations WHERE id = ?', [snoozedCase]))?.snoozed_until) === expectedWake, 'the browser saves the chosen local time as an exact UTC deadline')
  await evaluate(`document.querySelector('#reopen-snoozed-conversation').focus()`)
  await pressEnter()
  await waitFor(() => evaluate(`!document.querySelector('#reopen-snoozed-conversation') && document.activeElement?.id === 'snooze-conversation-toggle'`), 10000, { label: 'Keyboard manually reopens the conversation' })
  check(await evaluate(`document.querySelector('#reply').value === ${JSON.stringify(followUpDraft)}`), 'snoozing and reopening preserve the active reply draft')
  await openSnoozeByKeyboard()
  await scheduleFollowUp()
  await click('Open')
  const caseListed = `Array.from(document.querySelectorAll('.conversation-row strong')).some(el => el.textContent.trim() === 'Question about a refund')`
  await waitFor(() => evaluate(`!(${caseListed}) && !document.querySelector('[aria-label="Refresh inbox"]').disabled`), 10000, { label: 'Snoozed case leaves open inbox' })
  await query('UPDATE support_conversations SET snoozed_until = ? WHERE id = ?', [Date.now() - 1, snoozedCase])
  await runJob('ReopenSnoozedConversations')
  await evaluate(`document.dispatchEvent(new Event('visibilitychange'))`)
  await waitFor(() => evaluate(`${caseListed} && !document.querySelector('#conversation-snooze-time')`), 10000, { label: 'Visible inbox sees the reopened case following the scheduled job' })
  await text('Scheduled follow-up')
  check(await evaluate(`document.querySelector('#reply').value === ${JSON.stringify(followUpDraft)}`), 'the completed follow-up refreshes the visible inbox, audit history and active draft')
  await openSnoozeByKeyboard()
  await scheduleFollowUp()
  await click('Snoozed')
  await waitFor(() => evaluate(`${caseListed} && !document.querySelector('[aria-label="Refresh inbox"]').disabled`), 10000, { label: 'Snoozed inbox shows the next follow-up' })
  const earlyResponse = await fetch(apiOrigin + `/api/widget/projects/${project.public_id}/conversations/${snoozedCase}/messages`, { method: 'POST', headers: { origin, authorization: `Bearer ${customer}`, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Customer replied before the due time.', idempotencyKey: 'snooze-early-reply-browser' }) })
  assert.equal(earlyResponse.status, 201)
  await evaluate(`document.dispatchEvent(new Event('visibilitychange'))`)
  await waitFor(() => evaluate(`!(${caseListed}) && !document.querySelector('#conversation-snooze-time') && !document.querySelector('#reopen-snoozed-conversation')`), 10000, { label: 'Snoozed list and selected thread both clear the future follow-up after an early reply' })
  await text('Customer replied before the due time.')
  check(await evaluate(`document.querySelector('#reply').value === ${JSON.stringify(followUpDraft)}`), 'early customer replies refresh the selected thread outside the snoozed filter and preserve the draft')

  await click('Open')
  await waitFor(() => evaluate(`${caseListed} && !document.querySelector('[aria-label="Refresh inbox"]').disabled`), 10000, { label: 'Open inbox ready for an independently authenticated mutation' })
  await waitFor(() => agentStreams > 0 && finiteAgentReads > 0, 20000, { label: 'Native agent stream and replay both use the signed-in browser' })
  const routed = await http(prefix + `/conversations/${snoozedCase}`, 'PATCH', { status: 'snoozed', snoozedUntil: Date.now() + 60_000 }, owner.token)
  assert.equal(routed.status, 200)
  await waitFor(() => evaluate(`!(${caseListed}) && !!document.querySelector('#conversation-snooze-time')`), 10000, { label: 'Agent sees a second credential snooze the open case without a refresh gesture' })
  await query('UPDATE support_conversations SET snoozed_until = ? WHERE id = ?', [Date.now() - 1, snoozedCase])
  await runJob('ReopenSnoozedConversations')
  await waitFor(() => evaluate(`${caseListed} && !document.querySelector('#conversation-snooze-time')`), 10000, { label: 'Worker reopen invalidates the active open inbox through durable replay' })
  check(await evaluate(`document.querySelector('#reply').value === ${JSON.stringify(followUpDraft)}`), 'live routing and worker reopen preserve the operator draft')
  const beforeReads = finiteAgentReads
  const beforeDrop = suppressedReplayHints
  suppressReplayHints = true
  try {
    const lostHintReply = await fetch(apiOrigin + `/api/widget/projects/${project.public_id}/conversations/${snoozedCase}/messages`, { method: 'POST', headers: { origin, authorization: `Bearer ${customer}`, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Customer activity with its live hint suppressed.', idempotencyKey: 'inbox-realtime-lost-hint' }) })
    assert.equal(lostHintReply.status, 201)
    await waitFor(() => suppressedReplayHints > beforeDrop, 10000, { label: 'Fixture dropped a real wire hint' })
    await waitFor(() => finiteAgentReads > beforeReads && evaluate("document.querySelector('#agent-message-history').textContent.includes('Customer activity with its live hint suppressed.')"), 38000, { label: 'Periodic finite replay recovers the missed hint' })
    check(await evaluate(`document.querySelector('#reply').value === ${JSON.stringify(followUpDraft)}`), 'finite replay recovers customer activity when the live hint is lost')
  }
  finally { suppressReplayHints = false }
  const snapshotsBeforeExpiry = agentSnapshots
  await query('UPDATE support_replay_channels SET lease_until = ? WHERE workspace_id = ? AND project_id = ? AND name = ?', [Date.now() - 1, project.workspace_id, project.id, `support.agent.${project.id}`])
  const afterExpiry = await fetch(apiOrigin + `/api/widget/projects/${project.public_id}/conversations/${snoozedCase}/messages`, { method: 'POST', headers: { origin, authorization: `Bearer ${customer}`, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Customer activity while the old replay lease was expired.', idempotencyKey: 'inbox-realtime-expired-lease' }) })
  assert.equal(afterExpiry.status, 201)
  await waitFor(() => agentSnapshots > snapshotsBeforeExpiry && evaluate("document.querySelector('#agent-message-history').textContent.includes('Customer activity while the old replay lease was expired.')"), 38000, { label: 'The inbox re-enrolls and reads current state after an expired replay lease' })
  check(await evaluate(`document.querySelector('#reply').value === ${JSON.stringify(followUpDraft)}`), 'snapshot recovery after expiry restores the view and keeps the unsent draft')

  await openMigrationSettings('owner')
  await input('#settings-project', String(project.public_id))
  await waitFor(() => evaluate(`!!document.querySelector('[aria-label="Archive Refund outline"]')`), 5000, { label: 'Saved reply archive control' })
  await evaluate(`document.querySelector('[aria-label="Archive Refund outline"]').click()`)
  await text('Saved reply archived.')
  await text('No saved replies found.')
  check(await evaluate(`!document.querySelector('[aria-label="Archive Refund outline"]')`), 'archived replies disappear from the active settings list')

  await openMigrationSettings('agent')
  const streamsBeforeRevocation = agentStreams
  await navigate(cdp, origin + '/app', { quietMs: 100, timeoutMs: 20000 })
  await selectConversation('Question about a refund')
  await waitFor(() => agentStreams > streamsBeforeRevocation, 20000, { label: 'Ordinary agent has an active project subscription before revocation' })
  await query("UPDATE support_memberships SET status = 'revoked' WHERE workspace_id = ? AND user_id = ?", [workspace.id, agent.id])
  await waitFor(() => evaluate("document.body.textContent.includes('This project is no longer available to your account.') && !document.querySelector('#reply') && !document.querySelector('.conversation-row')"), 38000, { label: 'Realtime authorization loss clears the protected inbox and thread' })
  check(true, 'revoking the active agent removes the protected list and selected conversation during finite reconciliation')

  console.info(`PASS team UI functional (${assertions.length} checks)`)
  await Bun.write(resolve(artifacts, 'report.json'), JSON.stringify({ passed: runtimeErrors.length === 0, functionalPassed: true, assertions, runtimeErrors, presenceTiming, cacheDriver: config.cache.driver, browser: (await cdp.send('Browser.getVersion')).product }, null, 2))
  assert.deepEqual(runtimeErrors, [], 'No browser runtime errors: retain this gate until the native compiler fix is published')
  console.info('PASS team browser qualification')
}
finally {
  if (browser) {
    await mkdir(artifacts, { recursive: true })
    const captured = await Promise.allSettled([browser.cdp.evaluate(`({ text: document.body.textContent, width: innerWidth, active: document.activeElement?.id, expanded: document.querySelector('[aria-label="Toggle customer details"]')?.getAttribute('aria-expanded'), panelDisplay: getComputedStyle(document.querySelector('#customer-details') || document.body).display })`), browser.cdp.send('Page.captureScreenshot', { format: 'png' })])
    await Bun.write(resolve(artifacts, 'diagnostic.json'), JSON.stringify({ assertions, runtimeErrors, body: captured[0].status === 'fulfilled' ? captured[0].value : 'Browser closed' }, null, 2))
    if (captured[1].status === 'fulfilled') await Bun.write(resolve(artifacts, 'latest.png'), Buffer.from(captured[1].value.data, 'base64'))
  }
  migrationGate?.release.resolve(); savedReplyGate?.release.resolve(); searchGate?.release.resolve(); host?.stop(true); api.stop(true); await peer?.close(); await browser?.close(); await closeSharedBrowsers(); await rm(output, { recursive: true, force: true })
}
process.exit(0)
