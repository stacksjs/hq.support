import { derived, state } from '@stacksjs/stx'
import { createSupportConsole } from './console'

interface Billing { workspace: { plan: string, trialEndsAt: number, overagesEnabled: boolean, spendingCapCents: number }, limits: { conversations: number | null, conversationCeiling: number | null, ai: number | null, storageBytes: number | null, seats: number | null, projects: number | null }, usage: { conversations: number, ai: number, storageBytes: number }, checkoutAvailable: boolean }
interface Wallet { balanceCents: number, currency: string, minimumTopupCents: number, checkoutAvailable: boolean, autoTopupEnabled: boolean, dailyLimitCents: number, monthlyLimitCents: number, spending: { dailyCents: number, monthlyCents: number, period: string }, entries: { reference: string, kind: string, amount_cents: number, balance_cents: number, created_at: string }[] }
interface Subscription { deploymentMode?: 'hosted' | 'selfhost', subscription: { status: string, plan: string, interval: string, current_period_end: number, cancel_at_period_end: boolean } | null, plans: Record<string, { monthlyCents: number, annualCents: number, seats: number, conversations: number, ai: number }>, checkoutAvailable: boolean, portalAvailable?: boolean, pendingCheckout?: { url: string | null, plan: string, interval: string, operationKey: string } | null }
export function createUsage() {
  const workspace = createSupportConsole()
  const billing = state<Billing | null>(null)
  const wallet = state<Wallet | null>(null)
  const walletError = state('')
  const subscription = state<Subscription | null>(null)
  const subscriptionError = state('')
  const plan = state('starter')
  const interval = state('month')
  const subscriptionUrl = state('')
  const subscriptionChoice = state('')
  const portalUrl = state('')
  const selectedPrice = derived(() => { const item = subscription()?.plans[plan()]; return item ? interval() === 'year' ? item.annualCents : item.monthlyCents : undefined })
  const subscriptionCurrent = derived(() => subscription()?.checkoutAvailable && subscriptionUrl() && subscriptionChoice() === `${workspace.workspace()?.id}:${plan()}:${interval()}`)
  const canSubscribe = derived(() => !subscription()?.subscription || ['canceled', 'incomplete_expired'].includes(subscription()?.subscription?.status || '') || (subscription()?.subscription?.status === 'pending' && !!subscription()?.pendingCheckout))
  const amount = state('20.00')
  const dailyLimit = state('0.00')
  const monthlyLimit = state('0.00')
  const checkoutUrl = state('')
  const checkoutAmount = state('')
  const checkoutCurrent = derived(() => checkoutUrl() && amount() === checkoutAmount())
  let key = ''
  let keyedAmount = 0
  let subscriptionKey = ''
  let keyedSubscription = ''
  async function load() {
    billing.set(null)
    wallet.set(null)
    walletError.set('')
    subscription.set(null)
    subscriptionError.set('')
    subscriptionUrl.set('')
    portalUrl.set('')
    checkoutUrl.set('')
    if (!workspace.project()) return
    const selectedProject = workspace.project()
    const result = await workspace.run(async () => {
      const billing = await workspace.request(workspace.projectPath('/billing'))
      let wallet: Wallet | null = null
      let walletError = ''
      let subscription: Subscription | null = null
      let subscriptionError = ''
      if (workspace.canManage() && workspace.workspace()) {
        try { wallet = await workspace.request(`/api/support/workspaces/${workspace.workspace()!.id}/wallet`) }
        catch (failure) { walletError = failure instanceof Error ? failure.message : 'Prepaid credit could not be loaded.' }
        try { subscription = await workspace.request(`/api/support/workspaces/${workspace.workspace()!.id}/subscription`) }
        catch (failure) { subscriptionError = failure instanceof Error ? failure.message : 'Subscription could not be loaded.' }
      }
      return { billing, wallet, walletError, subscription, subscriptionError }
    })
    if (!result || selectedProject !== workspace.project()) return
    billing.set(result.billing)
    wallet.set(result.wallet)
    dailyLimit.set(((result.wallet?.dailyLimitCents || 0) / 100).toFixed(2))
    monthlyLimit.set(((result.wallet?.monthlyLimitCents || 0) / 100).toFixed(2))
    walletError.set(result.walletError)
    subscription.set(result.subscription)
    subscriptionError.set(result.subscriptionError)
    const existing = result.subscription?.pendingCheckout
    if (existing) {
      plan.set(existing.plan)
      interval.set(existing.interval)
      keyedSubscription = `${workspace.workspace()?.id}:${existing.plan}:${existing.interval}`
      subscriptionKey = existing.operationKey
      if (existing.url?.startsWith('https://')) { subscriptionUrl.set(existing.url); subscriptionChoice.set(keyedSubscription) }
    }
  }
  async function subscribe() {
    if (!subscription()?.checkoutAvailable || !canSubscribe() || workspace.pending() || !workspace.workspace()) return
    const choice = `${workspace.workspace()!.id}:${plan()}:${interval()}`
    if (choice !== keyedSubscription || !subscriptionKey) { subscriptionKey = crypto.randomUUID(); keyedSubscription = choice }
    const result = await workspace.run(() => workspace.request(`/api/support/workspaces/${workspace.workspace()!.id}/subscription/checkout`, { method: 'POST', body: JSON.stringify({ plan: plan(), interval: interval(), idempotencyKey: subscriptionKey }) }), workspace.pending)
    if (!result) return
    if (typeof result.url !== 'string' || !result.url.startsWith('https://')) { workspace.error.set('Subscription checkout returned an invalid link. Please contact support.'); return }
    subscriptionUrl.set(result.url)
    subscriptionChoice.set(choice)
    const current = subscription()
    if (current) subscription.set({ ...current, pendingCheckout: { url: result.url, plan: plan(), interval: interval(), operationKey: subscriptionKey }, subscription: { status: 'pending', plan: plan(), interval: interval(), current_period_end: 0, cancel_at_period_end: false } })
    workspace.notice.set('Subscription checkout is ready. Your plan changes only after a verified payment.')
  }
  async function portal() {
    if (!subscription()?.portalAvailable || workspace.pending() || !workspace.workspace()) return
    const result = await workspace.run(() => workspace.request(`/api/support/workspaces/${workspace.workspace()!.id}/subscription/portal`, { method: 'POST', body: '{}' }), workspace.pending)
    if (!result) return
    if (typeof result.url !== 'string' || !result.url.startsWith('https://')) { workspace.error.set('Billing portal returned an invalid link. Please contact support.'); return }
    portalUrl.set(result.url)
  }
  function date(value?: number) { return value ? new Date(value).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' }) : 'Not recorded' }
  async function boot() { await workspace.boot(); await load() }
  function parseCents(value: string) {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())
    const cents = match ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')) : Number.NaN
    return Number.isSafeInteger(cents) ? cents : Number.NaN
  }
  async function saveLimits() {
    if (!wallet() || !workspace.canManage() || workspace.pending() || !workspace.workspace()) return
    const daily = parseCents(dailyLimit()), monthly = parseCents(monthlyLimit())
    if (!Number.isFinite(daily) || !Number.isFinite(monthly) || daily > monthly) { workspace.error.set('Enter nonnegative USD ceilings with at most two decimal places. The monthly ceiling must cover the daily ceiling.'); return }
    const result = await workspace.run(() => workspace.request(`/api/support/workspaces/${workspace.workspace()!.id}/wallet/limits`, { method: 'POST', body: JSON.stringify({ dailyLimitCents: daily, monthlyLimitCents: monthly }) }), workspace.pending)
    if (!result) return
    wallet.set(result)
    dailyLimit.set((result.dailyLimitCents / 100).toFixed(2))
    monthlyLimit.set((result.monthlyLimitCents / 100).toFixed(2))
    workspace.notice.set(daily === 0 || monthly === 0 ? 'Spending ceilings saved. New managed paid operations are paused.' : 'Spending ceilings saved. Managed paid operations also require available credit and a configured provider.')
  }
  async function checkout() {
    if (!wallet()?.checkoutAvailable || workspace.pending() || !workspace.workspace()) return
    workspace.notice.set('')
    const cents = parseCents(amount())
    if (!Number.isSafeInteger(cents) || cents < 2000 || cents > 100000) { workspace.error.set('Enter a top up between $20.00 and $1,000.00 with at most two decimal places.'); return }
    if (cents !== keyedAmount) { key = crypto.randomUUID(); keyedAmount = cents }
    const result = await workspace.run(() => workspace.request(`/api/support/workspaces/${workspace.workspace()!.id}/wallet/checkout`, { method: 'POST', body: JSON.stringify({ amountCents: cents, idempotencyKey: key }) }), workspace.pending)
    if (!result) return
    if (typeof result.url !== 'string' || !result.url.startsWith('https://')) { workspace.error.set('Checkout returned an invalid link. Please contact support.'); return }
    checkoutUrl.set(result.url)
    checkoutAmount.set(amount())
    workspace.notice.set('Checkout is ready. Credit is added only after a verified payment. Your balance has not changed.')
  }
  function money(cents?: number) { return typeof cents === 'number' ? (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : 'Unavailable' }
  function count(value?: number | null) { return value === null ? 'Unlimited' : typeof value === 'number' ? value.toLocaleString() : 'Unavailable' }
  function bytes(value?: number | null) { return value === null ? 'Unlimited' : typeof value === 'number' ? value >= 1000000000 ? `${(value / 1000000000).toLocaleString()} GB` : `${(value / 1000000).toLocaleString()} MB` : 'Unavailable' }
  return { workspace, billing, wallet, walletError, amount, dailyLimit, monthlyLimit, saveLimits, checkoutUrl, checkoutCurrent, subscription, subscriptionError, plan, interval, selectedPrice, subscriptionUrl, subscriptionCurrent, canSubscribe, portalUrl, subscribe, portal, date, load, boot, checkout, money, count, bytes }
}
