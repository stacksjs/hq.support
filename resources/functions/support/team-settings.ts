import { derived, state } from '@stacksjs/stx'
import { createSupportConsole } from './console'
import type { AgentIdentity, RoutingAgent, SupportTeam, SupportTeamMember, TeamInbox } from './team-routing'

export function createTeamSettings() {
  const workspace = createSupportConsole()
  const teams = state<SupportTeam[]>([]), members = state<SupportTeamMember[]>([]), inboxes = state<TeamInbox[]>([]), agents = state<RoutingAgent[]>([]), identities = state<AgentIdentity[]>([])
  const self = state(''), selectedTeam = state(''), teamName = state(''), rename = state(''), memberUser = state('')
  const inboxName = state(''), inboxTeam = state(''), inboxMode = state('round_robin'), inboxDefault = state(false)
  const editingInbox = state(''), editName = state(''), editMode = state('round_robin'), editActive = state(true), editDefault = state(false)
  const agentUser = state(''), availability = state('available'), capacity = state('10')
  const activeTeams = derived(() => teams().filter(row => row.active))
  const selected = derived(() => teams().find(row => String(row.id) === selectedTeam()))
  const teamMembers = derived(() => members().filter(row => String(row.team_id) === selectedTeam()))
  const eligibleMembers = derived(() => identities().filter(row => !teamMembers().some(item => String(item.user_id) === String(row.id) && item.active)))
  const editedInbox = derived(() => inboxes().find(row => String(row.id) === editingInbox()))
  const editedTeamActive = derived(() => !!teams().find(row => String(row.id) === String(editedInbox()?.team_id))?.active)
  const selectedAgent = derived(() => agents().find(row => String(row.user_id) === agentUser()))
  let loadedProject = '', revision = 0, disposed = false
  function workspacePath(suffix: string) { const row = workspace.workspace(); if (!row) throw new Error('Select an active workspace project first.'); return `/api/support/workspaces/${encodeURIComponent(String(row.id))}${suffix}` }
  function person(id: string | number) { const row = identities().find(item => String(item.id) === String(id)); return row ? `${row.name} · ${row.email}` : `User #${id} (no active workspace membership)` }
  function teamLabel(id: string | number) { const row = teams().find(item => String(item.id) === String(id)); return row ? row.name + (row.active ? '' : ' (inactive)') : `Team #${id}` }
  function selectTeam() { rename.set(selected()?.name || ''); memberUser.set('') }
  function selectAgent() { const row = selectedAgent(); availability.set(row?.availability || 'available'); capacity.set(String(row?.capacity ?? 10)) }
  async function load() {
    if (!workspace.project() || workspace.pending()) return
    const current = ++revision, project = workspace.project()
    if (loadedProject !== project) { teams.set([]); members.set([]); inboxes.set([]); agents.set([]); identities.set([]); selectedTeam.set(''); editingInbox.set(''); agentUser.set(''); inboxTeam.set(''); rename.set(''); loadedProject = project }
    const result = await workspace.run(async () => {
      const [teamData, inboxData, agentData, names] = await Promise.all([workspace.request(workspacePath('/support-teams')), workspace.request(workspace.projectPath('/team-inboxes')), workspace.request(workspacePath('/routing-agents')), workspace.request(workspace.projectPath('/agents'))])
      return { teamData, inboxData, agentData, names }
    })
    if (!result || disposed || current !== revision || project !== workspace.project()) return
    teams.set((result.teamData.teams || []).map((row: SupportTeam) => ({ ...row, active: Boolean(row.active) })))
    members.set((result.teamData.members || []).map((row: SupportTeamMember) => ({ ...row, active: Boolean(row.active) })))
    inboxes.set((result.inboxData.inboxes || []).map((row: TeamInbox) => ({ ...row, active: Boolean(row.active), is_default: Boolean(row.is_default) })))
    agents.set(result.agentData.agents || []); identities.set(result.names.agents || [])
    if (!selectedTeam() && teams()[0]) { selectedTeam.set(String(teams()[0]!.id)); selectTeam() }
    if (!inboxTeam()) inboxTeam.set(String(teams().find(row => row.active)?.id || ''))
    if (!agentUser()) { agentUser.set(self()); selectAgent() }
  }
  async function boot() { await workspace.boot(); if (!workspace.ready()) return; const data = await workspace.run(() => workspace.request('/api/support/me')); if (!data || disposed) return; self.set(String(data.user.id)); await load() }
  async function mutate(path: string, input: unknown, message: string, admin = true) {
    if (!workspace.ready() || workspace.pending() || (admin && !workspace.canManage())) return false
    workspace.notice.set('')
    const result = await workspace.run(() => workspace.request(path, { method: 'POST', body: JSON.stringify(input) }), workspace.pending)
    if (!result || disposed) return false
    await load(); workspace.notice.set(message); return true
  }
  async function createTeam() { if (await mutate(workspacePath('/support-teams'), { name: teamName() }, 'Support team created. Add active workspace members to start routing.')) teamName.set('') }
  async function renameTeam() { if (selected()) await mutate(workspacePath(`/support-teams/${selectedTeam()}`), { name: rename() }, 'Team name saved.') }
  async function toggleTeam() { if (selected()) await mutate(workspacePath(`/support-teams/${selectedTeam()}`), { active: !selected()!.active }, selected()!.active ? 'Team disabled. Its assignments were released and conversations remain in their inboxes.' : 'Team reactivated.') }
  async function addMember() { if (memberUser() && selected()?.active && await mutate(workspacePath(`/support-teams/${selectedTeam()}/members`), { userId: Number(memberUser()), active: true }, 'Team member added.')) memberUser.set('') }
  async function toggleMember(row: SupportTeamMember) { if (selected()?.active && (row.active || row.workspace_status === 'active')) await mutate(workspacePath(`/support-teams/${selectedTeam()}/members`), { userId: Number(row.user_id), active: !row.active }, row.active ? 'Member removed from the support team and their assignments released.' : 'Team membership restored.') }
  async function createInbox() { if (await mutate(workspace.projectPath('/team-inboxes'), { teamId: Number(inboxTeam()), name: inboxName(), assignmentMode: inboxMode(), isDefault: inboxDefault() }, 'Team inbox created. A new default applies to new conversations only.')) { inboxName.set(''); inboxDefault.set(false) } }
  function editInbox(row: TeamInbox) { editingInbox.set(String(row.id)); editName.set(row.name); editMode.set(row.assignment_mode); editActive.set(Boolean(row.active)); editDefault.set(Boolean(row.is_default)) }
  async function saveInbox() { if (!editingInbox() || !editedTeamActive()) return; if (await mutate(workspace.projectPath(`/team-inboxes/${editingInbox()}`), { name: editName(), assignmentMode: editMode(), active: editActive(), isDefault: editActive() && editDefault() }, 'Inbox settings saved. Existing conversation context was preserved.')) editingInbox.set('') }
  async function saveAgent() {
    if (!agentUser() || (!workspace.canManage() && agentUser() !== self())) return
    if (workspace.canManage() && (!/^\d+$/.test(capacity()) || Number(capacity()) < 1 || Number(capacity()) > 1000)) { workspace.error.set('Capacity must be a whole number from 1 to 1000.'); return }
    await mutate(workspacePath('/routing-agents'), { userId: Number(agentUser()), availability: availability(), ...(workspace.canManage() ? { capacity: Number(capacity()) } : {}) }, 'Routing preferences saved.', false)
  }
  function destroy() { disposed = true; revision++; workspace.destroy() }
  return { workspace, activeTeams, teams, members, inboxes, agents, identities, self, selectedTeam, selected, teamMembers, eligibleMembers, teamName, rename, memberUser, inboxName, inboxTeam, inboxMode, inboxDefault, editingInbox, editedInbox, editedTeamActive, editName, editMode, editActive, editDefault, agentUser, availability, capacity, selectedAgent, person, teamLabel, selectTeam, selectAgent, load, boot, createTeam, renameTeam, toggleTeam, addMember, toggleMember, createInbox, editInbox, saveInbox, saveAgent, destroy }
}
