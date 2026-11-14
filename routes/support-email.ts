import { route } from '@stacksjs/router'
import { emailAction } from '../app/Actions/Support/EmailAction'
import { registerSupportEmail } from '../app/Support/support-email'
registerSupportEmail()
route.post('/email/channels/{channel}/incoming', emailAction('incoming', 'POST')).skipCsrf().rateLimit(120, 'minute')
route.get('/support/projects/{project}/email-receipts', emailAction('receipts', 'GET')).middleware('auth')
