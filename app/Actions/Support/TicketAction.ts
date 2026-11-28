import { Action } from '@stacksjs/actions/runtime'
import type { RequestInstance } from '@stacksjs/types'
import { SupportError, fail } from '../../Support/errors'
import { agentProject, object } from '../../Support/service'
import * as tickets from '../../Support/tickets'
import * as organizations from '../../Support/ticket-organizations'
import { query } from '../../Support/database'

export type TicketOperation = 'configuration' | 'calendar' | 'policy' | 'type' | 'relations' | 'relation' | 'create' | 'update' | 'list'
  | 'organization.list' | 'organization.create' | 'organization.customers' | 'organization.members' | 'organization.member' | 'organization.grants' | 'organization.grant'
export function ticketAction(operation: TicketOperation, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', clock: () => number = Date.now) {
  return new Action({
    name: `Support tickets ${operation}`, method, apiResponse: false,
    async handle(request: RequestInstance) {
      try {
        const account = await request.user()
        if (!account) fail(401, 'unauthorized', 'Sign in to continue.')
        const configure = ['calendar', 'policy', 'type'].includes(operation) || operation.startsWith('organization.')
        const project = await agentProject(Number(account.id), request.getParam('project'), configure ? ['owner', 'admin'] : undefined)
        const input = object(request.all())
        if (JSON.stringify(input).length > 65536) fail(413, 'body_too_large', 'Ticket input exceeds the request bound.')
        let body: unknown
        if (operation === 'configuration') body = await tickets.ticketConfiguration(project)
        else if (operation === 'calendar') body = { calendar: await tickets.saveTicketCalendar(project, input) }
        else if (operation === 'policy') body = { policy: await tickets.saveTicketPolicy(project, input) }
        else if (operation === 'type') body = { type: await tickets.saveTicketType(project, input) }
        else if (operation === 'relations') body = { relations: await tickets.ticketRelations(project, request.getParam('id')) }
        else if (operation === 'relation') body = { relation: await tickets.addTicketRelation(project, request.getParam('id'), input) }
        else if (operation === 'organization.list') body = { organizations: await organizations.ticketOrganizations(project) }
        else if (operation === 'organization.create') body = { organization: await organizations.createTicketOrganization(project, input) }
        else if (operation === 'organization.customers') body = { customers: await organizations.findOrganizationCustomers(project, new URL(request.url).searchParams.get('q')) }
        else if (operation === 'organization.members') body = { members: await organizations.organizationCustomers(project, request.getParam('organization')) }
        else if (operation === 'organization.grants') body = { organizations: await organizations.organizationsForTicket(project, request.getParam('id')) }
        else if (operation === 'organization.member') {
          await organizations.changeOrganizationCustomer(project, request.getParam('organization'), request.getParam('contact'), method === 'PUT')
          body = { active: method === 'PUT' }
        }
        else if (operation === 'organization.grant') {
          await organizations.changeTicketOrganization(project, request.getParam('id'), request.getParam('organization'), method === 'PUT')
          body = { active: method === 'PUT' }
        }
        else if (operation === 'create') body = { ticket: await tickets.createTicket(project, input, undefined, clock()) }
        else if (operation === 'update') body = { ticket: await tickets.updateTicket(project, request.getParam('id'), input, clock()) }
        else body = { tickets: await Promise.all((await query('SELECT * FROM support_tickets WHERE project_id = ? AND workspace_id = ? ORDER BY id DESC LIMIT 100', [project.id, project.workspace_id])).map(row => tickets.ticketView(row))) }
        return Response.json(body, { status: method === 'POST' ? 201 : 200, headers: { 'Cache-Control': 'no-store' } })
      }
      catch (error) {
        if (!(error instanceof SupportError) && process.env.APP_ENV === 'test') console.error(error)
        return Response.json({ error: { code: error instanceof SupportError ? error.code : 'tickets_unavailable', message: error instanceof SupportError ? error.message : 'Tickets are temporarily unavailable.' } }, { status: error instanceof SupportError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } })
      }
    },
  })
}
