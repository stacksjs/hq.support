import { env } from '@stacksjs/env'
import { stripe, isStripeConfigured } from '@stacksjs/payments'
import { insert, one, query, workspaceTransaction } from './database'
import type { Row } from './database'
import { fail, text } from './errors'
import { plans } from './limits'
import { member, workspace } from './service'

type PaidPlan = 'starter' | 'growth' | 'enterprise'
function paidPlan(value: unknown): PaidPlan {
  if (value !== 'starter' && value !== 'growth' && value !== 'enterprise') fail(422, 'invalid_plan', 'Select a hosted paid plan.')
  return value
}
function amount(plan: PaidPlan, interval: string) { return interval === 'year' ? plans[plan].annualCents : plans[plan].monthlyCents }
function available() {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET || !isStripeConfigured()) fail(503, 'billing_unavailable', 'Billing is not configured.')
}
function returnUrl() { return String(env.APP_URL || 'https://hq.support').replace(/\/$/, '') }

export async function subscriptionOverview(userId: number, workspaceId: number) {
  await member(userId, workspaceId, ['owner', 'admin'])
  const current = await one('SELECT * FROM support_subscriptions WHERE workspace_id = ?', [workspaceId])
  const checkout = current?.status === 'pending' ? await one('SELECT url, plan, interval, operation_key FROM support_billing_checkouts WHERE public_id = ? AND workspace_id = ?', [current.checkout_id, workspaceId]) : undefined
  return { subscription: current ? { status: current.status, plan: current.plan, interval: current.interval, current_period_end: current.current_period_end, cancel_at_period_end: current.cancel_at_period_end } : null,
    pendingCheckout: checkout ? { url: checkout.url || null, plan: checkout.plan, interval: checkout.interval, operationKey: checkout.operation_key } : null,
    portalAvailable: Boolean(current?.provider_customer && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
    plans: { starter: plans.starter, growth: plans.growth, enterprise: plans.enterprise }, checkoutAvailable: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) }
}

/** Checkout prepares payment only; entitlement follows a signed event and fresh provider read. */
export async function createSubscriptionCheckout(userId: number, workspaceId: number, input: Row) {
  await member(userId, workspaceId, ['owner', 'admin'])
  available()
  const plan = paidPlan(input.plan)
  const interval = input.interval === undefined ? 'month' : input.interval
  if (interval !== 'month' && interval !== 'year') fail(422, 'invalid_interval', 'Select monthly or annual billing.')
  const operation = text(input.idempotencyKey, 'idempotencyKey')
  const pending = await workspaceTransaction(workspaceId, async () => {
    const previous = await one('SELECT * FROM support_billing_checkouts WHERE workspace_id = ? AND operation_key = ?', [workspaceId, operation])
    if (previous) {
      if (previous.kind !== 'subscription' || previous.plan !== plan || previous.interval !== interval) fail(409, 'idempotency_conflict', 'This key belongs to a different checkout.')
      return previous
    }
    const current = await one('SELECT * FROM support_subscriptions WHERE workspace_id = ?', [workspaceId])
    if (current && !['canceled', 'incomplete_expired'].includes(String(current.status))) fail(409, 'subscription_exists', 'Manage the existing subscription before opening another checkout.')
    const checkout = await insert('support_billing_checkouts', { workspace_id: workspaceId, public_id: crypto.randomUUID(), operation_key: operation, kind: 'subscription', plan, interval, amount_cents: amount(plan, interval) })
    if (current) await query("UPDATE support_subscriptions SET checkout_id = ?, provider_id = '', status = 'pending', plan = ?, interval = ?, sync_version = sync_version + 1, updated_at = ? WHERE id = ?", [checkout.public_id, plan, interval, new Date().toISOString(), current.id])
    else await insert('support_subscriptions', { workspace_id: workspaceId, checkout_id: checkout.public_id, plan, interval })
    return checkout
  })
  if (pending.url) return { id: pending.public_id, url: pending.url }
  if (Date.now() - Date.parse(String(pending.created_at)) > 23 * 3600000) fail(409, 'checkout_uncertain', 'Reconcile the existing checkout before creating another.')
  const metadata = { service: 'supporthq', checkout_id: String(pending.public_id), workspace_id: String(workspaceId) }
  let session
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'subscription', client_reference_id: String(workspaceId), metadata,
      subscription_data: { metadata },
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: amount(plan, interval), recurring: { interval }, product_data: { name: `HQ.support ${plan}` } } }],
      success_url: `${returnUrl()}/app/usage?billing=success`, cancel_url: `${returnUrl()}/app/usage?billing=cancelled`,
    }, { idempotencyKey: `hq-support:subscription:${pending.public_id}` })
  }
  catch { fail(503, 'checkout_uncertain', 'Checkout is unavailable. Retry with the same operation key.') }
  if (!session.url || !session.url.startsWith('https://')) fail(502, 'billing_unavailable', 'Checkout could not be opened.')
  await workspaceTransaction(workspaceId, async () => {
    const current = (await one('SELECT * FROM support_billing_checkouts WHERE id = ?', [pending.id]))!
    if (current.provider_session && current.provider_session !== session.id) fail(409, 'checkout_uncertain', 'Provider returned a conflicting checkout.')
    await query('UPDATE support_billing_checkouts SET provider_session = ?, url = ?, status = ?, updated_at = ? WHERE id = ?', [session.id, session.url, current.status === 'paid' ? 'paid' : 'open', new Date().toISOString(), current.id])
  })
  return { id: pending.public_id, url: session.url }
}

export async function subscriptionPortal(userId: number, workspaceId: number) {
  await member(userId, workspaceId, ['owner', 'admin'])
  available()
  const current = await one('SELECT * FROM support_subscriptions WHERE workspace_id = ?', [workspaceId])
  if (!current?.provider_customer) fail(409, 'subscription_required', 'Complete a subscription checkout first.')
  const session = await stripe.billingPortal.sessions.create({ customer: String(current.provider_customer), return_url: `${returnUrl()}/app/usage` })
  return { url: session.url }
}

/** Out-of-order webhooks trigger canonical reads. A generation prevents stale in-flight reads overwriting newer ones. */
export async function applySubscriptionEvent(event: { id: string, type: string, object: Row }, fingerprint: string): Promise<boolean> {
  const metadata = event.object.metadata as Row | undefined
  const checkoutEvent = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)
  const expiredCheckout = event.type === 'checkout.session.expired'
  const subscriptionEvent = event.type.startsWith('customer.subscription.')
  if (!checkoutEvent && !subscriptionEvent && !expiredCheckout) return false
  const checkout = checkoutEvent || expiredCheckout
    ? await one("SELECT * FROM support_billing_checkouts WHERE public_id = ? AND kind = 'subscription'", [metadata?.checkout_id ?? ''])
    : undefined
  let current = checkout
    ? await one('SELECT * FROM support_subscriptions WHERE workspace_id = ?', [checkout.workspace_id])
    : subscriptionEvent ? await one('SELECT * FROM support_subscriptions WHERE provider_id = ?', [event.object.id]) : undefined
  if (!current || (checkout && current.checkout_id !== checkout.public_id)) return false
  if (metadata?.service !== 'supporthq') fail(422, 'payment_mismatch', 'Subscription attribution does not match.')
  const workspaceId = Number(current.workspace_id)
  if (checkoutEvent && event.object.payment_status !== 'paid') return true
  if (expiredCheckout) {
    await workspaceTransaction(workspaceId, async () => {
      const fresh = (await one('SELECT * FROM support_subscriptions WHERE workspace_id = ?', [workspaceId]))!
      if (fresh.status !== 'pending' || fresh.checkout_id !== checkout!.public_id) return
      await query("UPDATE support_subscriptions SET status = 'incomplete_expired', sync_version = sync_version + 1, updated_at = ? WHERE id = ?", [new Date().toISOString(), fresh.id])
      await insert('support_payment_events', { workspace_id: workspaceId, provider_event_id: event.id, digest: fingerprint, kind: event.type })
    })
    return true
  }
  const providerId = checkoutEvent ? event.object.subscription : current.provider_id
  if (typeof providerId !== 'string' || !providerId.startsWith('sub_')) fail(422, 'payment_mismatch', 'Subscription reference is missing.')
  if (checkout && ((checkout.provider_session && checkout.provider_session !== event.object.id) || event.object.client_reference_id !== String(workspaceId))) fail(422, 'payment_mismatch', 'Checkout does not match the workspace.')
  const version = await workspaceTransaction(workspaceId, async () => {
    const fresh = (await one('SELECT * FROM support_subscriptions WHERE workspace_id = ?', [workspaceId]))!
    if (fresh.checkout_id !== current!.checkout_id || (fresh.provider_id && fresh.provider_id !== providerId)) fail(409, 'subscription_conflict', 'The workspace subscription has changed.')
    const next = Number(fresh.sync_version) + 1
    await query('UPDATE support_subscriptions SET sync_version = ? WHERE id = ?', [next, fresh.id])
    return next
  })
  // Server credentials stay in the native payments client. Failed reads are retried by provider delivery.
  const canonical = await stripe.subscriptions.retrieve(providerId)
  if (canonical.metadata.service !== 'supporthq' || canonical.metadata.checkout_id !== current.checkout_id || canonical.metadata.workspace_id !== String(workspaceId)) fail(422, 'payment_mismatch', 'Subscription does not match the server-created checkout.')
  const item = canonical.items.data[0]
  const plan = paidPlan(current.plan)
  if (canonical.items.data.length !== 1 || item?.quantity !== 1 || item.price.currency !== 'usd' || item.price.unit_amount !== amount(plan, String(current.interval)) || item.price.recurring?.interval !== current.interval || item.price.recurring?.interval_count !== 1)
    fail(422, 'payment_mismatch', 'Subscription price does not match the selected plan.')
  const customer = typeof canonical.customer === 'string' ? canonical.customer : canonical.customer.id
  const periodEnd = Number(item.current_period_end) * 1000
  if (!Number.isSafeInteger(periodEnd)) fail(422, 'payment_mismatch', 'Subscription period is invalid.')
  const entitled = canonical.status === 'active' && periodEnd > Date.now()
  await workspaceTransaction(workspaceId, async () => {
    const fresh = (await one('SELECT * FROM support_subscriptions WHERE workspace_id = ?', [workspaceId]))!
    if (Number(fresh.sync_version) !== version) return
    if (await one('SELECT id FROM support_payment_events WHERE provider_event_id = ?', [event.id])) return
    const owner = await workspace(workspaceId)
    const fallback = owner.free_qualified_at && owner.stacks_verified && owner.deployment_verified ? 'free' : 'trial'
    await query('UPDATE support_subscriptions SET provider_id = ?, provider_customer = ?, status = ?, current_period_end = ?, cancel_at_period_end = ?, updated_at = ? WHERE id = ?', [canonical.id, customer, canonical.status, periodEnd, canonical.cancel_at_period_end, new Date().toISOString(), fresh.id])
    await query('UPDATE support_workspaces SET plan = ?, updated_at = ? WHERE id = ?', [entitled ? plan : fallback, new Date().toISOString(), workspaceId])
    if (checkout && entitled) await query("UPDATE support_billing_checkouts SET status = 'paid', provider_subscription = ?, provider_customer = ?, updated_at = ? WHERE id = ?", [providerId, customer, new Date().toISOString(), checkout.id])
    await insert('support_payment_events', { workspace_id: workspaceId, provider_event_id: event.id, digest: fingerprint, kind: event.type })
  })
  return true
}
