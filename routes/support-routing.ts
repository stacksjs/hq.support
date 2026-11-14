import { route } from '@stacksjs/router'
import { routingAction } from '../app/Actions/Support/RoutingAction'

route.get('/support/workspaces/{workspace}/support-teams', routingAction('teams')).middleware('auth')
route.post('/support/workspaces/{workspace}/support-teams', routingAction('team.save')).middleware('auth')
route.post('/support/workspaces/{workspace}/support-teams/{id}', routingAction('team.save')).middleware('auth')
route.post('/support/workspaces/{workspace}/support-teams/{id}/members', routingAction('team.member')).middleware('auth')
route.get('/support/workspaces/{workspace}/routing-agents', routingAction('agents')).middleware('auth')
route.post('/support/workspaces/{workspace}/routing-agents', routingAction('agent.save')).middleware('auth')
route.get('/support/projects/{project}/team-inboxes', routingAction('inboxes')).middleware('auth')
route.post('/support/projects/{project}/team-inboxes', routingAction('inbox.save')).middleware('auth')
route.post('/support/projects/{project}/team-inboxes/{id}', routingAction('inbox.save')).middleware('auth')
route.post('/support/projects/{project}/conversations/{id}/routing', routingAction('route')).middleware('auth')
route.get('/support/projects/{project}/conversations/{id}/routing-audit', routingAction('audit')).middleware('auth')
