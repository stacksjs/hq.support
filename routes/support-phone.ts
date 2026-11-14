import { phoneAction } from '../app/Actions/Support/PhoneAction'

route.get('/support/projects/{project}/phone/capabilities', phoneAction('capabilities', 'GET')).middleware('auth')
route.get('/support/projects/{project}/phone/calls', phoneAction('list', 'GET')).middleware('auth')
route.get('/support/projects/{project}/phone/calls/{call}', phoneAction('detail', 'GET')).middleware('auth')
route.post('/support/projects/{project}/phone/channels/{channel}/verify', phoneAction('verify', 'POST')).middleware('auth').rateLimit(10, 'minute')
route.post('/support/projects/{project}/phone/calls', phoneAction('create', 'POST')).middleware('auth').rateLimit(10, 'minute')
route.post('/support/projects/{project}/phone/calls/{call}/end', phoneAction('end', 'POST')).middleware('auth')
route.post('/support/projects/{project}/phone/calls/{call}/reconcile', phoneAction('reconcile', 'POST')).middleware('auth').rateLimit(30, 'minute')
route.post('/support/projects/{project}/phone/calls/{call}/takeover', phoneAction('takeover', 'POST')).middleware('auth')
route.post('/support/projects/{project}/phone/token', phoneAction('token', 'POST')).middleware('auth').rateLimit(10, 'minute')
route.post('/phone/channels/{channel}/incoming', phoneAction('incoming', 'POST')).skipCsrf().rateLimit(120, 'minute')
for (const operation of ['instructions', 'status', 'consent', 'agent', 'dial-complete', 'wait'] as const) route.post(`/phone/calls/{call}/${operation}`, phoneAction(operation, 'POST')).skipCsrf().rateLimit(300, 'minute')
