import { route } from '@stacksjs/router'
import { supportAction } from '../app/Actions/Support/SupportAction'
import { ticketAction } from '../app/Actions/Support/TicketAction'

route.get('/support/projects/{project}/ticket-configuration', ticketAction('configuration', 'GET')).middleware('auth')
route.post('/support/projects/{project}/ticket-calendars', ticketAction('calendar', 'POST')).middleware('auth')
route.post('/support/projects/{project}/ticket-sla-policies', ticketAction('policy', 'POST')).middleware('auth')
route.post('/support/projects/{project}/ticket-types', ticketAction('type', 'POST')).middleware('auth')
route.get('/support/projects/{project}/tickets/{id}/relations', ticketAction('relations', 'GET')).middleware('auth')
route.post('/support/projects/{project}/tickets/{id}/relations', ticketAction('relation', 'POST')).middleware('auth')

route.group({ prefix: '/support/projects/{project}', middleware: ['auth'] }, () => {
  route.get('/ticket-organizations', ticketAction('organization.list', 'GET'))
  route.post('/ticket-organizations', ticketAction('organization.create', 'POST'))
  route.get('/ticket-organizations/customers', ticketAction('organization.customers', 'GET')).rateLimit(60, 'minute')
  route.get('/ticket-organizations/{organization}/members', ticketAction('organization.members', 'GET'))
  route.put('/ticket-organizations/{organization}/members/{contact}', ticketAction('organization.member', 'PUT'))
  route.delete('/ticket-organizations/{organization}/members/{contact}', ticketAction('organization.member', 'DELETE'))
  route.get('/tickets/{id}/organizations', ticketAction('organization.grants', 'GET'))
  route.put('/tickets/{id}/organizations/{organization}', ticketAction('organization.grant', 'PUT'))
  route.delete('/tickets/{id}/organizations/{organization}', ticketAction('organization.grant', 'DELETE'))
})

route.get('/widget/projects/{project}/ticket-types', supportAction('widget.ticket-types', 'GET')).skipCsrf().rateLimit(120, 'minute')
