import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { stripe } from '@stacksjs/payments'
import { one } from '../../app/Support/database'
import { managedCostCents, reserveWallet, settleWallet } from '../../app/Support/billing'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
let calls = 0
const sessions = new Map<string, { id: string, url: string, metadata: Record<string, string>, client_reference_id: string, amount_total: number }>()
// Replace only the external provider request. Signature verification is the real native Stripe SDK.
stripe.checkout.sessions.create = (async (input: any, options: any) => {
  assert.match(options.idempotencyKey, /^hq-support:wallet:/)
  calls++
  const session = { id: 'cs_fixture', url: 'https://checkout.stripe.com/fixture', metadata: input.metadata, client_reference_id: input.client_reference_id, amount_total: input.line_items[0].price_data.unit_amount }
  sessions.set(session.id, session)
  return session
}) as typeof stripe.checkout.sessions.create
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
  await request('/register', 'POST', { name: 'Billing Owner', email: 'billing@example.test', password: 'SecureSupport2026!', password_confirmation: 'SecureSupport2026!' })
  const login = await request('/login', 'POST', { email: 'billing@example.test', password: 'SecureSupport2026!' })
  const token = login.data.token ?? login.data.access_token ?? login.data.data?.token
  assert.equal(typeof token, 'string')
  const created = await request('/support/workspaces', 'POST', { name: 'Billing team' }, token)
  assert.equal(created.status, 201)
  const workspaceId = created.data.workspace.id
  const path = `/support/workspaces/${workspaceId}/wallet`
  assert.equal((await request(path, 'GET')).status, 401)
  assert.equal((await request(path + '/checkout', 'POST', { amountCents: 1999, idempotencyKey: 'small' }, token)).status, 422)
  const checkout = await request(path + '/checkout', 'POST', { amountCents: 2000, idempotencyKey: 'topup-1' }, token)
  assert.equal(checkout.status, 200, JSON.stringify(checkout.data))
  assert.equal((await request(path + '/checkout', 'POST', { amountCents: 2000, idempotencyKey: 'topup-1' }, token)).data.url, checkout.data.url)
  assert.equal(calls, 1)
  assert.equal((await request(path + '/checkout', 'POST', { amountCents: 3000, idempotencyKey: 'topup-1' }, token)).status, 409)
  assert.equal((await request(path, 'GET', undefined, token)).data.balanceCents, 0, 'checkout redirect never grants credit')
  const session = sessions.get('cs_fixture')!
  const event = { id: 'evt_paid', type: 'checkout.session.completed', data: { object: { ...session, currency: 'usd', payment_status: 'paid', payment_intent: 'pi_fixture' } } }
  assert.equal((await request('/billing/stripe/webhook', 'POST', event, undefined, { 'stripe-signature': 'bad' })).status, 400)
  const paid = await webhook(event)
  assert.equal(paid.status, 200, JSON.stringify(paid.data))
  assert.equal((await webhook(event)).status, 200)
  assert.equal((await webhook({ ...event, id: 'evt_second_notification' })).status, 200)
  assert.equal((await request(path, 'GET', undefined, token)).data.balanceCents, 2000)
  const foreignPayment = await webhook({ ...event, id: 'evt_other_hq_product', data: { object: { ...event.data.object, metadata: { service: 'commshq' } } } })
  assert.equal(foreignPayment.status, 200)
  assert.equal(foreignPayment.data.ignored, true)
  assert.equal((await request(path, 'GET', undefined, token)).data.balanceCents, 2000)
  const results = await Promise.allSettled([reserveWallet(workspaceId, 'sms-1', 1200, 'twilio'), reserveWallet(workspaceId, 'sms-2', 1200, 'twilio')])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'concurrent reservations never overspend')
  const reservation = results.find(result => result.status === 'fulfilled')!
  assert.equal(reservation.status, 'fulfilled')
  if (reservation.status !== 'fulfilled') throw new Error('Expected reservation')
  assert.equal(Number((await one('SELECT wallet_cents FROM support_workspaces WHERE id = ?', [workspaceId]))!.wallet_cents), 800)
  await settleWallet(workspaceId, String(reservation.value.public_id), 1000, 'provider-receipt')
  await settleWallet(workspaceId, String(reservation.value.public_id), 1000, 'provider-receipt')
  assert.equal((await request(path, 'GET', undefined, token)).data.balanceCents, 1000)
  await assert.rejects(settleWallet(workspaceId, String(reservation.value.public_id), 900, 'changed-receipt'))
  const refund = { id: 'evt_refund', type: 'charge.refunded', data: { object: { id: 'ch_fixture', payment_intent: 'pi_fixture', amount_refunded: 800 } } }
  assert.equal((await webhook(refund)).status, 200)
  assert.equal((await webhook(refund)).status, 200)
  assert.equal((await request(path, 'GET', undefined, token)).data.balanceCents, 200)
  assert.equal(managedCostCents(101), 117, '15% provider margin rounds once in cents')
  console.info('PASS support billing')
}
finally { server.stop(true) }
