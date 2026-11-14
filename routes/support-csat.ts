import { route } from '@stacksjs/router'
import { csatAction } from '../app/Actions/Support/CsatAction'

route.get('/support/projects/{project}/csat-settings', csatAction('settings')).middleware('auth').rateLimit(60, 'minute')
route.patch('/support/projects/{project}/csat-settings', csatAction('configure')).middleware('auth').rateLimit(30, 'minute')
route.get('/support/projects/{project}/csat-report', csatAction('report')).middleware('auth').rateLimit(60, 'minute')
route.get('/widget/projects/{project}/conversations/{id}/csat', csatAction('widget.read')).rateLimit(120, 'minute')
route.post('/widget/projects/{project}/conversations/{id}/csat', csatAction('widget.submit')).skipCsrf().rateLimit(30, 'minute')
