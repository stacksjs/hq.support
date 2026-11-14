import { route } from '@stacksjs/router'
import { supportAction } from '../app/Actions/Support/SupportAction'
import { ticketAction } from '../app/Actions/Support/TicketAction'

route.get('/support/projects/{project}/ticket-configuration', ticketAction('configuration', 'GET')).middleware('auth')
route.post('/support/projects/{project}/ticket-calendars', ticketAction('calendar', 'POST')).middleware('auth')
route.post('/support/projects/{project}/ticket-sla-policies', ticketAction('policy', 'POST')).middleware('auth')
route.post('/support/projects/{project}/ticket-types', ticketAction('type', 'POST')).middleware('auth')
route.get('/support/projects/{project}/tickets/{id}/relations', ticketAction('relations', 'GET')).middleware('auth')
route.post('/support/projects/{project}/tickets/{id}/relations', ticketAction('relation', 'POST')).middleware('auth')

route.get('/widget/projects/{project}/ticket-types', supportAction('widget.ticket-types', 'GET')).skipCsrf().rateLimit(120, 'minute')
