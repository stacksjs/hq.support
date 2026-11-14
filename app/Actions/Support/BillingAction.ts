import { Action } from '@stacksjs/actions/runtime'
import { SupportError, fail, identifier } from '../../Support/errors'
import { createWalletCheckout, receivePayment, walletOverview } from '../../Support/billing'
import { createSubscriptionCheckout, subscriptionOverview, subscriptionPortal } from '../../Support/subscriptions'

export function billingAction(operation: 'overview' | 'checkout' | 'webhook' | 'subscription' | 'subscribe' | 'portal') {
  return new Action({
    name: `Support billing ${operation}`, method: ['overview', 'subscription'].includes(operation) ? 'GET' : 'POST', apiResponse: false,
    async handle(request) {
      try {
        if (operation === 'webhook') {
          if (!request.rawBody) fail(400, 'raw_body_required', 'Raw payment body is required.')
          return Response.json(await receivePayment(await request.rawBody(), request.headers.get('stripe-signature') || ''))
        }
        const account = await request.user()
        if (!account) fail(401, 'unauthorized', 'Sign in to continue.')
        const workspace = identifier(request.getParam('workspace'))
        const user = Number(account.id)
        const result = operation === 'overview' ? await walletOverview(user, workspace)
          : operation === 'subscription' ? await subscriptionOverview(user, workspace)
            : operation === 'subscribe' ? await createSubscriptionCheckout(user, workspace, request.all())
              : operation === 'portal' ? await subscriptionPortal(user, workspace)
                : await createWalletCheckout(user, workspace, request.all())
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
      }
      catch (error) {
        if (error instanceof SupportError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
        return Response.json({ error: { code: 'billing_unavailable', message: 'Billing is unavailable. Retry with the same operation key.' } }, { status: 503 })
      }
    },
  })
}
