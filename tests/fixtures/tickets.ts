import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { route } from '@stacksjs/router'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing/isolated'
import { supportAction } from '../../app/Actions/Support/SupportAction'
import { ticketAction } from '../../app/Actions/Support/TicketAction'
import { insert, one, query } from '../../app/Support/database'
import { recordTicketFirstResponse, ticketView } from '../../app/Support/tickets'
import { createSession, reply } from '../../app/Support/service'
import { ticketSlaTick } from '../../app/Support/ticket-sla'
import { projectReports } from '../../app/Support/reports'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()
let now = Date.parse('2026-03-06T21:30:00Z')
for (const [suffix, operation, method] of [['configuration', 'configuration', 'GET'], ['calendars', 'calendar', 'POST'], ['policies', 'policy', 'POST'], ['types', 'type', 'POST'], ['tickets', 'create', 'POST'], ['tickets/{id}', 'update', 'PATCH'], ['tickets/{id}/relations', 'relation', 'POST']] as const) {
  route[method === 'GET' ? 'get' : method === 'PATCH' ? 'patch' : 'post'](`/api/_tickets/{project}/${suffix}`, ticketAction(operation, method, () => now)).middleware('auth')
}
route.get('/api/_tickets-widget/{project}/types', supportAction('widget.ticket-types', 'GET')).skipCsrf()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' }), base = `http://127.0.0.1:${server.port}/api`
let checks = 0, csrf = '', cookie = ''
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++ }
async function http(path: string, method = 'GET', body?: unknown, bearer?: string, origin?: string) {
  const result = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(origin ? { origin } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: result.status, data: await result.json() as any, headers: result.headers }
}
async function account(email: string) {
  check((await http('/register', 'POST', { name: 'SLA Owner', email, password: 'SecureSupport2026!', password_confirmation: 'SecureSupport2026!' })).status < 300, 'native account registers')
  const result = await http('/login', 'POST', { email, password: 'SecureSupport2026!' })
  return result.data.access_token ?? result.data.token
}
try {
  const seed = await http('/csrf-token'); csrf = seed.data.token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  const owner = await account('sla-owner@example.test'), outsider = await account('sla-outsider@example.test')
  const workspace = (await http('/support/workspaces', 'POST', { name: 'SLA' }, owner)).data.workspace
  const foreign = (await http('/support/workspaces', 'POST', { name: 'Other SLA' }, outsider)).data.workspace
  const project = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'App' }, owner)).data.project
  const other = (await http(`/support/workspaces/${foreign.id}/projects`, 'POST', { name: 'Other App' }, outsider)).data.project
  const user = await one('SELECT id FROM users WHERE email = ?', ['sla-owner@example.test'])
  const person = await insert('support_contacts', { workspace_id: workspace.id, project_id: project.id, external_id: 'sla-customer', name: 'Ada', email: 'ada@example.test' })
  const otherPerson = await insert('support_contacts', { workspace_id: foreign.id, project_id: other.id, external_id: 'other-customer', name: 'Other' })
  const conversation = await insert('support_conversations', { workspace_id: workspace.id, project_id: project.id, contact_id: person.id, subject: 'Help', status: 'open' })
  const path = `/_tickets/${project.public_id}`, foreignPath = `/_tickets/${other.public_id}`
  check((await http(path + '/configuration', 'GET', undefined, outsider)).status === 403, 'foreign workspace cannot read ticket configuration')
  const calendar = (await http(path + '/calendars', 'POST', { name: 'New York weekdays', timeZone: 'America/New_York', windows: [{ weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }], holidays: ['2026-03-09'] }, owner)).data.calendar
  check(Boolean(calendar?.id), 'native business calendar persists')
  check((await http(path + '/calendars', 'POST', { name: 'Bad', timeZone: 'Mars/Colony', windows: [{ weekdays: [1], start: '17:00', end: '09:00' }] }, owner)).status === 422, 'invalid zone and overnight windows refused')
  const policy = (await http(path + '/policies', 'POST', { name: 'Business hours', calendarId: calendar.id, firstResponseMinutes: 60, resolutionMinutes: 120, pauseStates: ['pending', 'awaiting_customer'], escalationAssigneeId: user!.id }, owner)).data.policy
  check(Boolean(policy?.id), 'policy targets and pause rules persist')
  check((await http(foreignPath + '/policies', 'POST', { name: 'Foreign calendar', calendarId: calendar.id, firstResponseMinutes: 1 }, outsider)).status === 404, 'policy cannot borrow another workspace calendar')
  const form = { name: 'Customer incident', kind: 'customer', slaPolicyId: policy.id, fields: [{ key: 'count', label: 'Affected users', type: 'integer', required: true }, { key: 'severity', label: 'Severity', type: 'enum', required: true, options: ['small', 'large'] }, { key: 'private_code', label: 'Private', type: 'string', visibility: 'internal', required: true, default: 'secret' }], states: [{ key: 'awaiting_customer', label: 'Awaiting customer', category: 'pending' }] }
  const type = (await http(path + '/types', 'POST', form, owner)).data.type
  check(Boolean(type?.id), 'required typed fields and additional states persist')
  check((await http(path + '/types', 'POST', { ...form, fields: [{ key: 'x', label: 'X', type: 'enum', options: [] }] }, owner)).status === 422, 'invalid field schema rejected')
  const input = { contactId: person.id, conversationId: conversation.id, title: 'Broken checkout', typeId: type.id, customFields: { count: 3, severity: 'large' } }
  check((await http(path + '/tickets', 'POST', { ...input, customFields: { count: '3', severity: 'invalid' } }, owner)).status === 422, 'incorrect field types rejected before ticket creation')
  check((await http(path + '/tickets', 'POST', { ...input, customFields: { count: 1 } }, owner)).status === 422, 'required field cannot be omitted')
  check((await http(path + '/tickets', 'POST', { ...input, customFields: { count: '3', severity: 'large' } }, owner)).status === 422, 'numeric strings cannot satisfy integer fields')
  check((await http(foreignPath + '/tickets', 'POST', { ...input, contactId: otherPerson.id, conversationId: undefined }, outsider)).status === 404, 'foreign form cannot be used')
  const created = await http(path + '/tickets', 'POST', input, owner), ticket = created.data.ticket
  check(created.status === 201 && ticket.customFields.count === 3 && ticket.status === 'open', 'typed ticket preserves legacy status contract')
  check(ticket.sla.firstDueAt === Date.parse('2026-03-10T13:30:00Z') && ticket.sla.resolutionDueAt === Date.parse('2026-03-10T14:30:00Z'), 'weekend, spring DST and holiday move exact deadline to Tuesday EDT')
  const view = await ticketView((await one('SELECT * FROM support_tickets WHERE id = ?', [ticket.id]))!, true)
  check(!JSON.stringify(view).includes('secret') && !JSON.stringify(view).includes('private_code') && !JSON.stringify(view).includes('escalationAssigneeId'), 'customer ticket projection removes internal values, definitions and policy internals')
  check((await http(path + `/tickets/${ticket.id}`, 'PATCH', { customFields: { count: 1.5 } }, owner)).status === 422, 'updates retain type validation')
  now = Date.parse('2026-03-10T13:15:00Z')
  const paused = await http(path + `/tickets/${ticket.id}`, 'PATCH', { state: 'awaiting_customer' }, owner)
  check(paused.data.ticket.status === 'pending' && paused.data.ticket.sla.phase === 'paused' && paused.data.ticket.sla.firstDueAt === 0, 'custom pause state retains legacy pending category and stops deadlines')
  await ticketSlaTick(Date.parse('2026-03-20T00:00:00Z'))
  check((await query('SELECT * FROM support_ticket_sla_escalations')).length === 0, 'paused clock cannot escalate while worker advances')
  now = Date.parse('2026-03-11T13:00:00Z')
  const resumed = await http(path + `/tickets/${ticket.id}`, 'PATCH', { status: 'open' }, owner)
  const firstDue = Date.parse('2026-03-11T13:15:00Z'), resolutionDue = Date.parse('2026-03-11T14:15:00Z')
  check(resumed.data.ticket.sla.firstDueAt === firstDue && resumed.data.ticket.sla.resolutionDueAt === resolutionDue, 'resume restores only remaining business minutes')
  await ticketSlaTick(firstDue - 1)
  check((await query('SELECT * FROM support_ticket_sla_escalations')).length === 0, 'one millisecond before deadline is not a breach')
  await Promise.all([ticketSlaTick(firstDue), ticketSlaTick(firstDue)])
  check((await query('SELECT * FROM support_ticket_sla_escalations')).length === 1, 'concurrent workers create exactly one escalation at exact deadline')
  const restart = await runIsolated('tests/fixtures/ticket-sla-resume.ts', { args: [String(firstDue)], envFile: false, preload: [], timeoutMs: 20000 })
  assertIsolatedOk(restart, 'PASS restarted SLA worker')
  check((await query('SELECT * FROM support_ticket_sla_escalations')).length === 1 && (await query("SELECT * FROM support_outbox WHERE kind = 'event.created'")).length === 1, 'new process sees persisted escalation and cannot duplicate outbox work')
  now = firstDue + 1000
  const overdue = await http(path + `/tickets/${ticket.id}`, 'PATCH', { priority: 'urgent' }, owner)
  check(overdue.data.ticket.sla.firstDueAt === firstDue, 'editing an overdue running ticket cannot move its breached deadline')
  await recordTicketFirstResponse(project, conversation.id, firstDue)
  check(Number((await one('SELECT first_breached_at FROM support_ticket_sla_clocks WHERE ticket_id = ?', [ticket.id]))!.first_breached_at) === firstDue, 'response at exact deadline records breach before satisfying clock')
  now = resolutionDue
  const resolved = await http(path + `/tickets/${ticket.id}`, 'PATCH', { status: 'resolved' }, owner)
  check(resolved.data.ticket.sla.resolutionBreachedAt === resolutionDue && resolved.data.ticket.sla.phase === 'resolved', 'resolution at deadline is late and persists escalation before stopping')
  check((await query('SELECT * FROM support_ticket_sla_escalations')).length === 2 && (await query("SELECT * FROM support_events WHERE event = 'ticket.sla.breached'")).length === 2, 'both metrics create internal work exactly once without sending external notifications')
  now += 1000
  const reopened = await http(path + `/tickets/${ticket.id}`, 'PATCH', { status: 'open' }, owner)
  check(Number(reopened.data.ticket.sla_cycle) === 2 && reopened.data.ticket.sla.firstResponseAt === 0 && (await query('SELECT * FROM support_ticket_sla_clocks WHERE ticket_id = ?', [ticket.id])).length === 2, 'reopen starts a new cycle and preserves previous history')
  const slaReport = (await projectReports(project, now)).slaTimings
  assert.deepEqual(slaReport.firstResponse, { samples: 1, averageMs: 60 * 60_000 })
  assert.deepEqual(slaReport.resolution, { samples: 1, averageMs: 120 * 60_000 })
  await recordTicketFirstResponse(project, conversation.id, firstDue)
  assert.equal(Number((await one('SELECT first_response_at FROM support_ticket_sla_clocks WHERE ticket_id = ? AND cycle = 2', [ticket.id]))?.first_response_at), 0, 'an acknowledgement from before a reopened SLA cycle cannot satisfy it')
  assert.deepEqual((await projectReports(project, now)).slaTimings, slaReport, 'a replay preserves the completed cycle and its measured samples')
  const internalType = (await http(path + '/types', 'POST', { name: 'Internal', kind: 'internal' }, owner)).data.type
  const incidentType = (await http(path + '/types', 'POST', { name: 'Incident', kind: 'incident' }, owner)).data.type
  const internal = (await http(path + '/tickets', 'POST', { contactId: person.id, title: 'Internal investigation', typeId: internalType.id }, owner)).data.ticket
  const incident = (await http(path + '/tickets', 'POST', { contactId: person.id, title: 'Service outage', typeId: incidentType.id }, owner)).data.ticket
  check((await http(path + `/tickets/${ticket.id}/relations`, 'POST', { relatedTicketId: incident.id, kind: 'incident' }, owner)).status === 201, 'incident link persists against actual incident kind')
  check((await http(path + `/tickets/${ticket.id}/relations`, 'POST', { relatedTicketId: internal.id, kind: 'incident' }, owner)).status === 422, 'relation kind mismatch rejected')
  check((await http(path + `/tickets/${ticket.id}/relations`, 'POST', { relatedTicketId: internal.id, kind: 'parent' }, owner)).status === 201, 'parent relation persists')
  check((await http(path + `/tickets/${internal.id}/relations`, 'POST', { relatedTicketId: ticket.id, kind: 'parent' }, owner)).status === 409, 'parent cycle rejected under workspace lock')
  check((await http(path + `/tickets/${ticket.id}/relations`, 'POST', { relatedTicketId: incident.id, kind: 'parent' }, owner)).status === 409, 'second distinct parent rejected')
  check((await http(foreignPath + `/tickets/${ticket.id}/relations`, 'POST', { relatedTicketId: internal.id, kind: 'parent' }, outsider)).status === 404, 'foreign workspace cannot mutate ticket relations')
  await query('UPDATE support_projects SET allowed_origins = ? WHERE id = ?', [JSON.stringify(['https://customer.example.test']), project.id])
  const customer = await createSession(project, { externalId: 'sla-customer', name: 'Ada' })
  const widget = `/widget/projects/${project.public_id}`
  const forms = await http(`/_tickets-widget/${project.public_id}/types`, 'GET', undefined, String(customer.token), 'https://customer.example.test')
  check(forms.status === 200 && forms.data.types.length === 1 && !JSON.stringify(forms.data).includes('private_code'), 'customer HTTP form discovery hides internal types and definitions')
  const widgetCreated = await http(widget + '/tickets', 'POST', { ...input, customFields: { count: 1, severity: 'small' }, idempotencyKey: 'customer-ticket' }, String(customer.token), 'https://customer.example.test')
  check(widgetCreated.status === 201 && !JSON.stringify(widgetCreated.data).includes('private_code'), 'customer HTTP creation validates form and strips private fields')
  const widgetAgain = await http(widget + '/tickets', 'POST', { ...input, customFields: { count: 1, severity: 'small' }, idempotencyKey: 'customer-ticket' }, String(customer.token), 'https://customer.example.test')
  check(String(widgetAgain.data.ticket.id) === String(widgetCreated.data.ticket.id), 'existing widget ticket idempotency contract preserved')
  check((await http(widget + '/tickets', 'POST', { ...input, customFields: { count: 1, severity: 'small', private_code: 'attacker' }, idempotencyKey: 'private-field' }, String(customer.token), 'https://customer.example.test')).status === 422, 'customer cannot write private typed fields')
  check((await http(widget + '/tickets', 'POST', { ...input, typeId: internalType.id, customFields: {}, idempotencyKey: 'internal-type' }, String(customer.token), 'https://customer.example.test')).status === 404, 'customer cannot instantiate internal ticket type')
  check((await http(widget + `/tickets/${internal.id}`, 'GET', undefined, String(customer.token), 'https://customer.example.test')).status === 404, 'customer cannot inspect internal ticket belonging to same contact')
  check((await http(widget + `/tickets/${widgetCreated.data.ticket.id}`, 'GET', undefined, String(customer.token), 'https://evil.example.test')).status === 403, 'customer ticket origin perimeter preserved')
  const legacy = await insert('support_tickets', { workspace_id: workspace.id, project_id: project.id, contact_id: person.id, title: 'Existing ticket', status: 'pending' })
  const legacyUpdate = await http(`/support/projects/${project.public_id}/tickets/${legacy.id}`, 'PATCH', { priority: 'high' }, owner)
  check(legacyUpdate.status === 200 && legacyUpdate.data.ticket.status === 'pending' && legacyUpdate.data.ticket.state === 'pending', 'legacy pending ticket keeps state when additive schema defaults were applied')
  const ticketHistory = widget + '/tickets'
  const allowedOrigin = 'https://customer.example.test'
  const customerToken = String(customer.token)
  const secondCustomer = await createSession(project, { externalId: 'other-ticket-customer', name: 'Second customer' })
  const foreignCustomer = await createSession(other, { externalId: 'sla-customer', name: 'Foreign customer' })
  await http(ticketHistory, 'POST', { title: 'Second customer ticket', idempotencyKey: 'second-customer-ticket' }, String(secondCustomer.token), allowedOrigin)
  const firstPage = await http(ticketHistory + '?limit=1', 'GET', undefined, customerToken, allowedOrigin)
  check(firstPage.status === 200 && firstPage.headers.get('cache-control') === 'no-store' && firstPage.headers.get('access-control-allow-origin') === allowedOrigin, 'personal tickets use private, origin-protected HTTP responses')
  const firstTicket = firstPage.data.tickets[0]
  check(firstPage.data.tickets.length === 1 && firstTicket.id === String(legacy.id) && firstTicket.state === 'pending' && firstPage.data.nextCursor === firstTicket.id, 'newest owned legacy ticket is returned with its legacy state and a cursor')
  const secondPage = await http(ticketHistory + '?cursor=' + firstPage.data.nextCursor, 'GET', undefined, customerToken, allowedOrigin)
  check(secondPage.status === 200 && secondPage.data.nextCursor === null && secondPage.data.tickets.some((value: any) => value.id === String(ticket.id) && value.conversationId === String(conversation.id)), 'older owned tickets preserve the linked customer conversation')
  check(secondPage.data.tickets.every((value: any) => String(value.title) !== internal.title && String(value.title) !== incident.title && String(value.title) !== 'Second customer ticket' && !Object.hasOwn(value, 'customFields') && !Object.hasOwn(value, 'assignee_id')), 'ticket history excludes other contacts, agent records and confidential fields')
  check((await http(ticketHistory, 'GET', undefined, String(foreignCustomer.token), allowedOrigin)).status === 401, 'a same-identity session issued by another project cannot see ticket history')
  check((await http(ticketHistory, 'GET', undefined, undefined, allowedOrigin)).status === 401, 'ticket history requires a customer session')
  check((await http(ticketHistory, 'GET', undefined, customerToken, 'https://evil.example.test')).status === 403, 'ticket history uses the allowed origin boundary')
  for (const search of ['limit=0', 'limit=101', 'cursor=0', 'limit=1&limit=2', 'contactId=1']) {
    check((await http(ticketHistory + '?' + search, 'GET', undefined, customerToken, allowedOrigin)).status === 422, 'ticket history rejects invalid or unsupported pagination')
  }
  const organizationPath = `/support/projects/${project.public_id}/ticket-organizations`
  const ticketGrants = `/support/projects/${project.public_id}/tickets/${ticket.id}/organizations`
  const secondToken = String(secondCustomer.token)
  const sharedHistory = ticketHistory + '?scope=shared'
  const sharedDetail = `${ticketHistory}/${ticket.id}`
  const otherUser = await one('SELECT id FROM users WHERE email = ?', ['sla-outsider@example.test'])
  await insert('support_memberships', { workspace_id: workspace.id, user_id: otherUser!.id, email: 'sla-outsider@example.test', role: 'agent', status: 'active' })
  const team = await http(organizationPath, 'POST', { name: 'Explicit support organization' }, owner)
  check(team.status === 201, 'an owner can create a ticket organization')
  const organizationId = team.data.organization.id
  const members = `${organizationPath}/${organizationId}/members`
  const secondMembership = `${members}/${secondCustomer.contact.id}`
  const grant = `${ticketGrants}/${organizationId}`
  check((await http(secondMembership, 'PUT', undefined, outsider)).status === 403, 'ordinary agents cannot grant organization membership')
  check((await http(`${members}/${otherPerson.id}`, 'PUT', undefined, owner)).status === 404, 'membership is scoped to this project')
  const anonymous = await createSession(project, { externalId: 'anonymous:organization-visitor', name: 'Visitor' })
  check((await http(`${members}/${anonymous.contact.id}`, 'PUT', undefined, owner)).status === 422, 'browser-only anonymous sessions cannot join an organization')
  const matchingCustomers = await http(organizationPath + '/customers?q=second', 'GET', undefined, owner)
  check(matchingCustomers.status === 200 && matchingCustomers.data.customers.length === 1 && String(matchingCustomers.data.customers[0].id) === secondCustomer.contact.id, 'organization customer search stays in project scope')
  check((await http(organizationPath + '/customers?q=visitor', 'GET', undefined, owner)).data.customers.length === 0, 'organization search omits anonymous customer identities')
  check((await http(sharedDetail, 'GET', undefined, secondToken, allowedOrigin)).status === 404, 'a customer cannot open another customer ticket before sharing')
  check((await http(secondMembership, 'PUT', undefined, owner)).status === 200, 'an owner explicitly adds a verified project customer')
  check((await http(members, 'GET', undefined, owner)).data.members.length === 1, 'the administrative member list returns the scoped customer')
  check((await http(sharedHistory, 'GET', undefined, secondToken, allowedOrigin)).data.tickets.length === 0, 'organization membership alone reveals no tickets')
  check((await http(grant, 'PUT', undefined, outsider)).status === 403, 'ordinary agents cannot grant tickets')
  check((await http(`/support/projects/${project.public_id}/tickets/${internal.id}/organizations/${organizationId}`, 'PUT', undefined, owner)).status === 404, 'internal tickets cannot be granted to an organization')
  check((await http(grant, 'PUT', undefined, owner)).status === 200 && (await http(grant, 'PUT', undefined, owner)).status === 200, 'grant creation is idempotent')
  check((await http(ticketGrants, 'GET', undefined, owner)).data.organizations.length === 1, 'an owner can review existing grants')
  const sharedPage = await http(sharedHistory, 'GET', undefined, secondToken, allowedOrigin)
  check(sharedPage.status === 200 && sharedPage.data.tickets.length === 1 && sharedPage.data.tickets[0].id === String(ticket.id) && sharedPage.data.tickets[0].conversationId === null, 'shared list reveals only the granted summary, with no access to the original conversation')
  const filteredShared = await http(sharedHistory + '&q=' + encodeURIComponent(String(sharedPage.data.tickets[0].title).slice(0, 6)) + '&status=' + sharedPage.data.tickets[0].status, 'GET', undefined, secondToken, allowedOrigin)
  check(filteredShared.status === 200 && filteredShared.data.tickets.length === 1, 'shared history filters only authorized ticket titles and states')
  check((await http(sharedHistory + '&q=%25', 'GET', undefined, secondToken, allowedOrigin)).data.tickets.length === 0, 'title searches treat SQL wildcard characters as plain text')
  const sharedView = await http(sharedDetail, 'GET', undefined, secondToken, allowedOrigin)
  check(sharedView.status === 200 && sharedView.data.ticket.shared === true && !Object.hasOwn(sharedView.data.ticket, 'customFields') && !Object.hasOwn(sharedView.data.ticket, 'description') && !Object.hasOwn(sharedView.data.ticket, 'contact_id'), 'shared detail excludes original identity, content and custom field data')
  check((await http(ticketHistory, 'GET', undefined, secondToken, allowedOrigin)).data.tickets.length === 1, 'default history stays scoped to personal tickets')
  const followUpPath = sharedDetail + '/follow-ups'
  const followUpInput = { body: 'What is the next step for our team?', idempotencyKey: 'team-ticket-follow-up' }
  const followed = await http(followUpPath, 'POST', followUpInput, secondToken, allowedOrigin)
  const repeated = await http(followUpPath, 'POST', followUpInput, secondToken, allowedOrigin)
  check(followed.status === 201 && repeated.status === 201 && repeated.data.conversationId === followed.data.conversationId && repeated.data.ticket.id === followed.data.ticket.id, 'shared ticket follow-up opens one own conversation and ticket per idempotency key')
  const receipt = await one('SELECT response FROM support_idempotency WHERE project_id = ? AND operation = ? AND key = ?', [project.id, `shared-ticket-follow-up:${ticket.id}:${secondCustomer.contact.id}`, followUpInput.idempotencyKey])
  assert.deepEqual(JSON.parse(String(receipt?.response)), { ticketId: String(followed.data.ticket.id), conversationId: followed.data.conversationId }, 'follow-up replay receipts retain only identifiers')
  const followUpThread = await http(`${widget}/conversations/${followed.data.conversationId}`, 'GET', undefined, secondToken, allowedOrigin)
  check(followUpThread.status === 200 && followUpThread.data.messages.length === 1 && followUpThread.data.messages[0].body === followUpInput.body, 'the team member can use Messenger in their own follow-up conversation')
  check((await http(`${widget}/conversations/${conversation.id}`, 'GET', undefined, secondToken, allowedOrigin)).status === 404, 'sharing the ticket cannot authorize the original conversation')
  const followUpRelation = await one("SELECT related_ticket_id FROM support_ticket_relations WHERE ticket_id = ? AND kind = 'customer'", [followed.data.ticket.id])
  check(String(followUpRelation?.related_ticket_id) === String(ticket.id), 'agent-side ticket relation connects the follow-up to the source')

  check((await http(grant, 'DELETE', undefined, owner)).status === 200 && (await http(sharedDetail, 'GET', undefined, secondToken, allowedOrigin)).status === 404, 'grant revocation removes access immediately')
  check((await http(grant, 'PUT', undefined, owner)).status === 200 && (await http(secondMembership, 'DELETE', undefined, owner)).status === 200, 'owner can revoke membership independently of the grant')
  check((await http(sharedHistory, 'GET', undefined, secondToken, allowedOrigin)).data.tickets.length === 0 && (await http(sharedDetail, 'GET', undefined, secondToken, allowedOrigin)).status === 404, 'membership revocation removes listed and direct ticket access')
  check((await http(followUpPath, 'POST', followUpInput, secondToken, allowedOrigin)).status === 404, 'membership revocation also blocks a replay against the shared ticket')
  check((await http(`${widget}/conversations/${followed.data.conversationId}`, 'GET', undefined, secondToken, allowedOrigin)).status === 200, 'the member owns the follow-up they already opened')

  check((await http(sharedDetail, 'GET', undefined, customerToken, allowedOrigin)).status === 200, 'revoking another customer leaves the author access intact')
  const utcPolicy = (await http(path + '/policies', 'POST', { name: 'Always open', firstResponseMinutes: 1, resolutionMinutes: 2 }, owner)).data.policy
  const utcType = (await http(path + '/types', 'POST', { name: 'Immediate', slaPolicyId: utcPolicy.id }, owner)).data.type
  now = Date.now()
  const fresh = (await http(path + '/tickets', 'POST', { contactId: person.id, conversationId: conversation.id, title: 'Public response clock', typeId: utcType.id }, owner)).data.ticket
  check(fresh.sla.firstDueAt === now + 60000, 'UTC always-open target preserves exact milliseconds')
  await reply(project, conversation.id, { body: 'Private note', visibility: 'internal', idempotencyKey: 'sla-note' }, { userId: Number(user!.id) })
  await reply(project, conversation.id, { body: 'Queued provider reply', idempotencyKey: 'sla-queued' }, { userId: Number(user!.id), deferDelivery: true })
  check(!Number((await one('SELECT first_response_at FROM support_ticket_sla_clocks WHERE ticket_id = ?', [fresh.id]))!.first_response_at), 'internal note and pending provider reply do not satisfy first response')
  await reply(project, conversation.id, { body: 'Accepted public reply', idempotencyKey: 'sla-public' }, { userId: Number(user!.id) })
  check(Number((await one('SELECT first_response_at FROM support_ticket_sla_clocks WHERE ticket_id = ?', [fresh.id]))!.first_response_at) > 0, 'actual public agent reply satisfies SLA')
  const allFields = [
    { key: 'email', label: 'Email', type: 'email', required: true },
    { key: 'amount', label: 'Amount', type: 'number', required: true },
    { key: 'confirmed', label: 'Confirmed', type: 'boolean', required: true },
    { key: 'date', label: 'Date', type: 'date', required: true },
  ]
  const allType = (await http(path + '/types', 'POST', { name: 'All native field rules', fields: allFields }, owner)).data.type
  const allInput = { contactId: person.id, title: 'Typed values', typeId: allType.id, customFields: { email: 'test@example.test', amount: 1.5, confirmed: false, date: '2026-02-28' } }
  check((await http(path + '/tickets', 'POST', allInput, owner)).status === 201, 'native rules accept email, decimal, false boolean and canonical date')
  for (const [key, invalid] of [['email', 'broken'], ['amount', '1.5'], ['confirmed', 'false'], ['date', '2026-02-30']] as const) {
    check((await http(path + '/tickets', 'POST', { ...allInput, customFields: { ...allInput.customFields, [key]: invalid } }, owner)).status === 422, `native typed rule rejects invalid ${key}`)
  }
  const sunday = (await http(path + '/calendars', 'POST', { name: 'DST Sundays', timeZone: 'America/New_York', windows: [{ weekdays: [0], start: '00:00', end: '24:00' }] }, owner)).data.calendar
  const dstPolicy = (await http(path + '/policies', 'POST', { name: 'DST elapsed time', calendarId: sunday.id, firstResponseMinutes: 120, resolutionMinutes: 180 }, owner)).data.policy
  const dstType = (await http(path + '/types', 'POST', { name: 'DST tickets', slaPolicyId: dstPolicy.id }, owner)).data.type
  now = Date.parse('2026-11-01T04:30:00Z')
  const fall = (await http(path + '/tickets', 'POST', { contactId: person.id, title: 'Fall back', typeId: dstType.id }, owner)).data.ticket
  check(fall.sla.firstDueAt === Date.parse('2026-11-01T06:30:00Z'), 'fall repeated hour counts actual working elapsed time')
  now = Date.parse('2026-03-08T05:30:00Z')
  const spring = (await http(path + '/tickets', 'POST', { contactId: person.id, title: 'Spring forward', typeId: dstType.id }, owner)).data.ticket
  check(spring.sla.firstDueAt === Date.parse('2026-03-08T07:30:00Z'), 'spring gap counts actual working elapsed time')
  now = Date.now() - 61000
  const queued = (await http(path + '/tickets', 'POST', { contactId: person.id, title: 'Native queue escalation', typeId: utcType.id }, owner)).data.ticket
  const { default: RunTicketSla } = await import('../../app/Jobs/RunTicketSla')
  await RunTicketSla.dispatch()
  const queuedRestart = await runIsolated('tests/fixtures/ticket-sla-resume.ts', { args: ['queue', String(queued.id)], env: { QUEUE_DRIVER: 'database' }, envFile: false, preload: [], timeoutMs: 25000 })
  assertIsolatedOk(queuedRestart, 'PASS restarted SLA worker')
  check((await query("SELECT * FROM support_ticket_sla_escalations WHERE ticket_id = ? AND metric = 'first_response'", [queued.id])).length === 1, 'native database queue worker persists escalation after process restart')
  await RunTicketSla.dispatchNow()
  check((await query("SELECT * FROM support_ticket_sla_escalations WHERE ticket_id = ? AND metric = 'first_response'", [queued.id])).length === 1, 'repeated native Job execution preserves exactly one internal intent')
  console.log(`PASS ticket HTTP and SLA (${checks} checks)`)
}
finally { server.stop(true) }
