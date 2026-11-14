import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { stripe } from '@stacksjs/payments'
import { one } from '../../app/Support/database'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
let calls = 0
let selectedPlanAmount = 0
let recurringInterval = ''
let checkoutId = ''
let workspaceId = 0
let canonical: any
let delayRead = false
let releaseRead: (() => void) | undefined
stripe.checkout.sessions.create = (async (input: any, options: any) => {
  assert.match(options.idempotencyKey, /^hq-support:subscription:/)
  calls++
  assert.equal(input.mode, 'subscription')
  assert.deepEqual(input.subscription_data.metadata, input.metadata)
  assert.equal(input.metadata.service, 'supporthq')
  selectedPlanAmount = input.line_items[0].price_data.unit_amount
  recurringInterval = input.line_items[0].price_data.recurring.interval
  checkoutId = input.metadata.checkout_id
  return { id: 'cs_subscription_fixture', url: 'https://checkout.stripe.com/subscription-fixture' }
}) as typeof stripe.checkout.sessions.create
stripe.subscriptions.retrieve = (async () => {
  const snapshot = structuredClone(canonical)
  if (delayRead) {
    delayRead = false
    await new Promise<void>(resolve => { releaseRead = resolve })
  }
  return snapshot
}) as typeof stripe.subscriptions.retrieve
stripe.billingPortal.sessions.create = (async (input: any) => {
  assert.equal(input.customer, 'cus_fixture')
  return { url: 'https://billing.stripe.com/fixture' }
}) as typeof stripe.billingPortal.sessions.create
await route.importRoutes()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${server.port}/api`
let csrf = '', cookie = ''
async function request(path: string, method = 'GET', body?: unknown, token?: string, extra: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, data: await response.json(), headers: response.headers }
}
function signed(value: unknown): string {
  const timestamp = Math.floor(Date.now() / 1000)
  return `t=${timestamp},v1=${createHmac('sha256', 'whsec_local_fixture').update(`${timestamp}.${JSON.stringify(value)}`).digest('hex')}`
}
async function webhook(event: unknown) { return await request('/billing/stripe/webhook', 'POST', event, undefined, { 'stripe-signature': signed(event) }) }

try {
  const challenge = await request('/csrf-token'); csrf = challenge.data.token; cookie = challenge.headers.get('set-cookie')!.split(';')[0]!
  await request('/register', 'POST', { name: 'Subscription Owner', email: 'subscription@example.test', password: 'SecureSupport2026!', password_confirmation: 'SecureSupport2026!' })
  const login = await request('/login', 'POST', { email: 'subscription@example.test', password: 'SecureSupport2026!' })
  const token = login.data.token ?? login.data.access_token ?? login.data.data?.token
  const created = await request('/support/workspaces', 'POST', { name: 'Subscription team' }, token)
  workspaceId = created.data.workspace.id
  const path = `/support/workspaces/${workspaceId}/subscription`
  assert.equal((await request(path)).status, 401)
  assert.equal((await request(path + '/checkout', 'POST', { plan: 'free', idempotencyKey: 'invalid' }, token)).status, 422)
  const checkout = await request(path + '/checkout', 'POST', { plan: 'starter', interval: 'year', idempotencyKey: 'annual-1' }, token)
  assert.equal(checkout.status, 200, JSON.stringify(checkout.data))
  assert.equal(selectedPlanAmount, 49000, 'annual catalog uses ten monthly payments')
  assert.equal(recurringInterval, 'year')
  assert.equal((await request(path + '/checkout', 'POST', { plan: 'starter', interval: 'year', idempotencyKey: 'annual-1' }, token)).status, 200)
  assert.equal(calls, 1)
  assert.equal((await request(path + '/checkout', 'POST', { plan: 'growth', interval: 'year', idempotencyKey: 'annual-1' }, token)).status, 409)
  assert.equal((await request(path + '/checkout', 'POST', { plan: 'starter', idempotencyKey: 'second' }, token)).status, 409)
  assert.equal((await one('SELECT plan FROM support_workspaces WHERE id = ?', [workspaceId]))!.plan, 'trial')
  canonical = { id: 'sub_fixture', customer: 'cus_fixture', status: 'active', cancel_at_period_end: false,
    metadata: { service: 'supporthq', checkout_id: checkoutId, workspace_id: String(workspaceId) },
    items: { data: [{ quantity: 1, current_period_end: Math.floor(Date.now() / 1000) + 86400 * 365, price: { unit_amount: selectedPlanAmount, currency: 'usd', recurring: { interval: 'year', interval_count: 1 } } }] } }
  const event = { id: 'evt_subscription_checkout', type: 'checkout.session.completed', data: { object: { id: 'cs_subscription_fixture', metadata: canonical.metadata, client_reference_id: String(workspaceId), subscription: canonical.id, payment_status: 'paid' } } }
  const forged = { ...event, id: 'evt_subscription_forged', data: { object: { ...event.data.object, client_reference_id: 'foreign-workspace' } } }
  assert.equal((await webhook(forged)).status, 422)
  canonical.items.data[0].price.unit_amount = 1
  assert.equal((await webhook(event)).status, 422, 'signed checkout cannot grant an underpriced subscription')
  canonical.items.data[0].price.unit_amount = 49000
  const paid = await webhook(event)
  assert.equal(paid.status, 200, JSON.stringify(paid.data))
  assert.equal((await one('SELECT plan FROM support_workspaces WHERE id = ?', [workspaceId]))!.plan, 'starter')
  assert.equal((await webhook(event)).status, 200)
  assert.equal((await request(path + '/portal', 'POST', {}, token)).data.url, 'https://billing.stripe.com/fixture')
  assert.equal((await request(path, 'GET', undefined, token)).data.subscription.interval, 'year')
  const update = { id: 'evt_subscription_updated', type: 'customer.subscription.updated', data: { object: canonical } }
  delayRead = true
  const older = webhook(update)
  while (!releaseRead) await Bun.sleep(5)
  canonical = { ...canonical, status: 'canceled' }
  assert.equal((await webhook({ id: 'evt_subscription_canceled', type: 'customer.subscription.deleted', data: { object: canonical } })).status, 200)
  releaseRead()
  assert.equal((await older).status, 200)
  assert.equal((await one('SELECT plan FROM support_workspaces WHERE id = ?', [workspaceId]))!.plan, 'trial', 'old in-flight active snapshot cannot overwrite newer canceled state')
  assert.equal((await webhook({ ...update, id: 'evt_old_arriving_late' })).status, 200)
  assert.equal((await one('SELECT plan FROM support_workspaces WHERE id = ?', [workspaceId]))!.plan, 'trial', 'old provider notification refreshes current canonical state')
  console.info('PASS support subscriptions')
}
finally { server.stop(true) }
