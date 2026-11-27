import { route } from '@stacksjs/router'
import { billingAction } from '../app/Actions/Support/BillingAction'

route.get('/support/workspaces/{workspace}/wallet', billingAction('overview')).middleware('auth')
route.post('/support/workspaces/{workspace}/wallet/limits', billingAction('limits')).middleware('auth').rateLimit(20, 'hour')
route.get('/support/projects/{project}/wallet', billingAction('project-overview')).middleware('auth')
route.post('/support/projects/{project}/wallet/limits', billingAction('project-limits')).middleware('auth').rateLimit(20, 'hour')
route.post('/support/workspaces/{workspace}/wallet/checkout', billingAction('checkout')).middleware('auth').rateLimit(10, 'hour')
route.get('/support/workspaces/{workspace}/subscription', billingAction('subscription')).middleware('auth')
route.post('/support/workspaces/{workspace}/subscription/checkout', billingAction('subscribe')).middleware('auth').rateLimit(10, 'hour')
route.post('/support/workspaces/{workspace}/subscription/portal', billingAction('portal')).middleware('auth').rateLimit(10, 'hour')
route.post('/billing/stripe/webhook', billingAction('webhook')).skipCsrf().rateLimit(300, 'minute')
