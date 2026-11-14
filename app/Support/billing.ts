import { env } from '@stacksjs/env'
import { insert, one, query, workspaceTransaction } from './database'
import type { Row } from './database'
import { digest, member, workspace } from './service'
import { fail, text } from './errors'
import { billingPolicy } from './limits'

export interface BillingGateway {
  checkout: (input: { checkoutId: string, amountCents: number, workspaceId: string, returnUrl: string }) => Promise<{ id: string, url: string }>
  event: (raw: string, signature: string) => Promise<{ id: string, type: string, object: Row }>
}

let configuredGateway: BillingGateway | undefined
/** Server bootstrap/test seam for the external payment provider; never a browser setting. */
export function configureBillingGateway(gateway?: BillingGateway): void { configuredGateway = gateway }

async function gateway(): Promise<BillingGateway> {
  if (configuredGateway) return configuredGateway
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) fail(503, 'billing_unavailable', 'Billing is not configured.')
  const { stripe, isStripeConfigured } = await import('@stacksjs/payments')
  if (!isStripeConfigured()) fail(503, 'billing_unavailable', 'Billing is not configured.')
  return {
    async checkout(input) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment', client_reference_id: input.workspaceId,
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: input.amountCents, product_data: { name: 'HQ.support communications credit' } } }],
        metadata: { service: 'supporthq', checkout_id: input.checkoutId },
        payment_intent_data: { metadata: { service: 'supporthq', checkout_id: input.checkoutId } },
        success_url: `${input.returnUrl}/inbox?billing=success`, cancel_url: `${input.returnUrl}/inbox?billing=cancelled`,
      }, { idempotencyKey: `hq-support:wallet:${input.checkoutId}` })
      if (!session.url) fail(502, 'billing_unavailable', 'Checkout could not be opened.')
      return { id: session.id, url: session.url }
    },
    async event(raw, signature) {
      try {
        const event = await stripe.webhooks.constructEventAsync(raw, signature, String(env.STRIPE_WEBHOOK_SECRET))
        return { id: event.id, type: event.type, object: event.data.object as unknown as Row }
      }
      catch { fail(400, 'invalid_signature', 'Payment signature could not be verified.') }
    },
  }
}

function cents(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > 100_000_000)
    fail(422, 'invalid_amount', 'A valid whole number of USD cents is required.')
  return value
}

function balance(row: Row): number {
  const value = Number(row.wallet_cents)
  if (!Number.isSafeInteger(value)) fail(503, 'wallet_unavailable', 'Wallet balance could not be read.')
  return value
}

async function entry(workspaceId: number, reference: string, kind: string, amount: number, provider = '', providerReference = '') {
  const current = await workspace(workspaceId)
  const next = balance(current) + amount
  if (!Number.isSafeInteger(next)) fail(503, 'wallet_unavailable', 'Wallet amount is outside the supported range.')
  await query('UPDATE support_workspaces SET wallet_cents = ?, updated_at = ? WHERE id = ?', [next, new Date().toISOString(), workspaceId])
  return await insert('support_wallet_entries', { workspace_id: workspaceId, reference, kind, amount_cents: amount, balance_cents: next, provider, provider_reference: providerReference })
}

export async function walletOverview(userId: number, workspaceId: number) {
  await member(userId, workspaceId, ['owner', 'admin'])
  const current = await workspace(workspaceId)
  return {
    balanceCents: balance(current), currency: 'usd', minimumTopupCents: billingPolicy.minimumWalletTopupCents,
    checkoutAvailable: Boolean(configuredGateway || (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET)),
    autoTopupEnabled: false,
    entries: await query('SELECT reference, kind, amount_cents, balance_cents, provider, provider_reference, created_at FROM support_wallet_entries WHERE workspace_id = ? ORDER BY id DESC LIMIT 100', [workspaceId]),
  }
}

export async function createWalletCheckout(userId: number, workspaceId: number, input: Row) {
  await member(userId, workspaceId, ['owner', 'admin'])
  const amount = cents(input.amountCents, billingPolicy.minimumWalletTopupCents)
  if (amount > 100_000) fail(422, 'invalid_amount', 'Top up at most $1,000 at a time.')
  const operation = text(input.idempotencyKey, 'idempotencyKey')
  const provider = await gateway()
  const pending = await workspaceTransaction(workspaceId, async () => {
    const existing = await one('SELECT * FROM support_billing_checkouts WHERE workspace_id = ? AND operation_key = ?', [workspaceId, operation])
    if (existing) {
      if (Number(existing.amount_cents) !== amount || existing.kind !== 'topup') fail(409, 'idempotency_conflict', 'This key belongs to a different checkout.')
      return existing
    }
    return await insert('support_billing_checkouts', { workspace_id: workspaceId, public_id: crypto.randomUUID(), operation_key: operation, kind: 'topup', amount_cents: amount })
  })
  if (pending.url) return { id: pending.public_id, url: pending.url }
  // Stripe retains idempotency for at least 24h; older uncertain operations need reconciliation.
  if (Date.now() - Date.parse(String(pending.created_at)) > 23 * 3600000) fail(409, 'checkout_uncertain', 'Reconcile the existing checkout before creating another.')
  const returnUrl = String(env.APP_URL || 'https://hq.support').replace(/\/$/, '')
  let created: { id: string, url: string }
  try { created = await provider.checkout({ checkoutId: String(pending.public_id), amountCents: amount, workspaceId: String(workspaceId), returnUrl }) }
  catch { fail(503, 'checkout_uncertain', 'Checkout is temporarily unavailable. Retry with the same idempotency key.') }
  if (!created.id || !/^https:\/\//.test(created.url)) fail(502, 'billing_unavailable', 'Checkout returned an invalid response.')
  await workspaceTransaction(workspaceId, async () => {
    const fresh = await one('SELECT * FROM support_billing_checkouts WHERE id = ?', [pending.id])
    if (fresh?.provider_session && fresh.provider_session !== created.id) fail(409, 'checkout_uncertain', 'Provider returned a conflicting checkout.')
    await query('UPDATE support_billing_checkouts SET provider_session = ?, url = ?, status = ?, updated_at = ? WHERE id = ?', [created.id, created.url, fresh?.status === 'paid' ? 'paid' : 'open', new Date().toISOString(), pending.id])
  })
  return { id: pending.public_id, url: created.url }
}

/** Credit only a signed, paid provider event matching a server-created checkout. */
export async function receivePayment(raw: string, signature: string) {
  if (raw.length > 1_000_000 || !signature) fail(400, 'invalid_signature', 'Payment signature is required.')
  const event = await (await gateway()).event(raw, signature)
  const fingerprint = digest(raw)
  const previous = await one('SELECT * FROM support_payment_events WHERE provider_event_id = ?', [event.id])
  if (previous) {
    if (previous.digest !== fingerprint) fail(409, 'event_conflict', 'Provider event changed.')
    return { received: true }
  }
  const { applySubscriptionEvent } = await import('./subscriptions')
  if (await applySubscriptionEvent(event, fingerprint)) return { received: true }
  const paid = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)
  const refunded = event.type === 'charge.refunded'
  if (!paid && !refunded) return { received: true, ignored: true }
  const metadata = event.object.metadata as Row | undefined
  // Other HQ products may share a merchant account; their signed events are not ours.
  if (paid && metadata?.service !== 'supporthq') return { received: true, ignored: true }
  const checkout = refunded
    ? await one('SELECT * FROM support_billing_checkouts WHERE provider_payment = ? AND kind = ?', [event.object.payment_intent, 'topup'])
    : await one('SELECT * FROM support_billing_checkouts WHERE public_id = ? AND kind = ?', [metadata?.checkout_id, 'topup'])
  if (!checkout) {
    if (refunded) return { received: true, ignored: true }
    fail(422, 'unknown_checkout', 'Payment checkout was not issued by this application.')
  }
  await workspaceTransaction(Number(checkout.workspace_id), async () => {
    if (await one('SELECT id FROM support_payment_events WHERE provider_event_id = ?', [event.id])) return
    const current = (await one('SELECT * FROM support_billing_checkouts WHERE id = ?', [checkout.id]))!
    if (paid) {
      if (event.object.payment_status !== 'paid') return
      if (event.object.currency !== 'usd' || Number(event.object.amount_total) !== Number(current.amount_cents)
        || (current.provider_session && current.provider_session !== event.object.id)
        || event.object.client_reference_id !== String(current.workspace_id)) fail(422, 'payment_mismatch', 'Payment does not match the checkout.')
      if (current.status !== 'paid') {
        await entry(Number(current.workspace_id), `topup:${current.public_id}`, 'topup', Number(current.amount_cents), 'stripe', String(event.object.id))
        await query("UPDATE support_billing_checkouts SET status = 'paid', provider_session = ?, provider_payment = ?, updated_at = ? WHERE id = ?", [event.object.id, typeof event.object.payment_intent === 'string' ? event.object.payment_intent : '', new Date().toISOString(), current.id])
      }
    }
    else {
      const total = cents(event.object.amount_refunded)
      if (total > Number(current.amount_cents)) fail(422, 'payment_mismatch', 'Refund exceeds checkout amount.')
      const delta = total - Number(current.refunded_cents)
      if (delta > 0) {
        // A refunded/spent balance may become debt; all new reservations fail closed.
        await entry(Number(current.workspace_id), `refund:${event.id}`, 'refund', -delta, 'stripe', String(event.object.id))
        await query('UPDATE support_billing_checkouts SET refunded_cents = ?, updated_at = ? WHERE id = ?', [total, new Date().toISOString(), current.id])
      }
    }
    await insert('support_payment_events', { workspace_id: current.workspace_id, provider_event_id: event.id, digest: fingerprint, kind: event.type })
  })
  return { received: true }
}

export async function reserveWallet(workspaceId: number, operationKey: string, amountCents: number, provider: string) {
  const amount = cents(amountCents)
  const operation = text(operationKey, 'operationKey')
  return await workspaceTransaction(workspaceId, async () => {
    const existing = await one('SELECT * FROM support_wallet_reservations WHERE workspace_id = ? AND operation_key = ?', [workspaceId, operation])
    if (existing) {
      if (Number(existing.reserved_cents) !== amount || existing.provider !== provider) fail(409, 'idempotency_conflict', 'Reservation input changed.')
      return existing
    }
    if (balance(await workspace(workspaceId)) < amount) fail(402, 'wallet_exhausted', 'Add prepaid credit before using this channel.')
    const reservation = await insert('support_wallet_reservations', { workspace_id: workspaceId, public_id: crypto.randomUUID(), operation_key: operation, provider: text(provider, 'provider'), reserved_cents: amount })
    await entry(workspaceId, `reserve:${reservation.public_id}`, 'reserve', -amount, provider)
    return reservation
  })
}

export async function settleWallet(workspaceId: number, reservationId: string, actualCents: number, providerReference: string) {
  const actual = actualCents === 0 ? 0 : cents(actualCents)
  return await workspaceTransaction(workspaceId, async () => {
    const reservation = await one('SELECT * FROM support_wallet_reservations WHERE workspace_id = ? AND public_id = ?', [workspaceId, reservationId])
    if (!reservation) fail(404, 'not_found', 'Reservation not found.')
    if (reservation.status !== 'reserved') {
      if (Number(reservation.actual_cents) !== actual || reservation.provider_reference !== providerReference) fail(409, 'settlement_conflict', 'Reservation was already settled differently.')
      return reservation
    }
    await entry(workspaceId, `settle:${reservationId}`, actual === 0 ? 'release' : 'settle', Number(reservation.reserved_cents) - actual, String(reservation.provider), text(providerReference, 'providerReference'))
    await query('UPDATE support_wallet_reservations SET status = ?, actual_cents = ?, provider_reference = ?, updated_at = ? WHERE id = ?', [actual === 0 ? 'released' : 'settled', actual, providerReference, new Date().toISOString(), reservation.id])
    return (await one('SELECT * FROM support_wallet_reservations WHERE id = ?', [reservation.id]))!
  })
}

export function managedCostCents(providerCents: number): number {
  if (providerCents === 0) return 0
  const value = cents(providerCents)
  return Math.ceil(value * (100 + billingPolicy.managedMarkupPercent) / 100)
}
