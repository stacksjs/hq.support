import { route } from '@stacksjs/router'
import { workflowAction } from '../app/Actions/Support/WorkflowAction'

route.get('/support/projects/{project}/automations', workflowAction('list')).middleware('auth')
route.post('/support/projects/{project}/automations', workflowAction('create')).middleware('auth').rateLimit(30, 'minute')
route.post('/support/projects/{project}/automations/{id}/draft', workflowAction('draft')).middleware('auth')
route.post('/support/projects/{project}/automations/{id}/publish', workflowAction('publish')).middleware('auth').rateLimit(30, 'minute')
route.post('/support/projects/{project}/automations/{id}/pause', workflowAction('pause')).middleware('auth')
route.get('/support/projects/{project}/automation-runs', workflowAction('runs')).middleware('auth')
route.get('/support/projects/{project}/automation-runs/{id}', workflowAction('run')).middleware('auth')
