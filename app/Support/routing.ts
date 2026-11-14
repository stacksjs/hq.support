import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, identifier, text } from './errors'
import { conversation, conversationStatuses, member, summary } from './service'

export type RoutingActor = { userId: number, source: 'manual' } | { source: 'workflow', workflowRunId: number } | { userId: number, source: 'configuration' } | { source: 'ingress' }
const timestamp = () => new Date().toISOString()
const bool = (value: unknown, fallback: boolean) => {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(422, 'invalid_input', 'Use a boolean value.')
  return value
}
const state = (row: Row) => ({ assigneeId: Number(row.assignee_id), teamId: Number(row.team_id), inboxId: Number(row.inbox_id), status: String(row.status) })
async function audit(project: Row, before: Row, after: Row, actor: RoutingActor, reason: string) {
  await insert('support_assignment_audits', { workspace_id: project.workspace_id, project_id: project.id, conversation_id: after.id, actor_id: 'userId' in actor ? actor.userId : 0, workflow_run_id: 'workflowRunId' in actor ? actor.workflowRunId : 0, source: actor.source, reason, before_state: JSON.stringify(state(before)), after_state: JSON.stringify(state(after)) })
}
async function authorize(project: Row, actor: RoutingActor) {
  if (actor.source === 'manual') return await member(actor.userId, Number(project.workspace_id))
  if (actor.source === 'workflow' && !await one('SELECT id FROM support_workflow_runs WHERE id = ? AND workspace_id = ? AND project_id = ?', [identifier(actor.workflowRunId), project.workspace_id, project.id])) fail(403, 'forbidden', 'Workflow assignment requires a scoped durable run.')
}
async function team(workspaceId: number, id: unknown, active = true) {
  const row = await one('SELECT * FROM support_teams WHERE id = ? AND workspace_id = ?', [identifier(id), workspaceId])
  if (!row || (active && !row.active)) fail(404, 'not_found', 'Active support team not found.')
  return row
}
async function inbox(project: Row, id: unknown, requireActive = true) {
  const row = await one('SELECT * FROM support_team_inboxes WHERE id = ? AND workspace_id = ? AND project_id = ?', [identifier(id), project.workspace_id, project.id])
  if (!row || (requireActive && !row.active)) fail(404, 'not_found', 'Active team inbox not found.')
  await team(Number(project.workspace_id), row.team_id, requireActive)
  return row
}
async function activeLoad(workspaceId: number, userId: number, exceptConversation = 0) {
  return Number((await one("SELECT COUNT(*) AS count FROM support_conversations WHERE workspace_id = ? AND assignee_id = ? AND status = 'open' AND id <> ?", [workspaceId, userId, exceptConversation]))?.count)
}
async function eligibility(project: Row, userId: number, teamId: number, conversationId: number, needsCapacity = true): Promise<string | null> {
  if (!await one("SELECT id FROM support_memberships WHERE workspace_id = ? AND user_id = ? AND status = 'active'", [project.workspace_id, userId])) return 'inactive_membership'
  if (teamId && !await one('SELECT id FROM support_teams WHERE id = ? AND workspace_id = ? AND active = ?', [teamId, project.workspace_id, true])) return 'team_inactive'
  if (teamId && !await one('SELECT id FROM support_team_members WHERE workspace_id = ? AND team_id = ? AND user_id = ? AND active = ?', [project.workspace_id, teamId, userId, true])) return 'not_in_team'
  const agent = await one('SELECT * FROM support_routing_agents WHERE workspace_id = ? AND user_id = ?', [project.workspace_id, userId])
  if (agent && agent.availability !== 'available') return 'agent_unavailable'
  if (needsCapacity && await activeLoad(Number(project.workspace_id), userId, conversationId) >= Number(agent?.capacity ?? 10)) return 'agent_capacity'
  return null
}
async function writeRouting(project: Row, before: Row, values: { assigneeId: number, inboxId: number, teamId: number, status: string }, actor: RoutingActor, reason: string) {
  await query('UPDATE support_conversations SET assignee_id = ?, team_id = ?, inbox_id = ?, status = ?, routing_reason = ?, updated_at = ? WHERE id = ? AND project_id = ? AND workspace_id = ?', [values.assigneeId, values.teamId, values.inboxId, values.status, reason, timestamp(), before.id, project.id, project.workspace_id])
  const after = await conversation(project, before.id)
  await audit(project, before, after, actor, reason)
  return after
}

/** Every assignment path serializes capacity admission and the persisted inbox cursor on the workspace row. */
export async function routeConversation(project: Row, id: unknown, input: Row, actor: RoutingActor) {
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const principal = await authorize(project, actor), before = await conversation(project, id)
    const selectedId = input.inboxId === undefined ? Number(before.inbox_id) : input.inboxId === 0 ? 0 : identifier(input.inboxId)
    const selected = selectedId ? await inbox(project, selectedId, input.inboxId !== undefined || input.mode === 'auto') : undefined
    const mode = input.mode ?? 'manual'
    if (!['manual', 'auto'].includes(String(mode))) fail(422, 'invalid_input', 'Routing mode must be manual or auto.')
    const status = input.status ?? before.status
    if (!conversationStatuses.some(value => value === status)) fail(422, 'invalid_input', 'Unknown conversation status.')
    const teamId = Number(selected?.team_id ?? 0)
    let assigneeId = 0, reason = 'unassigned'
    if (actor.source === 'manual' && principal && !['owner', 'admin'].includes(String(principal.role)) && (input.assigneeId !== undefined || input.inboxId !== undefined || mode === 'auto')) {
      const requested = input.assigneeId === undefined ? Number(before.assignee_id) : Number(input.assigneeId)
      if (mode === 'auto' || selectedId !== Number(before.inbox_id) || (requested === actor.userId && ![0, actor.userId].includes(Number(before.assignee_id))) || (requested !== actor.userId && !(requested === 0 && Number(before.assignee_id) === actor.userId))) fail(403, 'forbidden', 'Agents may only claim an unassigned conversation or release their own assignment; routing other agents requires an owner or admin.')
    }
    if (mode === 'auto') {
      if (!selected) fail(422, 'inbox_required', 'Automatic assignment requires a team inbox.')
      if (selected.assignment_mode === 'manual') reason = 'manual_inbox'
      else if (status !== 'open') reason = 'not_open'
      else {
        const members = await query('SELECT id, user_id FROM support_team_members WHERE workspace_id = ? AND team_id = ? AND active = ? ORDER BY id ASC', [project.workspace_id, teamId, true])
        const ordered = [...members.filter(row => Number(row.id) > Number(selected.last_member_id)), ...members.filter(row => Number(row.id) <= Number(selected.last_member_id))]
        reason = 'no_eligible_capacity'
        for (const candidate of ordered) if (!await eligibility(project, Number(candidate.user_id), teamId, Number(before.id))) {
          assigneeId = Number(candidate.user_id); reason = 'round_robin'
          await query('UPDATE support_team_inboxes SET last_member_id = ?, updated_at = ? WHERE id = ? AND project_id = ?', [candidate.id, timestamp(), selected.id, project.id])
          break
        }
      }
    }
    else {
      assigneeId = input.assigneeId === undefined ? Number(before.assignee_id) : Number(input.assigneeId)
      if (!Number.isSafeInteger(assigneeId) || assigneeId < 0 || (input.assigneeId !== undefined && typeof input.assigneeId !== 'number' && !(typeof input.assigneeId === 'string' && /^\d+$/.test(input.assigneeId)))) fail(422, 'invalid_assignee', 'Assignee must be a user identifier, or zero to unassign.')
      if (assigneeId) {
        const denied = selected && !selected.active ? 'inbox_inactive' : await eligibility(project, assigneeId, teamId, Number(before.id), status === 'open')
        // Closing/snoozing releases an existing assignment without readmitting it.
        if (denied && !(status !== 'open' && assigneeId === Number(before.assignee_id) && selectedId === Number(before.inbox_id))) {
          if (input.assigneeId === undefined && status === 'open' && before.status !== 'open') { assigneeId = 0; reason = denied }
          else fail(409, denied, 'The requested agent is inactive, unavailable, outside the team or at capacity.')
        }
        else reason = 'manual_assignment'
      }
    }
    const after = await writeRouting(project, before, { assigneeId, inboxId: Number(selectedId), teamId, status: String(status) }, actor, reason)
    return { conversation: summary(after, true), routing: state(after), reason }
  })
}

export async function routeNewConversation(project: Row, conversationId: unknown) {
  const selected = await one('SELECT i.id FROM support_team_inboxes i JOIN support_teams t ON t.id = i.team_id AND t.workspace_id = i.workspace_id WHERE i.project_id = ? AND i.workspace_id = ? AND i.is_default = ? AND i.active = ? AND t.active = ? ORDER BY i.id ASC LIMIT 1', [project.id, project.workspace_id, true, true, true])
  return selected ? await routeConversation(project, conversationId, { inboxId: Number(selected.id), mode: 'auto' }, { source: 'ingress' }) : null
}
export async function saveTeam(workspaceId: number, input: Row, userId: number, id?: unknown) {
  return await workspaceTransaction(workspaceId, async () => {
    await member(userId, workspaceId, ['owner', 'admin'])
    const previous = id === undefined ? undefined : await team(workspaceId, id, false)
    const name = text(input.name ?? previous?.name, 'name', 100), active = bool(input.active, previous ? Boolean(previous.active) : true)
    if (!previous) return await insert('support_teams', { workspace_id: workspaceId, name, active })
    await query('UPDATE support_teams SET name = ?, active = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [name, active, timestamp(), previous.id, workspaceId])
    if (!active) await releaseTeamAssignments(workspaceId, Number(previous.id), userId, 'team_disabled')
    return await team(workspaceId, previous.id, false)
  })
}
async function releaseTeamAssignments(workspaceId: number, teamId: number, userId: number, reason: string, removedUser?: number) {
  const rows = await query(`SELECT * FROM support_conversations WHERE workspace_id = ? AND team_id = ? AND assignee_id <> 0${removedUser ? ' AND assignee_id = ?' : ''}`, [workspaceId, teamId, ...(removedUser ? [removedUser] : [])])
  for (const row of rows) await writeRouting({ id: row.project_id, workspace_id: workspaceId }, row, { assigneeId: 0, inboxId: Number(row.inbox_id), teamId, status: String(row.status) }, { userId, source: 'configuration' }, reason)
}
export async function saveTeamMember(workspaceId: number, teamId: unknown, input: Row, actorId: number) {
  return await workspaceTransaction(workspaceId, async () => {
    await member(actorId, workspaceId, ['owner', 'admin']); const selected = await team(workspaceId, teamId), userId = identifier(input.userId)
    const active = bool(input.active, true)
    if (active) await member(userId, workspaceId)
    const previous = await one('SELECT * FROM support_team_members WHERE workspace_id = ? AND team_id = ? AND user_id = ?', [workspaceId, selected.id, userId])
    if (!previous && !active) fail(404, 'not_found', 'Team member not found.')
    if (!previous) return await insert('support_team_members', { workspace_id: workspaceId, team_id: selected.id, user_id: userId, active })
    await query('UPDATE support_team_members SET active = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [active, timestamp(), previous.id, workspaceId])
    if (!active) await releaseTeamAssignments(workspaceId, Number(selected.id), actorId, 'team_member_removed', userId)
    return { ...previous, active }
  })
}
export async function saveAgent(workspaceId: number, input: Row, actorId: number) {
  return await workspaceTransaction(workspaceId, async () => {
    const principal = await member(actorId, workspaceId), userId = identifier(input.userId)
    await member(userId, workspaceId)
    const previous = await one('SELECT * FROM support_routing_agents WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId])
    if (!['owner', 'admin'].includes(String(principal.role)) && (actorId !== userId || input.capacity !== undefined)) fail(403, 'forbidden', 'Only owners and admins may change capacity or other agents.')
    const availability = input.availability ?? previous?.availability ?? 'available', capacity = input.capacity ?? Number(previous?.capacity ?? 10)
    if (!['available', 'away', 'offline'].includes(String(availability)) || typeof capacity !== 'number' || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1000) fail(422, 'invalid_input', 'Use available/away/offline and a capacity from 1 to 1000.')
    if (await activeLoad(workspaceId, userId) > capacity) fail(409, 'capacity_below_load', 'Close or reassign open conversations before reducing capacity below current load.')
    if (!previous) return await insert('support_routing_agents', { workspace_id: workspaceId, user_id: userId, availability, capacity })
    await query('UPDATE support_routing_agents SET availability = ?, capacity = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [availability, capacity, timestamp(), previous.id, workspaceId])
    return { ...previous, availability, capacity }
  })
}
export async function saveInbox(project: Row, input: Row, userId: number, id?: unknown) {
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    await member(userId, Number(project.workspace_id), ['owner', 'admin'])
    const previous = id === undefined ? undefined : await inbox(project, id, false)
    const selected = await team(Number(project.workspace_id), input.teamId ?? previous?.team_id)
    if (previous && Number(previous.team_id) !== Number(selected.id)) fail(409, 'inbox_team_immutable', 'Create a new inbox to change its support team.')
    const name = text(input.name ?? previous?.name, 'name', 100), active = bool(input.active, previous ? Boolean(previous.active) : true), isDefault = bool(input.isDefault, previous ? Boolean(previous.is_default) : false), mode = input.assignmentMode ?? previous?.assignment_mode ?? 'round_robin'
    if (!['manual', 'round_robin'].includes(String(mode))) fail(422, 'invalid_input', 'Use manual or round_robin assignment.')
    if (isDefault && !active) fail(422, 'invalid_input', 'A default inbox must be active.')
    if (isDefault) await query('UPDATE support_team_inboxes SET is_default = ? WHERE workspace_id = ? AND project_id = ?', [false, project.workspace_id, project.id])
    if (!previous) return await insert('support_team_inboxes', { workspace_id: project.workspace_id, project_id: project.id, team_id: selected.id, name, active, is_default: isDefault, assignment_mode: mode, last_member_id: 0 })
    await query('UPDATE support_team_inboxes SET name = ?, active = ?, is_default = ?, assignment_mode = ?, updated_at = ? WHERE id = ? AND project_id = ?', [name, active, isDefault, mode, timestamp(), previous.id, project.id])
    return { ...previous, name, active, is_default: isDefault, assignment_mode: mode }
  })
}
export async function listTeams(workspaceId: number, userId: number) {
  await member(userId, workspaceId)
  return { teams: await query('SELECT * FROM support_teams WHERE workspace_id = ? ORDER BY id ASC', [workspaceId]), members: await query("SELECT t.*, m.status AS workspace_status FROM support_team_members t JOIN support_memberships m ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id WHERE t.workspace_id = ? ORDER BY t.id ASC", [workspaceId]) }
}
export async function listAgents(workspaceId: number, userId: number) {
  await member(userId, workspaceId)
  return { agents: await query("SELECT m.user_id, m.role, COALESCE(a.availability, 'available') AS availability, COALESCE(a.capacity, 10) AS capacity, (SELECT COUNT(*) FROM support_conversations c WHERE c.workspace_id = m.workspace_id AND c.assignee_id = m.user_id AND c.status = 'open') AS open_count FROM support_memberships m LEFT JOIN support_routing_agents a ON a.workspace_id = m.workspace_id AND a.user_id = m.user_id WHERE m.workspace_id = ? AND m.status = 'active' ORDER BY m.user_id ASC", [workspaceId]) }
}
export async function listInboxes(project: Row, userId: number) {
  await member(userId, Number(project.workspace_id))
  return { inboxes: await query('SELECT * FROM support_team_inboxes WHERE workspace_id = ? AND project_id = ? ORDER BY id ASC', [project.workspace_id, project.id]) }
}
export async function assignmentHistory(project: Row, id: unknown, userId: number) {
  await member(userId, Number(project.workspace_id)); await conversation(project, id)
  const rows = await query('SELECT * FROM support_assignment_audits WHERE workspace_id = ? AND project_id = ? AND conversation_id = ? ORDER BY id DESC LIMIT 100', [project.workspace_id, project.id, identifier(id)])
  return { assignments: rows.map(row => ({ ...row, before: JSON.parse(String(row.before_state)), after: JSON.parse(String(row.after_state)), before_state: undefined, after_state: undefined })) }
}
