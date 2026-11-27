import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { stripe } from '@stacksjs/payments'
import { insert, one, query } from '../../app/Support/database'
import { managedCostCents, managedCostFromMicros, reserveWallet, settleProviderWallet, settleWallet } from '../../app/Support/billing'

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
  const workspaceId = Number(created.data.workspace.id)
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
  await assert.rejects(reserveWallet(workspaceId, 'unconfigured-cap', 1, 'twilio'), /spending ceilings/)
  assert.equal((await request(path + '/limits', 'POST', { dailyLimitCents: 10000, monthlyLimitCents: 20000 }, token)).status, 200)
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
  assert.equal(managedCostFromMicros(7900), 1, 'fractional provider cents receive margin before a single rounding')
  const fractional = await reserveWallet(workspaceId, 'fractional-cost', 100, 'twilio')
  await settleProviderWallet(workspaceId, String(fractional.public_id), 7900, 'fractional-receipt')
  await settleProviderWallet(workspaceId, String(fractional.public_id), 7900, 'fractional-receipt')
  await assert.rejects(settleProviderWallet(workspaceId, String(fractional.public_id), 7901, 'fractional-receipt'), /cost changed/)
  assert.equal((await request(path, 'GET', undefined, token)).data.balanceCents, 199)
  assert.equal((await request(path + '/limits', 'POST', { dailyLimitCents: 1002, monthlyLimitCents: 1002 }, token)).status, 200)
  const capped = await Promise.allSettled([reserveWallet(workspaceId, 'cap-final-a', 1, 'twilio'), reserveWallet(workspaceId, 'cap-final-b', 1, 'twilio')])
  assert.equal(capped.filter(result => result.status === 'fulfilled').length, 1, 'concurrent final ceiling slot is exact even with sufficient wallet balance')
  assert.equal((await request(path, 'GET', undefined, token)).data.spending.dailyCents, 1002)
  await request(path + '/limits', 'POST', { dailyLimitCents: 5000, monthlyLimitCents: 5000 }, token)
  const beforeMicroOperations = (await request(path, 'GET', undefined, token)).data.balanceCents
  for (let index = 0; index < 4; index++) {
    const held = await reserveWallet(workspaceId, `micro-operation-${index}`, 1, 'twilio')
    const settled = await settleProviderWallet(workspaceId, String(held.public_id), 100, `micro-receipt-${index}`)
    assert.equal(settled.status, 'settled')
    assert.equal(Number(settled.actual_cents), 0, 'fine-grained usage aggregates before monthly cents rounding')
  }
  assert.equal((await request(path, 'GET', undefined, token)).data.balanceCents, beforeMicroOperations)
  const bucket = (await one("SELECT * FROM support_provider_cost_buckets WHERE workspace_id = ? AND provider = 'twilio'", [workspaceId]))!
  assert.equal(Number(bucket.provider_cost_micros), 8300)
  assert.equal(Number(bucket.charged_cents), 1)
  const duplicateReceipt = await reserveWallet(workspaceId, 'duplicate-provider-receipt', 1, 'twilio')
  await assert.rejects(settleProviderWallet(workspaceId, String(duplicateReceipt.public_id), 100, 'micro-receipt-0'), /another operation/)
  assert.equal((await one('SELECT status FROM support_wallet_reservations WHERE id = ?', [duplicateReceipt.id]))!.status, 'reserved', 'conflicting receipts retain the unresolved reservation')
  assert.equal(Number((await one('SELECT provider_cost_micros FROM support_provider_cost_buckets WHERE id = ?', [bucket.id]))!.provider_cost_micros), 8300, 'a receipt cannot enter two operations in the provider aggregate')

  const capWorkspace = (await request('/support/workspaces', 'POST', { name: 'Project ceilings' }, token)).data.workspace
  const capId = Number(capWorkspace.id)
  await query("UPDATE support_workspaces SET plan = 'selfhost', wallet_cents = 2000 WHERE id = ?", [capId])
  await request(`/support/workspaces/${capId}/wallet/limits`, 'POST', { dailyLimitCents: 500, monthlyLimitCents: 500 }, token)
  const projects = `/support/workspaces/${capId}/projects`
  const firstProject = (await request(projects, 'POST', { name: 'Capped channel project' }, token)).data.project
  const siblingProject = (await request(projects, 'POST', { name: 'Sibling channel project' }, token)).data.project
  const firstId = Number(firstProject.id), siblingId = Number(siblingProject.id)
  const firstWallet = `/support/projects/${firstProject.public_id}/wallet`
  const siblingWallet = `/support/projects/${siblingProject.public_id}/wallet`
  assert.equal((await request(firstWallet, 'GET')).status, 401)
  assert.equal((await request(firstWallet, 'GET', undefined, token)).data.dailyLimitCents, null)
  assert.equal((await request(firstWallet + '/limits', 'POST', { dailyLimitCents: 201, monthlyLimitCents: 200 }, token)).status, 422)
  assert.equal((await request(firstWallet + '/limits', 'POST', { dailyLimitCents: 200, monthlyLimitCents: 500 }, token)).status, 200)
  const agentEmail = 'billing-agent@example.test', agentPassword = 'BillingAgent2026!'
  await request('/register', 'POST', { name: 'Billing fixture agent', email: agentEmail, password: agentPassword, password_confirmation: agentPassword })
  const agent = await one('SELECT id FROM users WHERE email = ?', [agentEmail])
  assert.ok(agent)
  await insert('support_memberships', { workspace_id: capId, user_id: agent.id, email: agentEmail, role: 'agent', status: 'active' })
  const agentSession = (await request('/login', 'POST', { email: agentEmail, password: agentPassword })).data
  const agentToken = agentSession.token ?? agentSession.access_token
  assert.equal((await request(firstWallet + '/limits', 'POST', { dailyLimitCents: 0, monthlyLimitCents: null }, agentToken)).status, 403)
  assert.equal((await request(firstWallet, 'GET', undefined, agentToken)).status, 403)
  const agentProjects = (await request('/support/me', 'GET', undefined, agentToken)).data.projects
  assert.ok(agentProjects.some(project => project.public_id === firstProject.public_id))
  assert.ok(!JSON.stringify(agentProjects).includes('managed_daily_cap_cents'), 'project listing keeps the budget private from an ordinary agent')
  const legacy = await reserveWallet(capId, 'legacy-cost', 15, 'email')
  const scoped = await Promise.allSettled([reserveWallet(capId, 'project-first-a', 100, 'email', firstId), reserveWallet(capId, 'project-first-b', 100, 'email', firstId)])
  assert.equal(scoped.filter(result => result.status === 'fulfilled').length, 1)
  const held = scoped.find(result => result.status === 'fulfilled')!.value
  assert.equal(Number(held.project_id), firstId)
  assert.equal((await request(firstWallet, 'GET', undefined, token)).data.spending.dailyCents, 115)
  await reserveWallet(capId, 'sibling-operation', 100, 'email', siblingId)
  assert.equal((await request(firstWallet, 'GET', undefined, token)).data.spending.dailyCents, 115, 'sibling usage does not use this project ceiling')
  assert.equal((await request(siblingWallet, 'GET', undefined, token)).data.dailyLimitCents, null)
  assert.equal((await request(siblingWallet, 'GET', undefined, token)).data.spending.dailyCents, 115)
  await assert.rejects(reserveWallet(capId, String(held.operation_key), 100, 'email', siblingId), /Reservation input changed/)
  await request(firstWallet + '/limits', 'POST', { dailyLimitCents: 0, monthlyLimitCents: null }, token)
  assert.equal((await reserveWallet(capId, String(held.operation_key), 100, 'email', firstId)).public_id, held.public_id)
  await assert.rejects(reserveWallet(capId, 'project-paused', 1, 'email', firstId), /ceiling for this project/)
  await settleWallet(capId, String(held.public_id), 50, 'scoped-delivery')
  assert.equal((await request(firstWallet, 'GET', undefined, token)).data.spending.dailyCents, 65)
  await query('UPDATE support_wallet_reservations SET created_at = ? WHERE id = ?', [new Date(Date.now() - 40 * 86400000).toISOString(), legacy.id])
  assert.equal((await request(firstWallet, 'GET', undefined, token)).data.spending.monthlyCents, 50, 'unassigned usage leaves the project window when it expires')
  await request(firstWallet + '/limits', 'POST', { dailyLimitCents: 500, monthlyLimitCents: null }, token)
  await assert.rejects(reserveWallet(capId, 'workspace-ceiling-project', 400, 'email', firstId), /managed-channel spending ceiling has been reached/)
  await assert.rejects(reserveWallet(workspaceId, 'foreign-wallet-project', 1, 'email', firstId), /Project not found/)
  console.info('PASS support billing')
}
finally { server.stop(true) }
