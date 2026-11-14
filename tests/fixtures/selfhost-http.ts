import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { Action } from '@stacksjs/actions/runtime'
import { Storage } from '@stacksjs/storage'
import { stripe } from '@stacksjs/payments'
import { one, query } from '../../app/Support/database'
import { reserveWallet } from '../../app/Support/billing'
import { agentProject, member, reserveAi } from '../../app/Support/service'
import { SupportError, identifier } from '../../app/Support/errors'

await overridesReady
if (config.database.queryLogging) config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()
Storage.init({ default: 'local', disks: { local: { driver: 'local', root: process.env.SUPPORT_TEST_STORAGE! } } })
// Exercise the real atomic quota/wallet admission primitives behind native auth.
// These fixture-only routes do not pretend that an AI/provider completed a send.
for (const kind of ['wallet', 'ai'] as const) route.post(`/api/_selfhost/${kind}/{workspace}/{project}/{conversation}`, new Action({ method: 'POST', apiResponse: false, async handle(request) {
  try {
    const userId = Number((await request.user())?.id), workspaceId = identifier(request.getParam('workspace'))
    await member(userId, workspaceId, ['owner', 'admin'])
    const project = await agentProject(userId, request.getParam('project'))
    if (Number(project.workspace_id) !== workspaceId) throw new SupportError(403, 'forbidden', 'Workspace mismatch.')
    const result = kind === 'wallet' ? await reserveWallet(workspaceId, String(request.get('operationKey')), Number(request.get('amountCents')), 'twilio') : await reserveAi(project, request.getParam('conversation'), 1)
    return Response.json({ admitted: true, reservation: result }, { status: 201 })
  }
  catch (error) { return Response.json({ error: { code: error instanceof SupportError ? error.code : 'unavailable' } }, { status: error instanceof SupportError ? error.status : 503 }) }
} })).middleware('auth')
let externalCreates = 0
const sessions = new Map<string, Record<string, unknown>>()
stripe.checkout.sessions.create = (async (input: any) => {
  externalCreates++
  const value = { id: `cs_selfhost_${externalCreates}`, url: 'https://checkout.stripe.com/selfhost-fixture', metadata: input.metadata, client_reference_id: input.client_reference_id, amount_total: input.line_items[0].price_data.unit_amount }
  sessions.set(value.id, value)
  return value
}) as typeof stripe.checkout.sessions.create
stripe.billingPortal.sessions.create = (async () => { throw new Error('Self-host portal must not reach the external provider') }) as typeof stripe.billingPortal.sessions.create
const server = await route.serve({ port: 0, hostname: '127.0.0.1' }), base = `http://127.0.0.1:${server.port}/api`
const selfhost = process.env.SUPPORT_TEST_MODE === 'selfhost'
let csrf = '', cookie = '', checks = 0
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++ }
async function http(path: string, method = 'GET', body?: unknown, token?: string, extra: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json() as any, headers: response.headers }
}
try {
  const seed = await http('/csrf-token'); csrf = seed.data.token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  await http('/register', 'POST', { name: 'Selfhost Operator', email: 'selfhost@example.test', password: 'SelfhostFixture2026!', password_confirmation: 'SelfhostFixture2026!' })
  const login = await http('/login', 'POST', { email: 'selfhost@example.test', password: 'SelfhostFixture2026!' }), token = login.data.access_token ?? login.data.token
  assert.equal(typeof token, 'string')
  const created = await http('/support/workspaces', 'POST', { name: 'Operator workspace', plan: selfhost ? 'enterprise' : 'selfhost', deploymentMode: selfhost ? 'hosted' : 'selfhost', walletCents: 10000000, trialEndsAt: 0 }, token)
  const workspace = created.data.workspace
  check(created.status === 201 && workspace.plan === (selfhost ? 'selfhost' : 'trial'), 'workspace plan follows the operator environment, never browser-supplied plan or mode')
  check(selfhost ? Number(workspace.trial_ends_at) === 0 : Number(workspace.trial_ends_at) > Date.now() + 13 * 86400000, 'self-hosted rows have no trial deadline; missing mode retains the hosted trial')
  check(Number(workspace.wallet_cents) === 0, 'uncapped core never grants submitted or fabricated prepaid funds')
  const first = await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'First project' }, token), project = first.data.project
  check(first.status === 201, 'native owner creates a project')
  const agent = `/support/projects/${project.public_id}`, keys = (await http(`${agent}/keys`, 'POST', {}, token)).data
  const conversation = await http(`/v1/projects/${project.public_id}/conversations`, 'POST', { externalId: 'operator-customer', subject: 'First request', body: 'A real native request', idempotencyKey: 'operator-first' }, keys.ingestKey)
  check(conversation.status === 201, 'project-scoped native write key starts a real conversation')
  const firstId = conversation.data.conversation.id
  const secondProject = await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Second project' }, token)
  check(secondProject.status === (selfhost ? 201 : 402), 'project admission respects uncapped selfhost versus hosted trial')
  const invitationCount = selfhost ? 51 : 2
  for (let index = 0; index < invitationCount; index++) {
    const invited = await http(`/support/workspaces/${workspace.id}/invitations`, 'POST', { email: `agent-${index}@example.test` }, token)
    assert.equal(invited.status, selfhost || index === 0 ? 201 : 402, JSON.stringify(invited.data))
  }
  check(Number((await one('SELECT COUNT(*) AS count FROM support_memberships WHERE workspace_id = ?', [workspace.id]))!.count) === (selfhost ? 52 : 2), 'selfhost exceeds hosted seat counts while pending hosted invitations remain capped')
  if (selfhost) {
    for (let index = 1; index < 122; index++) {
      const response = await http(`/v1/projects/${project.public_id}/conversations`, 'POST', { externalId: 'operator-customer', subject: `Selfhost request ${index}`, body: 'Stored source body', idempotencyKey: `selfhost-request-${index}` }, keys.ingestKey)
      assert.equal(response.status, 201, JSON.stringify(response.data))
    }
    check(Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND meter = 'conversations'", [workspace.id]))!.used) === 122, 'selfhost conversation meter records usage beyond the hosted trial ceiling without refusing it')
  }
  const conversationIds = await query('SELECT id FROM support_conversations WHERE project_id = ? ORDER BY id LIMIT 11', [project.id])
  if (!selfhost) {
    for (let index = 0; index < 10; index++) await http(`/v1/projects/${project.public_id}/conversations`, 'POST', { externalId: 'operator-customer', subject: `Hosted AI request ${index}`, body: 'Source', idempotencyKey: `hosted-ai-${index}` }, keys.ingestKey)
  }
  const aiThreads = selfhost ? conversationIds : await query('SELECT id FROM support_conversations WHERE project_id = ? ORDER BY id LIMIT 11', [project.id])
  for (const [index, row] of aiThreads.entries()) {
    const admitted = await http(`/_selfhost/ai/${workspace.id}/${project.public_id}/${row.id}`, 'POST', {}, token)
    assert.equal(admitted.status, selfhost || index < 10 ? 201 : 402, JSON.stringify(admitted.data))
  }
  check(Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND meter = 'ai'", [workspace.id]))!.used) === (selfhost ? 11 : 10), 'AI monthly admission is uncapped only for selfhost; this is admission evidence, not a provider completion')
  const billing = await http(`${agent}/billing`, 'GET', undefined, token)
  const uncapped = ['seats', 'projects', 'conversations', 'conversationCeiling', 'ai', 'storageBytes', 'fileBytes', 'indexingTokens', 'copilotRequests', 'copilotTokens']
  check(uncapped.every(key => selfhost ? billing.data.limits[key] === null : billing.data.limits[key] !== null), 'usage API serializes honest null caps for every selfhost catalog allowance')
  check(typeof billing.data.workspace.trialEndsAt === 'number' && (!selfhost || billing.data.workspace.trialEndsAt === 0), 'usage API has a numeric no-expiry value on either database')
  const usage = await http('/v1/usage', 'GET', undefined, keys.readKey)
  check(usage.status === 200 && usage.data.every((meter: any) => selfhost ? meter.limit === null : typeof meter.limit === 'number'), 'native HQ read-key contract preserves uncapped null limits')
  check(usage.data.find((meter: any) => meter.meter === 'conversations').used === (selfhost ? 122 : 11), 'HQ usage reports actual metered work rather than pretending uncapped means zero usage')
  if (selfhost) {
    // Seed only the counter boundary; this is not a 100 GB filesystem/load qualification.
    await query('UPDATE support_workspaces SET storage_bytes = 100000000000 WHERE id = ?', [workspace.id])
    const form = new FormData(); form.set('file', new File(['X'], 'counter-boundary.txt', { type: 'text/plain' })); form.set('idempotencyKey', 'uncapped-storage-boundary')
    const uploaded = await fetch(base + `${agent}/conversations/${firstId}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${token}`, cookie, 'x-csrf-token': csrf }, body: form })
    check(uploaded.status === 201 && Number((await one('SELECT storage_bytes FROM support_workspaces WHERE id = ?', [workspace.id]))!.storage_bytes) === 100000000001, 'native private-byte reservation can cross hosted storage ceilings in selfhost mode')
  }
  const license = await http(`/support/workspaces/${workspace.id}/enterprise`, 'GET', undefined, token)
  check(license.status === 200 && license.data.license.status === 'missing', 'MIT selfhost mode does not manufacture a commercial Enterprise entitlement')
  const enterprise = await http(`/support/workspaces/${workspace.id}/enterprise/provider`, 'POST', { protocol: 'oidc', issuer: 'https://identity.example.test', clientId: 'fixture', clientSecret: 'fixture' }, token)
  check(enterprise.status === 402, 'commercial identity features still require their separate signed license')
  const subscriptionPath = `/support/workspaces/${workspace.id}/subscription`
  const subscription = await http(subscriptionPath, 'GET', undefined, token)
  check(subscription.status === 200 && subscription.data.deploymentMode === (selfhost ? 'selfhost' : 'hosted') && subscription.data.checkoutAvailable === !selfhost, 'selfhost suppresses hosted checkout even when Stripe is configured')
  if (selfhost) {
    const subscribe = await http(subscriptionPath + '/checkout', 'POST', { plan: 'enterprise', idempotencyKey: 'must-not-buy-hosted' }, token)
    check(subscribe.status === 409 && subscribe.data.error.code === 'hosted_subscription_unavailable' && externalCreates === 0, 'backend rejects hosted subscription attempts before any external provider call')
    check((await http(subscriptionPath + '/portal', 'POST', {}, token)).status === 409, 'selfhost does not open the hosted billing portal')
  }
  const walletPath = `/support/workspaces/${workspace.id}/wallet`, reservePath = `/_selfhost/wallet/${workspace.id}/${project.public_id}/${firstId}`
  check((await http(reservePath, 'POST', { operationKey: 'unfunded', amountCents: 1 }, token)).data.error.code === 'wallet_exhausted', 'selfhost core never bypasses managed paid-operation credit checks')
  const checkout = await http(walletPath + '/checkout', 'POST', { amountCents: 2000, idempotencyKey: 'operator-topup' }, token)
  check(checkout.status === 200 && externalCreates === 1 && (await http(walletPath, 'GET', undefined, token)).data.balanceCents === 0, 'real wallet checkout intent does not grant credit before provider payment')
  const event = { id: 'evt_selfhost_paid', type: 'checkout.session.completed', data: { object: { ...sessions.values().next().value, currency: 'usd', payment_status: 'paid', payment_intent: 'pi_selfhost_fixture' } } }
  check((await http('/billing/stripe/webhook', 'POST', event, undefined, { 'stripe-signature': 'invalid' })).status === 400 && (await http(walletPath, 'GET', undefined, token)).data.balanceCents === 0, 'invalid payment signatures cannot create selfhost wallet funds')
  const timestamp = Math.floor(Date.now() / 1000), signature = `t=${timestamp},v1=${createHmac('sha256', 'whsec_selfhost_fixture').update(`${timestamp}.${JSON.stringify(event)}`).digest('hex')}`
  check((await http('/billing/stripe/webhook', 'POST', event, undefined, { 'stripe-signature': signature })).status === 200 && (await http(walletPath, 'GET', undefined, token)).data.balanceCents === 2000, 'native signed payment validation credits the real local wallet ledger')
  check((await http(reservePath, 'POST', { operationKey: 'disabled-cap', amountCents: 1 }, token)).data.error.code === 'wallet_limit', 'positive credit does not bypass disabled managed spending ceilings')
  await http(walletPath + '/limits', 'POST', { dailyLimitCents: 100, monthlyLimitCents: 200 }, token)
  check((await http(reservePath, 'POST', { operationKey: 'funded-bounded', amountCents: 100 }, token)).status === 201, 'funded paid work still reserves atomically within configured caps')
  check((await http(reservePath, 'POST', { operationKey: 'daily-overflow', amountCents: 1 }, token)).data.error.code === 'wallet_limit', 'daily spending cap still refuses an extra paid reservation')
  await query('UPDATE support_workspaces SET trial_ends_at = ? WHERE id = ?', [Date.now() - 1, workspace.id])
  const afterDeadline = await http(`/v1/projects/${project.public_id}/conversations`, 'POST', { externalId: 'operator-customer', subject: 'After the trial date', body: 'Source', idempotencyKey: 'after-trial-date' }, keys.ingestKey)
  check(afterDeadline.status === (selfhost ? 201 : 402), 'selfhost does not acquire a trial expiry; default hosted mode still enforces its deadline')
  check((await http(`/v1/projects/${project.public_id}/conversations/${firstId}/messages`, 'POST', { body: 'Existing thread reply', visibility: 'public', idempotencyKey: 'existing-thread-after-deadline' }, keys.ingestKey)).status === 201, 'existing-thread replies retain their separate access behavior')
  console.log(`PASS selfhost operator HTTP (${selfhost ? 'selfhost' : 'default hosted'}, ${checks} checks)`)
}
finally { server.stop(true) }
