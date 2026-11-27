import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, identifier, text } from './errors'
import { conversation, createConversation, enqueue, idempotent, member, object } from './service'
import { customFieldValues, parseTicketForm, publicForm, storedJson, ticketForm } from './ticket-forms'
import { parseBusinessHours } from './ticket-calendar'
import { currentTicketClock, startTicketClock, transitionTicketClock } from './ticket-sla'

export { recordTicketFirstResponse } from './ticket-sla'
export async function ticket(project: Row, reference: unknown, customer?: Row): Promise<Row> {
  const row = await one('SELECT * FROM support_tickets WHERE id = ? AND project_id = ? AND workspace_id = ?', [identifier(reference), project.id, project.workspace_id])
  if (!row || (customer && (String(row.contact_id) !== String(customer.id) || row.kind !== 'customer'))) fail(404, 'not_found', 'Ticket not found.')
  return row
}
export async function ticketView(row: Row, customer = false): Promise<Row> {
  const form = ticketForm(row), fields = storedJson<Row>(row.custom_fields, {})
  const allowed = new Set(form.fields.filter(field => !customer || field.visibility !== 'internal').map(field => field.key))
  const view: Row = { ...row, state: Number(row.type_id) ? row.state : row.status }; delete view.type_snapshot; delete view.custom_fields
  const clock = await currentTicketClock(row)
  const sla = clock ? { cycle: Number(clock.cycle), phase: clock.phase, firstDueAt: Number(clock.first_due_at), resolutionDueAt: Number(clock.resolution_due_at), firstResponseAt: Number(clock.first_response_at), resolvedAt: Number(clock.resolved_at), firstBreachedAt: Number(clock.first_breached_at), resolutionBreachedAt: Number(clock.resolution_breached_at) } : null
  return { ...view, customFields: Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.has(key))), form: customer ? publicForm(form) : form, sla }
}
async function scoped(project: Row, table: string, reference: unknown): Promise<Row> {
  const row = await one(`SELECT * FROM ${table} WHERE id = ? AND project_id = ? AND workspace_id = ?`, [identifier(reference), project.id, project.workspace_id])
  if (!row) fail(404, 'not_found', 'Ticket configuration not found.')
  return row
}

export async function submitTicket(project: Row, input: Row, actor: { customer: Row } | { userId: number }) {
  const customer = 'customer' in actor ? actor.customer : undefined
  const id = 'customer' in actor ? actor.customer.id : actor.userId
  return await idempotent(project, `ticket:${customer ? 'customer' : 'agent'}:${id}`, input.idempotencyKey, input, async () => ({ ticket: await createTicket(project, input, customer) }), {
    operation: `ticket:${id}`,
    async authorizeReplay(response) {
      const originalId = object(object(response).ticket).id
      if (originalId === undefined) return
      const previous = await one('SELECT * FROM support_tickets WHERE workspace_id = ? AND project_id = ? AND id = ? AND contact_id = ?', [project.workspace_id, project.id, originalId, customer ? customer.id : identifier(input.contactId)])
      if (previous && (!customer || previous.kind === 'customer')) return { ticket: await ticketView(previous, Boolean(customer)) }
    },
  })
}

export async function createTicket(project: Row, input: Row, customer?: Row, at = Date.now()): Promise<Row> {
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const contactId = customer?.id ?? identifier(input.contactId)
    if (!await one('SELECT id FROM support_contacts WHERE id = ? AND project_id = ?', [contactId, project.id])) fail(404, 'not_found', 'Contact not found.')
    let conversationId = input.conversationId === undefined || input.conversationId === null ? null : identifier(input.conversationId)
    if (conversationId) { const row = await conversation(project, conversationId, customer); if (String(row.contact_id) !== String(contactId)) fail(422, 'contact_mismatch', 'Ticket and conversation must belong to the same contact.') }
    const type = input.typeId ? await scoped(project, 'support_ticket_types', input.typeId) : undefined
    if (customer && type && type.kind !== 'customer') fail(404, 'not_found', 'Ticket form not found.')
    const form = type ? { fields: storedJson(type.fields, []), states: storedJson(type.states, []) } : parseTicketForm({}, 'customer')
    const values = customFieldValues(form, input.customFields, Boolean(customer))
    const title = text(input.title, 'title', 200)
    const description = typeof input.description === 'string' ? input.description.slice(0, 20000) : ''
    if (customer && conversationId === null && Number(type?.opens_conversation) === 1) {
      // Ticket idempotency owns the entire transaction. Give this nested creation its own key.
      const thread = await createConversation(project, { externalId: customer.external_id }, { subject: title, body: description.trim() || title, idempotencyKey: crypto.randomUUID() }, customer)
      conversationId = identifier(thread.conversation.id)
    }
    const row = await insert('support_tickets', { workspace_id: project.workspace_id, project_id: project.id, contact_id: contactId, conversation_id: conversationId, title, description, type_id: type?.id ?? 0, kind: type?.kind ?? 'customer', state: 'open', custom_fields: JSON.stringify(values), type_snapshot: JSON.stringify(form) })
    const policy = type && Number(type.sla_policy_id) ? await scoped(project, 'support_ticket_sla_policies', type.sla_policy_id) : undefined
    await startTicketClock(project, row, policy, at)
    await enqueue(project, 'ticket.created', { ticketId: row.id })
    return await ticketView(row, Boolean(customer))
  })
}
export async function updateTicket(project: Row, reference: unknown, input: Row, at = Date.now()): Promise<Row> {
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const row = await ticket(project, reference), form = ticketForm(row)
    const stateKey = String(input.state ?? input.status ?? (Number(row.type_id) ? row.state : row.status)), state = form.states.find(state => state.key === stateKey)
    const priority = String(input.priority ?? row.priority), assignee = input.assigneeId === undefined ? Number(row.assignee_id) : Number(input.assigneeId)
    if (!state || !['low', 'normal', 'high', 'urgent'].includes(priority) || !Number.isSafeInteger(assignee) || assignee < 0) fail(422, 'invalid_input', 'Unknown ticket state, priority or assignee.')
    if (assignee) await member(assignee, Number(project.workspace_id))
    const values = customFieldValues(form, input.customFields, false, storedJson(row.custom_fields, {}))
    await transitionTicketClock(project, row, state.key, state.category, at)
    const cycle = row.status === 'resolved' && state.category !== 'resolved' ? Number(row.sla_cycle) + 1 : Number(row.sla_cycle)
    await query('UPDATE support_tickets SET state = ?, status = ?, priority = ?, assignee_id = ?, custom_fields = ?, sla_cycle = ?, updated_at = ? WHERE id = ? AND project_id = ? AND workspace_id = ?', [state.key, state.category, priority, assignee, JSON.stringify(values), cycle, new Date(at).toISOString(), row.id, project.id, project.workspace_id])
    const updated = await ticket(project, row.id)
    if (cycle !== Number(row.sla_cycle) && Number(row.type_id)) {
      const type = await scoped(project, 'support_ticket_types', row.type_id)
      await startTicketClock(project, updated, Number(type.sla_policy_id) ? await scoped(project, 'support_ticket_sla_policies', type.sla_policy_id) : undefined, at)
    }
    await enqueue(project, 'ticket.updated', { ticketId: row.id, state: state.key, cycle })
    return await ticketView(updated)
  })
}
export async function saveTicketCalendar(project: Row, input: Row): Promise<Row> {
  const definition = parseBusinessHours(input)
  return await insert('support_business_calendars', { workspace_id: project.workspace_id, project_id: project.id, name: text(input.name, 'name', 100), time_zone: definition.timeZone, definition: JSON.stringify(definition) })
}
function minutes(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 525600) fail(422, 'invalid_sla', 'SLA targets must be whole minutes from 0 through 525600. Zero disables that metric.')
  return Number(value)
}
export async function saveTicketPolicy(project: Row, input: Row): Promise<Row> {
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const first = minutes(input.firstResponseMinutes ?? 0), resolution = minutes(input.resolutionMinutes ?? 0), pauseStates = input.pauseStates ?? ['pending']
    if (!first && !resolution) fail(422, 'invalid_sla', 'Enable at least one SLA target.')
    if (!Array.isArray(pauseStates) || pauseStates.length > 30 || pauseStates.some(key => typeof key !== 'string' || !/^[a-z][a-z0-9_]{0,49}$/.test(key) || key === 'open' || key === 'resolved')) fail(422, 'invalid_sla', 'Pause states must be explicit nonterminal state keys.')
    if (input.calendarId) await scoped(project, 'support_business_calendars', input.calendarId)
    const assignee = input.escalationAssigneeId ? identifier(input.escalationAssigneeId) : 0
    if (assignee) await member(Number(assignee), Number(project.workspace_id))
    return await insert('support_ticket_sla_policies', { workspace_id: project.workspace_id, project_id: project.id, name: text(input.name, 'name', 100), calendar_id: input.calendarId ? identifier(input.calendarId) : 0, first_response_minutes: first, resolution_minutes: resolution, pause_states: JSON.stringify(pauseStates), escalation_assignee_id: assignee })
  })
}
export async function saveTicketType(project: Row, input: Row): Promise<Row> {
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const kind = String(input.kind || 'customer')
    if (!['customer', 'internal', 'incident'].includes(kind)) fail(422, 'invalid_form', 'Unknown ticket kind.')
    const opensConversation = input.opensConversation === undefined ? false : input.opensConversation
    if (typeof opensConversation !== 'boolean' || (opensConversation && kind !== 'customer')) fail(422, 'invalid_form', 'Only customer ticket types can open an inbox conversation.')
    const form = parseTicketForm(input, kind)
    if (input.slaPolicyId) {
      const policy = await scoped(project, 'support_ticket_sla_policies', input.slaPolicyId)
      const states = new Set(form.states.map(state => state.key))
      if (storedJson<string[]>(policy.pause_states, []).some(key => !states.has(key))) fail(422, 'invalid_form', 'Every SLA pause state must exist on this form.')
    }
    return await insert('support_ticket_types', { workspace_id: project.workspace_id, project_id: project.id, name: text(input.name, 'name', 100), kind, opens_conversation: opensConversation, fields: JSON.stringify(form.fields), states: JSON.stringify(form.states), sla_policy_id: input.slaPolicyId ? identifier(input.slaPolicyId) : 0 })
  })
}
export async function ticketRelations(project: Row, reference: unknown): Promise<Row[]> {
  const row = await ticket(project, reference)
  return await query('SELECT * FROM support_ticket_relations WHERE ticket_id = ? AND project_id = ? AND workspace_id = ? ORDER BY id', [row.id, project.id, project.workspace_id])
}
export async function addTicketRelation(project: Row, reference: unknown, input: Row): Promise<Row> {
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const row = await ticket(project, reference), related = await ticket(project, input.relatedTicketId), kind = String(input.kind)
    if (String(row.id) === String(related.id) || !['parent', 'incident', 'internal', 'customer'].includes(kind)) fail(422, 'invalid_relation', 'Use a distinct ticket and a supported relation kind.')
    if (kind !== 'parent' && related.kind !== kind) fail(422, 'invalid_relation', 'Related ticket must match the relation kind.')
    if (kind === 'parent') {
      if (await one("SELECT id FROM support_ticket_relations WHERE ticket_id = ? AND kind = 'parent' AND related_ticket_id != ?", [row.id, related.id])) fail(409, 'parent_exists', 'A ticket can have only one parent.')
      let cursor: Row | undefined = related
      for (let depth = 0; cursor; depth++) {
        if (String(cursor.id) === String(row.id)) fail(409, 'relation_cycle', 'Parent relations cannot form a cycle.')
        if (depth >= 100) fail(422, 'relation_depth', 'Parent relation depth exceeds 100 tickets.')
        const edge = await one("SELECT related_ticket_id FROM support_ticket_relations WHERE ticket_id = ? AND project_id = ? AND kind = 'parent'", [cursor.id, project.id])
        cursor = edge ? await ticket(project, edge.related_ticket_id) : undefined
      }
    }
    const existing = await one('SELECT * FROM support_ticket_relations WHERE ticket_id = ? AND related_ticket_id = ? AND kind = ? AND project_id = ?', [row.id, related.id, kind, project.id])
    if (existing) return existing
    const relation = await insert('support_ticket_relations', { workspace_id: project.workspace_id, project_id: project.id, ticket_id: row.id, related_ticket_id: related.id, kind })
    await enqueue(project, 'ticket.relation.created', { ticketId: row.id, relationId: relation.id })
    return relation
  })
}
export async function ticketConfiguration(project: Row): Promise<Row> {
  const [types, calendars, policies] = await Promise.all(['support_ticket_types', 'support_business_calendars', 'support_ticket_sla_policies'].map(table => query(`SELECT * FROM ${table} WHERE project_id = ? AND workspace_id = ? ORDER BY id LIMIT 100`, [project.id, project.workspace_id])))
  return { types, calendars, policies }
}
