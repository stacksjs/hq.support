import { route } from '@stacksjs/router'
import ListAgentsAction from '../app/Actions/Support/ListAgentsAction'
import MarkReadAction from '../app/Actions/Support/MarkReadAction'
import { attachmentAction } from '../app/Actions/Support/AttachmentAction'

route.post('/support/projects/{project}/conversations/{id}/attachments', attachmentAction('upload')).middleware('auth').rateLimit(30, 'minute')
route.get('/support/projects/{project}/attachments/{id}', attachmentAction('download')).middleware('auth')
route.delete('/support/projects/{project}/attachments/{id}', attachmentAction('remove')).middleware('auth')
route.post('/widget/projects/{project}/conversations/{id}/attachments', attachmentAction('upload', true)).skipCsrf().rateLimit(20, 'minute')
route.get('/widget/projects/{project}/attachments/{id}', attachmentAction('download', true)).rateLimit(120, 'minute')

route.post('/support/projects/{project}/conversations/{id}/read', MarkReadAction).middleware('auth')

route.get('/support/projects/{project}/agents', ListAgentsAction).middleware('auth')
