import type { Row } from './database'
import type { BusinessHours } from './ticket-calendar'
import { insert, one, query, workspaceTransaction } from './database'
import { enqueue } from './service'
import { storedJson } from './ticket-forms'
import { workingDeadline, workingElapsed } from './ticket-calendar'

interface PolicySnapshot { calendar: BusinessHours | null, firstResponseMinutes: number, resolutionMinutes: number, pauseStates: string[], escalationAssigneeId: number }
export async function currentTicketClock(ticket: Row): Promise<Row | undefined> {
  return await one('SELECT * FROM support_ticket_sla_clocks WHERE ticket_id = ? AND workspace_id = ? AND cycle = ?', [ticket.id, ticket.workspace_id, ticket.sla_cycle])
}
/** Called under the workspace lock. Configuration changes never rewrite a running clock. */
export async function startTicketClock(project: Row, ticket: Row, policy: Row | undefined, at: number): Promise<void> {
  if (!policy) return
  const calendarRow = Number(policy.calendar_id) ? await one('SELECT * FROM support_business_calendars WHERE id = ? AND project_id = ? AND workspace_id = ?', [policy.calendar_id, project.id, project.workspace_id]) : undefined
  const snapshot: PolicySnapshot = { calendar: calendarRow ? storedJson<BusinessHours | null>(calendarRow.definition, null) : null, firstResponseMinutes: Number(policy.first_response_minutes), resolutionMinutes: Number(policy.resolution_minutes), pauseStates: storedJson(policy.pause_states, ['pending']), escalationAssigneeId: Number(policy.escalation_assignee_id) }
  const paused = snapshot.pauseStates.includes(String(ticket.state))
  await insert('support_ticket_sla_clocks', { workspace_id: project.workspace_id, project_id: project.id, ticket_id: ticket.id, cycle: ticket.sla_cycle, snapshot: JSON.stringify(snapshot), phase: paused ? 'paused' : 'running', anchor_at: at, first_remaining_ms: snapshot.firstResponseMinutes * 60000, resolution_remaining_ms: snapshot.resolutionMinutes * 60000, first_due_at: !paused && snapshot.firstResponseMinutes ? workingDeadline(snapshot.calendar, at, snapshot.firstResponseMinutes * 60000) : 0, resolution_due_at: !paused && snapshot.resolutionMinutes ? workingDeadline(snapshot.calendar, at, snapshot.resolutionMinutes * 60000) : 0 })
}
/** Unique persisted intent + outbox commit together. Delivery retries cannot recreate escalation work. */
export async function breachTicketClock(project: Row, clock: Row, at: number): Promise<void> {
  if (clock.phase !== 'running') return
  const policy = storedJson<PolicySnapshot>(clock.snapshot, {} as PolicySnapshot)
  for (const [metric, dueKey, doneKey, breachedKey] of [['first_response', 'first_due_at', 'first_response_at', 'first_breached_at'], ['resolution', 'resolution_due_at', 'resolved_at', 'resolution_breached_at']] as const) {
    const due = Number(clock[dueKey])
    if (!due || due > at || Number(clock[doneKey]) || Number(clock[breachedKey])) continue
    const existing = await one('SELECT id FROM support_ticket_sla_escalations WHERE clock_id = ? AND metric = ?', [clock.id, metric])
    if (!existing) {
      const ticket = await one('SELECT * FROM support_tickets WHERE id = ? AND project_id = ?', [clock.ticket_id, project.id])
      if (!ticket) continue
      let assigneeId = 0
      if (policy.escalationAssigneeId && await one("SELECT id FROM support_memberships WHERE workspace_id = ? AND user_id = ? AND status = 'active'", [project.workspace_id, policy.escalationAssigneeId])) assigneeId = policy.escalationAssigneeId
      if (assigneeId) await query('UPDATE support_tickets SET assignee_id = ? WHERE id = ? AND project_id = ?', [assigneeId, ticket.id, project.id])
      const event = await insert('support_events', { workspace_id: project.workspace_id, project_id: project.id, contact_id: ticket.contact_id, event: 'ticket.sla.breached', attributes: JSON.stringify({ ticketId: String(ticket.id), clockId: String(clock.id), metric, deadlineAt: due }) })
      const outbox = await enqueue(project, 'event.created', { ticketId: String(ticket.id), clockId: String(clock.id), metric, deadlineAt: due, eventId: String(event.id) })
      await insert('support_ticket_sla_escalations', { workspace_id: project.workspace_id, project_id: project.id, clock_id: clock.id, ticket_id: ticket.id, metric, deadline_at: due, processed_at: at, outbox_id: outbox.id })
    }
    await query(`UPDATE support_ticket_sla_clocks SET ${breachedKey} = ? WHERE id = ? AND workspace_id = ?`, [due, clock.id, project.workspace_id])
    clock[breachedKey] = due
  }
}
export async function transitionTicketClock(project: Row, ticket: Row, state: string, category: string, at: number): Promise<void> {
  const clock = await currentTicketClock(ticket)
  if (!clock || clock.phase === 'resolved') return
  await breachTicketClock(project, clock, at)
  const policy = storedJson<PolicySnapshot>(clock.snapshot, {} as PolicySnapshot)
  const elapsed = clock.phase === 'running' ? workingElapsed(policy.calendar, Number(clock.anchor_at), at) : 0
  const firstRemaining = Math.max(0, Number(clock.first_remaining_ms) - elapsed), resolutionRemaining = Math.max(0, Number(clock.resolution_remaining_ms) - elapsed)
  const phase = category === 'resolved' ? 'resolved' : policy.pauseStates.includes(state) ? 'paused' : 'running'
  await query('UPDATE support_ticket_sla_clocks SET phase = ?, anchor_at = ?, first_remaining_ms = ?, resolution_remaining_ms = ?, first_due_at = ?, resolution_due_at = ?, resolved_at = ? WHERE id = ? AND workspace_id = ?', [phase, at, firstRemaining, resolutionRemaining, phase === 'running' && policy.firstResponseMinutes && !Number(clock.first_response_at) ? Number(clock.first_breached_at) || workingDeadline(policy.calendar, at, firstRemaining) : 0, phase === 'running' && policy.resolutionMinutes ? Number(clock.resolution_breached_at) || workingDeadline(policy.calendar, at, resolutionRemaining) : 0, phase === 'resolved' ? at : 0, clock.id, project.workspace_id])
}
export async function recordTicketFirstResponse(project: Row, conversationId: unknown, at = Date.now()): Promise<void> {
  await workspaceTransaction(Number(project.workspace_id), async () => {
    const rows = await query("SELECT * FROM support_tickets WHERE project_id = ? AND workspace_id = ? AND conversation_id = ? AND status != 'resolved'", [project.id, project.workspace_id, conversationId])
    for (const ticket of rows) {
      const clock = await currentTicketClock(ticket)
      if (!clock || Number(clock.first_response_at)) continue
      await breachTicketClock(project, clock, at)
      await query('UPDATE support_ticket_sla_clocks SET first_response_at = ?, first_due_at = 0 WHERE id = ? AND workspace_id = ?', [at, clock.id, project.workspace_id])
    }
  })
}
export async function ticketSlaTick(at = Date.now()): Promise<{ checked: number }> {
  const rows = await query("SELECT id, workspace_id, project_id FROM support_ticket_sla_clocks WHERE phase = 'running' AND ((first_due_at > 0 AND first_due_at <= ? AND first_response_at = 0 AND first_breached_at = 0) OR (resolution_due_at > 0 AND resolution_due_at <= ? AND resolved_at = 0 AND resolution_breached_at = 0)) ORDER BY id LIMIT 1000", [at, at])
  for (const row of rows) await workspaceTransaction(Number(row.workspace_id), async () => {
    const clock = await one('SELECT * FROM support_ticket_sla_clocks WHERE id = ? AND workspace_id = ?', [row.id, row.workspace_id])
    if (clock) await breachTicketClock({ id: row.project_id, workspace_id: row.workspace_id }, clock, at)
  })
  return { checked: rows.length }
}
