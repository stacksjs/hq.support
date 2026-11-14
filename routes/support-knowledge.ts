import { route } from '@stacksjs/router'
import { knowledgeAction } from '../app/Actions/Support/KnowledgeAction'
import { knowledgeIndexAction } from '../app/Actions/Support/KnowledgeIndexAction'

route.get('/support/projects/{project}/knowledge', knowledgeAction('search')).middleware('auth').rateLimit(120, 'minute')
route.post('/support/projects/{project}/knowledge', knowledgeAction('create')).middleware('auth').rateLimit(30, 'minute')
route.post('/support/projects/{project}/knowledge/import', knowledgeAction('import')).middleware('auth').rateLimit(10, 'minute')
route.patch('/support/projects/{project}/knowledge/{id}', knowledgeAction('update')).middleware('auth').rateLimit(30, 'minute')
route.get('/support/projects/{project}/knowledge/{id}/revisions', knowledgeAction('revisions')).middleware('auth')
route.get('/help/projects/{project}/articles', knowledgeAction('public.search')).rateLimit(120, 'minute')
route.get('/help/projects/{project}/articles/{slug}', knowledgeAction('public.article')).rateLimit(120, 'minute')
route.get('/widget/projects/{project}/knowledge', knowledgeAction('widget.search')).rateLimit(120, 'minute')
route.post('/widget/projects/{project}/conversations/{id}/ai', knowledgeAction('answer')).skipCsrf().rateLimit(20, 'minute')
route.post('/support/projects/{project}/conversations/{id}/copilot', knowledgeAction('copilot')).middleware('auth').rateLimit(20, 'minute')

route.get('/support/projects/{project}/ai/capabilities', knowledgeIndexAction('capabilities')).middleware('auth').rateLimit(60, 'minute')
route.get('/support/projects/{project}/knowledge/{id}/index', knowledgeIndexAction('status')).middleware('auth')
route.post('/support/projects/{project}/knowledge/{id}/index', knowledgeIndexAction('index')).middleware('auth').rateLimit(10, 'minute')
route.patch('/support/projects/{project}/knowledge/{id}/permissions', knowledgeIndexAction('permissions')).middleware('auth').rateLimit(20, 'minute')
route.delete('/support/projects/{project}/knowledge/{id}', knowledgeIndexAction('remove')).middleware('auth').rateLimit(20, 'minute')
