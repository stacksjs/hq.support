import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing/isolated'
import { insert, one, query } from '../../app/Support/database'
import { dispatchWorkflowEvent, executeWorkflowRun } from '../../app/Support/workflows'

await overridesReady
if (config.database.queryLogging) config.database.queryLogging.enabled = false
if (!process.env.SUPPORT_ROUTING_RESTART) {
  assert.equal((await migrateAuthTables()).success, true)
  assert.equal((await runDatabaseMigration()).isOk, true)
  assert.equal((await migrateAuthTables()).success, true)
}
await injectGlobalAutoImports()
await route.importRoutes()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' }), base = `http://127.0.0.1:${server.port}/api`
let checks = 0, cookie = '', csrf = ''
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++ }
async function http(path: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json() as any }
}
async function account(name: string) {
  const email = `${name}@routing.example.test`, password = 'RoutingFixture2026!'
  assert.equal((await http('/register', 'POST', { name, email, password, password_confirmation: password })).status, 200)
  const login = await http('/login', 'POST', { email, password })
  return { token: login.data.access_token ?? login.data.token, id: Number((await one('SELECT id FROM users WHERE email = ?', [email]))!.id) }
}
try {
  const seed = await fetch(base + '/csrf-token'); csrf = (await seed.json() as any).token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  if (process.env.SUPPORT_ROUTING_RESTART === 'race') {
    const s = await Bun.file(process.env.SUPPORT_TEST_ROUTING_STATE!).json(), index = Number(process.env.SUPPORT_ROUTING_RACE_INDEX)
    const result = await http(s.agent + `/conversations/${s.ids[index]}/routing`, 'POST', { mode: 'auto' }, s.token)
    await Bun.write(process.env.SUPPORT_TEST_ROUTING_STATE! + `.race${index}`, JSON.stringify(result))
    check(result.status === 200, 'independent process routes through authenticated HTTP')
    console.log('PASS team routing race')
  }
  else if (process.env.SUPPORT_ROUTING_RESTART === '1') {
    const s = await Bun.file(process.env.SUPPORT_TEST_ROUTING_STATE!).json()
    const result = await http(s.agent + `/conversations/${s.conversationId}/routing`, 'POST', { inboxId: s.inboxId, mode: 'auto' }, s.token)
    check(result.status === 200 && result.data.routing.assigneeId === s.expectedUserId, 'new native server process resumes persisted round robin cursor')
    const audit = await http(s.agent + `/conversations/${s.conversationId}/routing-audit`, 'GET', undefined, s.token)
    check(audit.data.assignments[0].source === 'manual' && audit.data.assignments[0].reason === 'round_robin', 'assignment provenance survives restart')
    console.log(`PASS team routing restart (${checks} checks)`)
  }
  else {
    const owner = await account('owner'), first = await account('first'), second = await account('second'), admin = await account('admin'), unrouted = await account('unrouted'), outsider = await account('outsider')
    const workspace = (await http('/support/workspaces', 'POST', { name: 'Routing workspace' }, owner.token)).data.workspace
    const otherWorkspace = (await http('/support/workspaces', 'POST', { name: 'Other workspace' }, outsider.token)).data.workspace
    for (const user of [first, second]) await insert('support_memberships', { workspace_id: workspace.id, user_id: user.id, email: `${user === first ? 'first' : 'second'}@routing.example.test`, role: 'agent', status: 'active' })
    await insert('support_memberships', { workspace_id: workspace.id, user_id: admin.id, email: 'admin@routing.example.test', role: 'admin', status: 'active' })
    await insert('support_memberships', { workspace_id: workspace.id, user_id: unrouted.id, email: 'unrouted@routing.example.test', role: 'agent', status: 'active' })
    const project = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'First brand' }, owner.token)).data.project
    const secondProject = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Second brand' }, owner.token)).data.project
    const otherProject = (await http(`/support/workspaces/${otherWorkspace.id}/projects`, 'POST', { name: 'Other brand' }, outsider.token)).data.project
    const agent = `/support/projects/${project.public_id}`, agents = `/support/workspaces/${workspace.id}/routing-agents`, teams = `/support/workspaces/${workspace.id}/support-teams`
    const keys = (await http(agent + '/keys', 'POST', {}, owner.token)).data
    let serial = 0
    async function create() {
      const n = ++serial, result = await http(`/v1/projects/${project.public_id}/conversations`, 'POST', { externalId: 'customer', subject: `Request ${n}`, body: 'Please help', idempotencyKey: `routing-${n}` }, keys.ingestKey)
      assert.equal(result.status, 201, JSON.stringify(result.data)); return Number(result.data.conversation.id)
    }
    const createdTeam = await http(teams, 'POST', { name: 'Support' }, owner.token), teamId = Number(createdTeam.data.team.id)
    check(createdTeam.status === 201, 'owner creates a separate support team')
    check((await http(teams + `/${teamId}`, 'POST', { name: 'Support team' }, admin.token)).status === 200, 'native active administrator can manage support teams')
    check((await http(teams, 'POST', { name: 'Forbidden', userId: owner.id, role: 'owner', source: 'workflow' }, first.token)).status === 403, 'agent cannot administer teams')
    check((await http(teams, 'GET', undefined, outsider.token)).status === 403, 'teams respect workspace membership')
    for (const user of [first, second]) check((await http(teams + `/${teamId}/members`, 'POST', { userId: user.id }, owner.token)).status === 200, 'active native workspace member joins team')
    check((await http(teams + `/${teamId}/members`, 'POST', { userId: outsider.id }, owner.token)).status === 403, 'cross-workspace user cannot join a team')
    for (const user of [first, second]) assert.equal((await http(agents, 'POST', { userId: user.id, availability: 'available', capacity: 2 }, owner.token)).status, 200)
    const createdInbox = await http(agent + '/team-inboxes', 'POST', { teamId, name: 'Customer support', isDefault: true }, owner.token), inboxId = Number(createdInbox.data.inbox.id)
    check(createdInbox.status === 201, 'project inbox references scoped support team')
    const ids = [await create(), await create(), await create(), await create(), await create()]
    const assignments = await Promise.all(ids.map(id => http(agent + `/conversations/${id}`, 'GET', undefined, owner.token)))
    check(assignments.map(item => Number(item.data.conversation.assignee_id)).join(',') === [first.id, second.id, first.id, second.id, 0].join(','), 'persistent round robin is exact and overflow stays unassigned')
    check(assignments.every(item => Number(item.data.conversation.inbox_id) === inboxId && Number(item.data.conversation.team_id) === teamId), 'conversation retains team and inbox context')
    async function routingSnapshot() {
      const tables = ['support_teams', 'support_team_members', 'support_routing_agents', 'support_team_inboxes', 'support_conversations', 'support_assignment_audits']
      return JSON.stringify(await Promise.all(tables.map(table => query(`SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY id ASC`, [workspace.id]))))
    }
    const unchanged = await routingSnapshot()
    const malformed: Array<[string, unknown]> = [
      [agents, { userId: true, availability: 'offline' }],
      [agents, { userId: [first.id], availability: 'offline' }],
      [agents, { userId: `${first.id}e0`, availability: 'offline' }],
      ...[0, -1, 1.5, 1001, '2', null].map(capacity => [agents, { userId: first.id, capacity }] as [string, unknown]),
      ...['busy', true, null].map(availability => [agents, { userId: first.id, availability }] as [string, unknown]),
      [teams + `/${teamId}/members`, { userId: first.id, active: 'false' }],
      [teams + `/${teamId}`, { active: 0 }],
      [agent + `/team-inboxes/${inboxId}`, { isDefault: 'true' }],
      [agent + `/team-inboxes/${inboxId}`, { active: null }],
      [agent + `/team-inboxes/${inboxId}`, { teamId: true }],
      [agent + `/team-inboxes/${inboxId}`, { teamId: null }],
      [agent + `/conversations/${ids[0]}/routing`, { inboxId: true, mode: 'auto' }],
      [agent + `/conversations/${ids[0]}/routing`, { assigneeId: true }],
      [agent + `/conversations/${ids[0]}/routing`, { assigneeId: [first.id] }],
      [agent + `/conversations/${ids[0]}/routing`, { status: 'unknown' }],
    ]
    for (const [path, payload] of malformed) {
      const invalid = await http(path, 'POST', payload, owner.token)
      check(invalid.status === 422, `malformed routing input is rejected: ${JSON.stringify(payload)} returned ${invalid.status}`)
      check(await routingSnapshot() === unchanged, 'malformed input leaves persisted routing, settings, defaults and audits unchanged')
    }
    const filtered = await http(agent + `/inbox?inboxId=${inboxId}&limit=2`, 'GET', undefined, owner.token)
    check(filtered.status === 200 && filtered.data.conversations.length === 2 && filtered.data.nextCursor && filtered.data.conversations.every((row: any) => Number(row.inbox_id) === inboxId), 'team inbox filter preserves scoped keyset pagination')
    check((await http(agent + `/inbox?inboxId=999999`, 'GET', undefined, owner.token)).status === 404, 'unowned inbox filter is rejected')
    await http(agent + `/conversations/${ids[4]}`, 'PATCH', { status: 'closed' }, owner.token)
    check((await http(agent + `/conversations/${ids[4]}/routing`, 'POST', { assigneeId: first.id }, owner.token)).status === 200, 'closed historical assignment consumes no open capacity and does not falsely reject a full agent')
    const closedReopen = await http(agent + `/conversations/${ids[4]}`, 'PATCH', { status: 'open' }, owner.token)
    check(closedReopen.status === 200 && closedReopen.data.routing.assigneeId === 0, 'historical assignment must readmit its agent when reopened')
    check((await http(agent + `/conversations/${ids[4]}/routing`, 'POST', { assigneeId: first.id }, owner.token)).data.error.code === 'agent_capacity', 'manual assignment cannot bypass capacity')
    const outsideTeam = await http(agent + `/conversations/${ids[4]}/routing`, 'POST', { assigneeId: unrouted.id }, owner.token)
    check(outsideTeam.status === 409 && outsideTeam.data.error.code === 'not_in_team', 'active workspace agent outside the selected team cannot be manually assigned')
    const outsideClaim = await http(agent + `/conversations/${ids[4]}/routing`, 'POST', { assigneeId: unrouted.id }, unrouted.token)
    check(outsideClaim.status === 409 && outsideClaim.data.error.code === 'not_in_team', 'workspace membership alone cannot claim work from another support team')
    check((await http(agent + `/conversations/${ids[4]}/routing`, 'POST', { assigneeId: second.id }, first.token)).status === 403, 'agents cannot assign another agent')
    check((await http(agent + `/conversations/${ids[1]}/routing`, 'POST', { assigneeId: first.id }, first.token)).status === 403, 'agents cannot steal another agent assignment by claiming it for themselves')
    const secondAgent = `/support/projects/${secondProject.public_id}`
    const secondKeys = (await http(secondAgent + '/keys', 'POST', {}, owner.token)).data
    const secondInbox = (await http(secondAgent + '/team-inboxes', 'POST', { teamId, name: 'Other brand support', isDefault: true }, owner.token)).data.inbox
    const teamList = await http(teams, 'GET', undefined, first.token)
    check(teamList.status === 200 && teamList.data.teams.length === 1 && Number(teamList.data.teams[0].id) === teamId && teamList.data.members.length === 2 && teamList.data.members.every((row: any) => Number(row.workspace_id) === Number(workspace.id) && row.workspace_status === 'active'), 'active workspace agent reads scoped support teams and native membership status')
    const inboxList = await http(agent + '/team-inboxes', 'GET', undefined, first.token)
    const otherBrandList = await http(secondAgent + '/team-inboxes', 'GET', undefined, admin.token)
    const otherTenantList = await http(`/support/projects/${otherProject.public_id}/team-inboxes`, 'GET', undefined, outsider.token)
    check(inboxList.status === 200 && inboxList.data.inboxes.length === 1 && Number(inboxList.data.inboxes[0].id) === inboxId && Number(inboxList.data.inboxes[0].project_id) === Number(project.id), 'team inbox list is readable by an active agent and scoped to its project')
    check(otherBrandList.status === 200 && otherBrandList.data.inboxes.length === 1 && Number(otherBrandList.data.inboxes[0].id) === Number(secondInbox.id) && otherTenantList.status === 200 && otherTenantList.data.inboxes.length === 0, 'successful project and tenant inbox lists never mix contexts')
    const crossBrand = await http(`/v1/projects/${secondProject.public_id}/conversations`, 'POST', { externalId: 'brand-customer', subject: 'Other brand', body: 'Help', idempotencyKey: 'other-brand' }, secondKeys.ingestKey)
    const crossDetail = await http(secondAgent + `/conversations/${crossBrand.data.conversation.id}`, 'GET', undefined, owner.token)
    check(crossBrand.status === 201 && Number(crossDetail.data.conversation.assignee_id) === 0 && Number(crossDetail.data.conversation.inbox_id) === Number(secondInbox.id), 'another project cannot bypass workspace-wide agent capacity')
    check((await http(agent + `/conversations/${ids[0]}`, 'PATCH', { status: 'closed' }, owner.token)).status === 200, 'legacy update endpoint closes assignment')
    if ((await one('SELECT status FROM support_conversations WHERE id = ?', [ids[0]]))?.status !== 'closed') throw new Error('Legacy update did not close')
    check((await http(agent + `/conversations/${ids[4]}/routing`, 'POST', { assigneeId: first.id }, owner.token)).status === 200, 'closing releases exactly one open capacity slot')
    const reopened = await http(agent + `/conversations/${ids[0]}`, 'PATCH', { status: 'open' }, owner.token)
    check(reopened.status === 200 && Number(reopened.data.conversation.assignee_id) === 0, 'reopening a full agent conversation leaves it honestly unassigned')
    check((await http(agents, 'POST', { userId: first.id, capacity: 1 }, owner.token)).data.error.code === 'capacity_below_load', 'capacity cannot shrink below existing open load')
    check((await http(agents, 'POST', { userId: first.id, capacity: 100 }, first.token)).status === 403, 'agent cannot grant themself extra capacity')
    check((await http(agents, 'POST', { userId: second.id, availability: 'away' }, second.token)).status === 200, 'agent controls explicit own availability without changing capacity')
    await http(agent + `/conversations/${ids[1]}`, 'PATCH', { status: 'snoozed' }, owner.token)
    const away = await http(agent + `/conversations/${ids[0]}/routing`, 'POST', { mode: 'auto' }, owner.token)
    check(away.status === 200 && away.data.routing.assigneeId === 0, 'away agent is skipped even with a free slot')
    await http(agents, 'POST', { userId: second.id, availability: 'available' }, second.token)
    const concurrent = await Promise.all([ids[0], ids[1], ids[4]].map(id => http(agent + `/conversations/${id}/routing`, 'POST', { assigneeId: 0, status: 'open' }, owner.token)))
    check(concurrent.every(item => item.status === 200), 'parallel explicit releases and status updates serialize')
    // Three contenders, one remaining slot: existing assignments are first:1, second:1.
    const before = await http(agents, 'GET', undefined, owner.token)
    await http(agents, 'POST', { userId: first.id, capacity: 1 }, owner.token)
    await http(agents, 'POST', { userId: second.id, capacity: 2 }, owner.token)
    await Bun.write(process.env.SUPPORT_TEST_ROUTING_STATE!, JSON.stringify({ agent, ids: [ids[0], ids[1], ids[4]], token: owner.token }))
    const contenders = await Promise.all([0, 1, 2].map(index => runIsolated('tests/fixtures/team-routing.ts', { env: { ...process.env, SUPPORT_ROUTING_RESTART: 'race', SUPPORT_ROUTING_RACE_INDEX: String(index), BUN_OPTIONS: undefined }, envFile: false, preload: [], timeoutMs: 45000 })))
    for (const contender of contenders) assertIsolatedOk(contender, 'PASS team routing race')
    const raced = await Promise.all([0, 1, 2].map(index => Bun.file(process.env.SUPPORT_TEST_ROUTING_STATE! + `.race${index}`).json()))
    check(raced.filter(item => item.data.routing.assigneeId > 0).length === 1, `independent native server processes admit exactly one last slot: ${JSON.stringify(raced)}`)
    const load = await http(agents, 'GET', undefined, owner.token)
    check(load.data.agents.filter((row: any) => [first.id, second.id].includes(Number(row.user_id))).every((row: any) => Number(row.open_count) <= Number(row.capacity)), 'actual SQL open counts never exceed capacity')
    const workflow = (await http(agent + '/automations', 'POST', { name: 'Shared assignment engine', event: 'routing.assign', definition: { start: 'assign', nodes: [{ id: 'assign', type: 'assign', userId: first.id, next: 'end' }, { id: 'end', type: 'end' }] } }, owner.token)).data.workflow
    assert.equal((await http(agent + `/automations/${workflow.id}/publish`, 'POST', {}, owner.token)).status, 200)
    async function workflowAssignment(key: string) {
      const tracked = await http(`/v1/projects/${project.public_id}/events`, 'POST', { externalId: 'customer', event: 'routing.assign', attributes: { conversationId: ids[0] }, idempotencyKey: key }, keys.ingestKey)
      assert.equal(tracked.status, 200)
      const source = (await one("SELECT * FROM support_outbox WHERE project_id = ? AND kind = 'event.created' ORDER BY id DESC LIMIT 1", [project.id]))!
      await dispatchWorkflowEvent({ id: String(source.event_id), kind: 'event.created', workspaceId: Number(workspace.id), projectId: Number(project.id), payload: { eventId: Number(tracked.data.id) } })
      const run = (await one('SELECT * FROM support_workflow_runs WHERE workflow_id = ? ORDER BY id DESC LIMIT 1', [workflow.id]))!
      await executeWorkflowRun(run.id)
      return run
    }
    const blockedRun = await workflowAssignment('routing-workflow-full')
    check((await one('SELECT status FROM support_workflow_runs WHERE id = ?', [blockedRun.id]))?.status === 'failed' && Number((await one('SELECT assignee_id FROM support_conversations WHERE id = ?', [ids[0]]))!.assignee_id) !== first.id, 'workflow assignment uses real availability and capacity admission instead of raw SQL bypass')
    check(before.status === 200, 'availability and capacity are readable from scoped native memberships')
    check((await http(`/support/projects/${otherProject.public_id}/team-inboxes`, 'POST', { teamId, name: 'Leak' }, outsider.token)).status === 404, 'team inbox cannot cross tenants')
    check((await http(`/support/projects/${secondProject.public_id}/conversations/${ids[0]}/routing`, 'POST', { mode: 'auto', inboxId }, owner.token)).status === 404, 'conversation cannot cross projects within a workspace')
    check((await http(agent + `/conversations/${ids[0]}/routing-audit`, 'GET', undefined, keys.readKey)).status === 401, 'integration read key is not an authenticated assignment principal')
    await query("UPDATE support_memberships SET status = 'inactive' WHERE workspace_id = ? AND user_id = ?", [workspace.id, first.id])
    check((await http(agent + `/conversations/${ids[0]}/routing`, 'POST', { assigneeId: first.id }, owner.token)).data.error.code === 'inactive_membership', 'inactive workspace membership overrides team membership')
    await query("UPDATE support_memberships SET status = 'active' WHERE workspace_id = ? AND user_id = ?", [workspace.id, first.id])
    await http(agents, 'POST', { userId: first.id, capacity: 10 }, owner.token); await http(agents, 'POST', { userId: second.id, capacity: 10 }, owner.token)
    await http(teams + `/${teamId}/members`, 'POST', { userId: first.id, active: false }, owner.token)
    check(Number((await one("SELECT COUNT(*) AS count FROM support_conversations WHERE team_id = ? AND assignee_id = ?", [teamId, first.id]))!.count) === 0, 'removing team member releases assignments with audit')
    const history = await http(agent + `/conversations/${ids[2]}/routing-audit`, 'GET', undefined, owner.token)
    check(history.data.assignments.some((row: any) => row.reason === 'team_member_removed' && Number(row.actor_id) === owner.id), 'manual configuration changes retain agent and before/after provenance')
    await http(teams + `/${teamId}/members`, 'POST', { userId: first.id, active: true }, owner.token)
    const acceptedRun = await workflowAssignment('routing-workflow-room')
    await executeWorkflowRun(acceptedRun.id); await executeWorkflowRun(acceptedRun.id)
    const workflowAudit = (await http(agent + `/conversations/${ids[0]}/routing-audit`, 'GET', undefined, owner.token)).data.assignments.filter((row: any) => Number(row.workflow_run_id) === Number(acceptedRun.id))
    check(workflowAudit.length === 1 && workflowAudit[0].source === 'workflow' && workflowAudit[0].after.assigneeId === first.id, 'durable workflow assignment records one audited run provenance across duplicate continuations')

    check((await http(agent + `/team-inboxes/${inboxId}`, 'POST', { active: false, isDefault: false }, owner.token)).status === 200, 'owner can suspend an inbox without deleting conversation history')
    check((await http(agent + `/conversations/${ids[0]}`, 'PATCH', { status: 'closed' }, owner.token)).status === 200, 'existing assignment can close while its inbox is inactive')
    const inactiveInboxReopen = await http(agent + `/conversations/${ids[0]}`, 'PATCH', { status: 'open' }, owner.token)
    check(inactiveInboxReopen.status === 200 && inactiveInboxReopen.data.routing.assigneeId === 0 && inactiveInboxReopen.data.reason === 'inbox_inactive', 'inactive inbox cannot readmit an assignee on reopening')
    check((await http(agent + `/conversations/${ids[0]}/routing`, 'POST', { assigneeId: first.id }, owner.token)).data.error.code === 'inbox_inactive', 'manual assignment also refuses an inactive inbox')
    check((await http(agent + `/team-inboxes/${inboxId}`, 'POST', { active: true, isDefault: true }, owner.token)).status === 200, 'owner can reactivate an inbox')
    check((await http(teams + `/${teamId}`, 'POST', { active: false }, owner.token)).status === 200 && Number((await one('SELECT COUNT(*) AS count FROM support_conversations WHERE team_id = ? AND assignee_id <> 0', [teamId]))!.count) === 0, 'disabling a team atomically releases its assignments')
    await http(teams + `/${teamId}`, 'POST', { active: true }, owner.token)
    const replacement = await http(agent + '/team-inboxes', 'POST', { teamId, name: 'Manual intake', assignmentMode: 'manual', isDefault: true }, owner.token)
    const manualInboxId = Number(replacement.data.inbox.id), previousCursor = (await one('SELECT last_member_id FROM support_team_inboxes WHERE id = ?', [inboxId]))!.last_member_id
    const defaults = (await http(agent + '/team-inboxes', 'GET', undefined, owner.token)).data.inboxes.filter((row: any) => Boolean(row.is_default))
    check(replacement.status === 201 && defaults.length === 1 && Number(defaults[0].id) === manualInboxId && !Boolean((await one('SELECT is_default FROM support_team_inboxes WHERE id = ?', [inboxId]))!.is_default), 'new default atomically replaces the old default in one project')
    const manualId = await create(), manualDetail = await http(agent + `/conversations/${manualId}`, 'GET', undefined, owner.token)
    const manualAudit = await http(agent + `/conversations/${manualId}/routing-audit`, 'GET', undefined, owner.token)
    check(Number(manualDetail.data.conversation.inbox_id) === manualInboxId && Number(manualDetail.data.conversation.assignee_id) === 0 && manualDetail.data.conversation.routing_reason === 'manual_inbox' && manualAudit.data.assignments[0].source === 'ingress', 'manual default inbox retains actual ingress unassigned with audited reason')
    const manualRetry = await http(agent + `/conversations/${manualId}/routing`, 'POST', { mode: 'auto' }, owner.token)
    check(manualRetry.status === 200 && manualRetry.data.routing.assigneeId === 0 && manualRetry.data.reason === 'manual_inbox' && Number((await one('SELECT last_member_id FROM support_team_inboxes WHERE id = ?', [manualInboxId]))!.last_member_id) === 0 && (await one('SELECT last_member_id FROM support_team_inboxes WHERE id = ?', [inboxId]))!.last_member_id === previousCursor, 'manual inbox auto requests never advance either cursor or assign an agent')
    check(Boolean((await one('SELECT is_default FROM support_team_inboxes WHERE id = ?', [secondInbox.id]))!.is_default), 'default replacement does not affect another project default')
    const newTeam = (await http(teams, 'POST', { name: 'Another team' }, owner.token)).data.team
    const immutableTeam = await http(agent + `/team-inboxes/${inboxId}`, 'POST', { teamId: Number(newTeam.id) }, owner.token)
    check(immutableTeam.status === 409 && immutableTeam.data.error.code === 'inbox_team_immutable' && Number((await one('SELECT team_id FROM support_team_inboxes WHERE id = ?', [inboxId]))!.team_id) === teamId, 'existing inbox team cannot be changed even to another valid scoped team')
    await http(agent + `/team-inboxes/${inboxId}`, 'POST', { isDefault: true }, owner.token)
    const reopenWorkflow = (await http(agent + '/automations', 'POST', { name: 'Readmit historical assignee', event: 'routing.reopen', definition: { start: 'reopen', nodes: [{ id: 'reopen', type: 'status', status: 'open', next: 'end' }, { id: 'end', type: 'end' }] } }, owner.token)).data.workflow
    assert.equal((await http(agent + `/automations/${reopenWorkflow.id}/publish`, 'POST', {}, owner.token)).status, 200)
    async function workflowReopen(key: string) {
      const tracked = await http(`/v1/projects/${project.public_id}/events`, 'POST', { externalId: 'customer', event: 'routing.reopen', attributes: { conversationId: ids[0] }, idempotencyKey: key }, keys.ingestKey)
      assert.equal(tracked.status, 200)
      const source = (await one("SELECT * FROM support_outbox WHERE project_id = ? AND kind = 'event.created' ORDER BY id DESC LIMIT 1", [project.id]))!
      await dispatchWorkflowEvent({ id: String(source.event_id), kind: 'event.created', workspaceId: Number(workspace.id), projectId: Number(project.id), payload: { eventId: Number(tracked.data.id) } })
      const run = (await one('SELECT * FROM support_workflow_runs WHERE workflow_id = ? ORDER BY id DESC LIMIT 1', [reopenWorkflow.id]))!
      await executeWorkflowRun(run.id); await executeWorkflowRun(run.id); await executeWorkflowRun(run.id)
      const detail = await http(agent + `/conversations/${ids[0]}`, 'GET', undefined, owner.token)
      const audit = (await http(agent + `/conversations/${ids[0]}/routing-audit`, 'GET', undefined, owner.token)).data.assignments.filter((row: any) => Number(row.workflow_run_id) === Number(run.id))
      check((await one('SELECT status FROM support_workflow_runs WHERE id = ?', [run.id]))?.status === 'completed' && detail.data.conversation.status === 'open' && Number(detail.data.conversation.assignee_id) === 0 && audit.length === 1 && audit[0].source === 'workflow', 'workflow status reopens unassigned with one durable provenance record across repeated continuations')
      return { detail: detail.data.conversation, audit: audit[0] }
    }
    await http(agent + `/conversations/${ids[0]}/routing`, 'POST', { status: 'closed', assigneeId: first.id }, owner.token)
    await http(agent + `/conversations/${ids[2]}/routing`, 'POST', { status: 'open', assigneeId: first.id }, owner.token)
    assert.equal((await http(agents, 'POST', { userId: first.id, capacity: 1 }, owner.token)).status, 200)
    const fullReopen = await workflowReopen('workflow-reopen-full')
    check(fullReopen.detail.routing_reason === 'agent_capacity' && fullReopen.audit.reason === 'agent_capacity' && Number((await one("SELECT COUNT(*) AS count FROM support_conversations WHERE workspace_id = ? AND assignee_id = ? AND status = 'open'", [workspace.id, first.id]))!.count) === 1, 'workflow status cannot readmit a full historical assignee or overbook the final slot')
    await http(agent + `/conversations/${ids[0]}/routing`, 'POST', { status: 'closed', assigneeId: first.id }, owner.token)
    await http(agents, 'POST', { userId: first.id, availability: 'offline' }, owner.token)
    const offlineReopen = await workflowReopen('workflow-reopen-offline')
    check(offlineReopen.detail.routing_reason === 'agent_unavailable' && offlineReopen.audit.reason === 'agent_unavailable' && Number((await one("SELECT COUNT(*) AS count FROM support_conversations WHERE workspace_id = ? AND assignee_id = ? AND status = 'open'", [workspace.id, first.id]))!.count) === 1, 'workflow status skips an unavailable historical assignee without admitting extra work')
    await http(agents, 'POST', { userId: first.id, availability: 'available', capacity: 10 }, owner.token)
    check((await http(agent + `/conversations/${ids[0]}/routing`, 'POST', { assigneeId: first.id }, first.token)).status === 200, 'active team agent can claim an unassigned conversation within capacity')
    check((await http(agent + `/conversations/${ids[0]}/routing`, 'POST', { assigneeId: 0 }, first.token)).status === 200, 'agent can release their own assignment')
    check((await http(agent + `/conversations/${ids[0]}/routing`, 'POST', { mode: 'auto' }, first.token)).status === 403, 'automatic reassignment remains an owner or admin operation')
    // Persist cursor immediately before a fresh server process exercises the next turn.
    const round = await http(agent + `/conversations/${ids[0]}/routing`, 'POST', { mode: 'auto', idempotencyKey: 'explicit-auto-once' }, owner.token)
    const cursorBeforeRetry = (await one('SELECT last_member_id FROM support_team_inboxes WHERE id = ?', [inboxId]))!.last_member_id
    const retry = await http(agent + `/conversations/${ids[0]}/routing`, 'POST', { mode: 'auto', idempotencyKey: 'explicit-auto-once' }, owner.token)
    check(retry.status === 200 && retry.data.routing.assigneeId === round.data.routing.assigneeId && (await one('SELECT last_member_id FROM support_team_inboxes WHERE id = ?', [inboxId]))!.last_member_id === cursorBeforeRetry, 'explicit operation key replays assignment without advancing the cursor twice')
    check((await http(agent + `/conversations/${ids[0]}/routing`, 'POST', { mode: 'manual', assigneeId: 0, idempotencyKey: 'explicit-auto-once' }, owner.token)).status === 409, 'routing operation key cannot be reused for a changed decision')
    const expectedUserId = round.data.routing.assigneeId === first.id ? second.id : first.id
    await Bun.write(process.env.SUPPORT_TEST_ROUTING_STATE!, JSON.stringify({ agent, conversationId: ids[4], inboxId, token: owner.token, expectedUserId }))
    server.stop(true)
    const restarted = await runIsolated('tests/fixtures/team-routing.ts', { env: { ...process.env, SUPPORT_ROUTING_RESTART: '1', BUN_OPTIONS: undefined }, envFile: false, preload: [], timeoutMs: 45000 })
    assertIsolatedOk(restarted, 'PASS team routing restart')
    check(true, 'restart resumes cursor through real native auth and HTTP')
    console.log(`PASS team routing HTTP (${checks} checks)`)
  }
}
finally { server.stop(true) }
process.exit(0)
