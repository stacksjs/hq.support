import { derived, state } from '@stacksjs/stx'
import { createSupportConsole } from './console'

interface Billing { workspace: { plan: string, trialEndsAt: number, overagesEnabled: boolean, spendingCapCents: number }, limits: { conversations: number | null, conversationCeiling: number | null, ai: number | null, storageBytes: number | null, seats: number | null, projects: number | null }, usage: { conversations: number, ai: number, storageBytes: number }, checkoutAvailable: boolean }
interface Wallet { balanceCents: number, currency: string, minimumTopupCents: number, checkoutAvailable: boolean, autoTopupEnabled: boolean, entries: { reference: string, kind: string, amount_cents: number, balance_cents: number, created_at: string }[] }
export function createUsage() {
  const workspace = createSupportConsole()
  const billing = state<Billing | null>(null)
  const wallet = state<Wallet | null>(null)
  const walletError = state('')
  const amount = state('20.00')
  const checkoutUrl = state('')
  const checkoutAmount = state('')
  const checkoutCurrent = derived(() => checkoutUrl() && amount() === checkoutAmount())
  let key = ''
  let keyedAmount = 0
  async function load() {
    billing.set(null)
    wallet.set(null)
    walletError.set('')
    checkoutUrl.set('')
    if (!workspace.project()) return
    const selectedProject = workspace.project()
    const result = await workspace.run(async () => {
      const billing = await workspace.request(workspace.projectPath('/billing'))
      let wallet: Wallet | null = null
      let walletError = ''
      if (workspace.canManage() && workspace.workspace()) {
        try { wallet = await workspace.request(`/api/support/workspaces/${workspace.workspace()!.id}/wallet`) }
        catch (failure) { walletError = failure instanceof Error ? failure.message : 'Prepaid credit could not be loaded.' }
      }
      return { billing, wallet, walletError }
    })
    if (!result || selectedProject !== workspace.project()) return
    billing.set(result.billing)
    wallet.set(result.wallet)
    walletError.set(result.walletError)
  }
  async function boot() { await workspace.boot(); await load() }
  async function checkout() {
    if (!wallet()?.checkoutAvailable || workspace.pending() || !workspace.workspace()) return
    workspace.notice.set('')
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount().trim())
    const cents = match ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')) : 0
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
  return { workspace, billing, wallet, walletError, amount, checkoutUrl, checkoutCurrent, load, boot, checkout, money, count, bytes }
}
