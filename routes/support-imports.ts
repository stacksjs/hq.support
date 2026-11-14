import { route } from '@stacksjs/router'
import { importAction } from '../app/Actions/Support/ImportAction'

route.get('/support/projects/{project}/imports', importAction('list')).middleware('auth')
route.post('/support/projects/{project}/imports/intercom', importAction('upload')).middleware('auth').rateLimit(10, 'hour')
route.get('/support/projects/{project}/imports/{id}', importAction('status')).middleware('auth')
route.post('/support/projects/{project}/imports/{id}/pause', importAction('pause')).middleware('auth')
route.post('/support/projects/{project}/imports/{id}/resume', importAction('resume')).middleware('auth').rateLimit(30, 'minute')

// Server integration writes use an explicit current project write key, never a fabricated owner identity.
route.post('/v1/projects/{project}/imports/intercom', importAction('upload', true)).skipCsrf().rateLimit(10, 'hour')
route.get('/v1/projects/{project}/imports/{id}', importAction('status', true)).rateLimit(120, 'minute')
route.post('/v1/projects/{project}/imports/{id}/resume', importAction('resume', true)).skipCsrf().rateLimit(30, 'minute')
