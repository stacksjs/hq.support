import { derived, nextTick, state } from '@stacksjs/stx'
import { useEventListener } from '@stacksjs/stx/composables/use-event-listener'
import { useMediaQuery } from '@stacksjs/stx/composables/use-media-query'
import { useScrollLock } from '@stacksjs/stx/composables/use-scroll-lock'
import type { AgentIdentity, Assignment, RoutingAgent, SupportTeamMember, SupportTeam, TeamInbox } from './team-routing'
import { routingReasonLabel } from './team-routing'

interface Project { id: string | number, public_id: string, name: string, workspace_id: string | number }
interface Conversation { id: string | number, subject: string, status: string, customer_id?: string | number, updated_at?: string, unread_count?: number, assignee_id?: string | number, team_id?: string | number, inbox_id?: string | number, routing_reason?: string }
interface Message { id: string | number, body: string, visibility: string, author_type: string, created_at: string }
interface Contact { id?: string | number, name?: string, email?: string, company?: string }

export function createInbox() {
  const user = state<{ id: string | number, name: string, email: string } | null>(null)
  const workspaces = state<{ id: string | number, name: string, role: string }[]>([])
  const projects = state<Project[]>([])
  const project = state('')
  const conversations = state<Conversation[]>([])
  const current = state<Conversation | null>(null)
  const messages = state<Message[]>([])
  const contact = state<Contact | null>(null)
  const search = state('')
  const filter = state('open')
  const draft = state('')
  const visibility = state('public')
  const loading = state(true)
  const threadLoading = state(false)
  const sending = state(false)
  const error = state('')
  const notice = state('')
  const workspaceName = state('')
  const projectName = state('')
  const creating = state(false)
  const needsWorkspace = state(false)
  const detailsOpen = state(true)
  const narrowDetails = state(false)
  let detailsOpener: HTMLElement | null = null, desktopDetailsOpen = true
  let detailsScroll: ReturnType<typeof useScrollLock> | undefined
  const detailsCleanup: Array<() => void> = []
  function panel() { return document.getElementById('customer-details') }
  function panelFocusables() { return Array.from(panel()?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])') || []).filter(element => element.getClientRects().length && !element.closest('[inert]')) }
  async function openDetails() {
    detailsOpener = document.getElementById('customer-details-toggle')
    detailsOpen.set(true); if (!narrowDetails()) desktopDetailsOpen = true
    detailsScroll?.set(narrowDetails()); await nextTick()
    if (narrowDetails() && detailsOpen()) panelFocusables()[0]?.focus()
  }
  async function closeDetails() {
    detailsOpen.set(false); if (!narrowDetails()) desktopDetailsOpen = false
    detailsScroll?.set(false); await nextTick()
    const target = detailsOpener?.isConnected ? detailsOpener : document.getElementById('customer-details-toggle')
    target?.focus()
  }
  function toggleDetails() { return detailsOpen() ? closeDetails() : openDetails() }
  function setupDetails() {
    detailsScroll = useScrollLock()
    const media = useMediaQuery('(max-width: 1250px)')
    detailsCleanup.push(media.subscribe(matches => { narrowDetails.set(matches); detailsOpen.set(matches ? false : desktopDetailsOpen); detailsScroll?.set(false) }))
    detailsCleanup.push(useEventListener('keydown', event => {
      if (!narrowDetails() || !detailsOpen()) return
      const key = event as KeyboardEvent
      if (key.key === 'Escape') { key.preventDefault(); void closeDetails(); return }
      if (key.key !== 'Tab') return
      const items = panelFocusables(), first = items[0], last = items.at(-1)
      if (!first) { key.preventDefault(); panel()?.focus(); return }
      if (key.shiftKey && (document.activeElement === first || !panel()?.contains(document.activeElement))) { key.preventDefault(); last?.focus() }
      else if (!key.shiftKey && (document.activeElement === last || !panel()?.contains(document.activeElement))) { key.preventDefault(); first.focus() }
    }, { target: document, capture: true }).remove)
    detailsCleanup.push(useEventListener('focusin', event => { if (narrowDetails() && detailsOpen() && !panel()?.contains(event.target as Node)) panelFocusables()[0]?.focus() }, { target: document }).remove)
  }
  const inboxes = state<TeamInbox[]>([]), identities = state<AgentIdentity[]>([]), agents = state<RoutingAgent[]>([]), teams = state<SupportTeam[]>([]), teamMembers = state<SupportTeamMember[]>([])
  const inboxFilter = state(''), nextCursor = state<string | null>(null), routingInbox = state('0'), routingAssignee = state('0'), routingBusy = state(false), routingError = state(''), routingNotice = state(''), assignments = state<Assignment[]>([])
  const selectedWorkspace = derived(() => workspaces().find(row => Number(row.id) === Number(projects().find(item => item.public_id === project())?.workspace_id)))
  const canManage = derived(() => ['owner', 'admin'].includes(selectedWorkspace()?.role || ''))
  const canAutoRoute = derived(() => { const box = inboxes().find(row => String(row.id) === routingInbox()); return !!box && box.active && box.assignment_mode === 'round_robin' && !!teams().find(row => String(row.id) === String(box.team_id))?.active })
  const candidateAgents = derived(() => {
    const selected = inboxes().find(row => String(row.id) === routingInbox())
    return identities().filter(row => !selected || teamMembers().some(item => String(item.team_id) === String(selected.team_id) && String(item.user_id) === String(row.id) && item.active && item.workspace_status === 'active'))
  })
  const drafts = new Map<string, { body: string, visibility: string, key: string, fingerprint: string }>()
  let retryFingerprint = '', routingKey = '', routingFingerprint = ''
  function draftId(selectedProject: string, item: Conversation) { return `${selectedProject}:${item.id}` }
  function stashDraft(selectedProject = project()) { const item = current(); if (!item) return; const key = draftId(selectedProject, item); if (draft()) drafts.set(key, { body: draft(), visibility: visibility(), key: retryKey, fingerprint: retryFingerprint }); else drafts.delete(key) }
  function restoreDraft(item: Conversation) { const saved = drafts.get(draftId(project(), item)); draft.set(saved?.body || ''); visibility.set(saved?.visibility || 'public'); retryKey = saved?.key || ''; retryFingerprint = saved?.fingerprint || '' }
  function person(id?: string | number) { return Number(id) ? identities().find(row => String(row.id) === String(id))?.name || `User #${id}` : 'Unassigned' }
  function inboxName(id?: string | number) { const row = inboxes().find(item => String(item.id) === String(id)); return row ? row.name + (row.active ? '' : ' (inactive)') : Number(id) ? `Inbox #${id}` : 'Without team inbox' }
  function candidateDisabled(id: string | number) { const row = agents().find(item => String(item.user_id) === String(id)); return !!row && (row.availability !== 'available' || (current()?.status === 'open' && Number(row.open_count) >= Number(row.capacity) && String(current()?.assignee_id) !== String(id))) }
  function agentLabel(id: string | number) { const row = agents().find(item => String(item.user_id) === String(id)); return `${person(id)}${row ? ` · ${row.availability}, ${row.open_count}/${row.capacity} open` : ''}` }
  function actorLabel(item: Assignment) { return item.source === 'workflow' ? `Workflow run #${item.workflow_run_id}` : item.source === 'ingress' ? 'Default inbox routing' : `${item.source === 'configuration' ? 'Team configuration' : 'Manual change'} · ${person(item.actor_id)}` }
  function syncRouting(item: Conversation) { routingInbox.set(String(item.inbox_id || 0)); routingAssignee.set(String(item.assignee_id || 0)) }
  function listPath(cursor?: string | null) { const query = new URLSearchParams(); if (inboxFilter()) query.set('inboxId', inboxFilter()); if (filter() !== 'all') query.set('status', filter()); if (cursor) query.set('cursor', cursor); return `/api/support/projects/${encodeURIComponent(project())}/inbox?${query}` }
  async function loadCatalog(version: number) {
    const selectedProject = project(), workspace = selectedWorkspace()
    if (!workspace) return
    try {
      const root = `/api/support/projects/${encodeURIComponent(selectedProject)}`, tenant = `/api/support/workspaces/${workspace.id}`
      const [boxes, names, preferences, membership] = await Promise.all([request(root + '/team-inboxes'), request(root + '/agents'), request(tenant + '/routing-agents'), request(tenant + '/support-teams')])
      if (disposed || selectedProject !== project() || version !== generation) return
      inboxes.set((boxes.inboxes || []).map((row: TeamInbox) => ({ ...row, active: Boolean(row.active), is_default: Boolean(row.is_default) })))
      identities.set(names.agents || []); agents.set(preferences.agents || []); teams.set((membership.teams || []).map((row: SupportTeam) => ({ ...row, active: Boolean(row.active) }))); teamMembers.set((membership.members || []).map((row: SupportTeamMember) => ({ ...row, active: Boolean(row.active) })))
    }
    catch (failure) { if (!disposed && selectedProject === project() && version === generation) routingError.set(failure instanceof Error ? failure.message : 'Routing settings could not be loaded.') }
  }
  async function loadHistory() {
    const item = current(), selectedProject = project(), version = selection
    if (!item) return
    try { const data = await request(`/api/support/projects/${encodeURIComponent(selectedProject)}/conversations/${item.id}/routing-audit`); if (!disposed && selectedProject === project() && version === selection) assignments.set(data.assignments || []) }
    catch (failure) { if (!disposed && version === selection) routingError.set(failure instanceof Error ? failure.message : 'Assignment history could not be loaded.') }
  }
  async function changeFilter(value: string) { filter.set(value); await refresh() }
  async function loadMore() {
    if (!nextCursor() || loading()) return
    const version = generation, selectedProject = project(); loading.set(true)
    try { const data = await request(listPath(nextCursor())); if (disposed || version !== generation || selectedProject !== project()) return; conversations.update(rows => [...rows, ...(data.conversations || []).filter((row: Conversation) => !rows.some(item => String(item.id) === String(row.id)))]); nextCursor.set(data.nextCursor || null) }
    catch (failure) { if (!disposed && version === generation) error.set(failure instanceof Error ? failure.message : 'More conversations could not be loaded.') }
    finally { if (!disposed && version === generation) loading.set(false) }
  }
  async function route(mode: 'manual' | 'auto', selfAction?: 'claim' | 'release') {
    const item = current(), selectedProject = project(), selected = selection
    if (!item || threadLoading() || routingBusy() || sending() || (!canManage() && !selfAction)) return
    const payload = selfAction ? { mode: 'manual', assigneeId: selfAction === 'claim' ? Number(user()?.id) : 0 } : { mode, ...((mode === 'auto' || String(item.inbox_id || 0) !== routingInbox()) ? { inboxId: Number(routingInbox()) } : {}), ...(mode === 'manual' ? { assigneeId: Number(routingAssignee()) } : {}) }
    const fingerprint = JSON.stringify({ project: selectedProject, conversationId: item.id, payload })
    if (!routingKey || routingFingerprint !== fingerprint) { routingKey = crypto.randomUUID(); routingFingerprint = fingerprint }
    routingBusy.set(true); routingError.set(''); routingNotice.set('')
    try {
      const data = await request(`/api/support/projects/${encodeURIComponent(selectedProject)}/conversations/${item.id}/routing`, { method: 'POST', body: JSON.stringify({ ...payload, idempotencyKey: routingKey }) })
      if (!data.conversation?.id || !data.routing) throw new Error('Assignment could not be confirmed. Retry the same operation; your reply draft is unchanged.')
      routingKey = ''; routingFingerprint = ''
      if (disposed || selectedProject !== project() || selected !== selection) return
      current.set(data.conversation); syncRouting(data.conversation); conversations.update(rows => rows.map(row => String(row.id) === String(item.id) ? { ...row, ...data.conversation } : row)); routingNotice.set(routingReasonLabel(data.reason)); await Promise.all([loadCatalog(generation), loadHistory()])
    }
    catch (failure) { if (!disposed && selected === selection) { routingError.set(failure instanceof Error ? failure.message : 'Assignment was not saved. Your reply draft is unchanged.'); await loadCatalog(generation) } }
    finally { if (!disposed) routingBusy.set(false) }
  }
  let activeProject = ''
  let generation = 0
  let selection = 0
  let csrf = ''
  let retryKey = ''
  let disposed = false
  const filtered = derived(() => conversations().filter(item => (filter() === 'all' || item.status === filter()) && item.subject.toLowerCase().includes(search().toLowerCase())))
  const needsProject = derived(() => !!user() && !needsWorkspace() && !projects().length)
  const selectedTitle = derived(() => current()?.subject || 'Your shared inbox')
  const customerName = derived(() => contact()?.name || contact()?.email || 'Customer')
  const customerInitial = derived(() => customerName().charAt(0).toUpperCase())

  async function request(path: string, options: RequestInit = {}) {
    if (options.method && options.method !== 'GET' && !csrf) {
      const response = await fetch('/api/csrf-token', { credentials: 'include', cache: 'no-store' })
      const data = await response.json()
      csrf = data.token || data.csrf_token || data.csrfToken || ''
    }
    const response = await fetch(path, { ...options, cache: 'no-store', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(csrf ? { 'X-CSRF-TOKEN': csrf } : {}), ...options.headers } })
    const data = await response.json().catch(() => { if (response.ok) throw new Error('The server response could not be read. Retry the same operation; your draft is unchanged.'); return {} })
    if (response.status === 401) {
      const failure = new Error('Sign in to open your workspace.')
      Object.assign(failure, { unauthorized: true })
      throw failure
    }
    if (!response.ok) { const failure = new Error(data.message || data.error?.message || (typeof data.error === 'string' ? data.error : '') || `Request failed (${response.status}).`); Object.assign(failure, { code: data.error?.code }); throw failure }
    return data
  }

  async function load() {
    error.set('')
    loading.set(true)
    try {
      const data = await request('/api/support/me')
      if (disposed) return
      user.set(data.user)
      workspaces.set(data.workspaces || [])
      projects.set(data.projects || [])
      needsWorkspace.set(!data.workspaces?.length)
      if (data.projects?.length) {
        project.set(String(data.projects[0].public_id || data.projects[0].id))
        activeProject = project()
        await refresh()
      }
    }
    catch (failure) { if (!disposed) error.set(failure instanceof Error ? failure.message : 'Your workspace could not be loaded.') }
    finally { if (!disposed) loading.set(false) }
  }

  async function refresh() {
    if (!project()) return
    const version = ++generation
    error.set('')
    loading.set(true)
    try {
      const [data] = await Promise.all([request(listPath()), loadCatalog(version)])
      if (disposed || version !== generation) return
      conversations.set(data.conversations || [])
      nextCursor.set(data.nextCursor || null)
      const selected = (data.conversations || []).find((row: Conversation) => String(row.id) === String(current()?.id))
      if (selected && current()) current.set({ ...current()!, ...selected })
    }
    catch (failure) { if (!disposed && version === generation) error.set(failure instanceof Error ? failure.message : 'Inbox could not be refreshed.') }
    finally { if (!disposed && version === generation) loading.set(false) }
  }

  async function changeProject() {
    stashDraft(activeProject)
    selection++
    current.set(null)
    contact.set(null)
    messages.set([])
    draft.set('')
    retryKey = ''; retryFingerprint = ''; inboxFilter.set(''); inboxes.set([]); identities.set([]); agents.set([]); teams.set([]); teamMembers.set([]); assignments.set([]); routingError.set(''); routingNotice.set(''); activeProject = project()
    await refresh()
  }

  async function select(item: Conversation) {
    if (sending() || routingBusy()) return
    stashDraft()
    const version = ++selection
    const selectedProject = project()
    current.set(item)
    messages.set([])
    contact.set(null)
    restoreDraft(item)
    syncRouting(item); assignments.set([]); routingError.set(''); routingNotice.set('')
    error.set('')
    notice.set('Loading conversation...'); threadLoading.set(true)
    try {
      const data = await request(`/api/support/projects/${encodeURIComponent(selectedProject)}/conversations/${encodeURIComponent(String(item.id))}`)
      if (disposed || version !== selection || selectedProject !== project()) return
      current.set(data.conversation); syncRouting(data.conversation)
      messages.set(data.messages || [])
      contact.set(data.contact || null)
      notice.set(''); await loadHistory()
    }
    catch (failure) { if (!disposed && version === selection) { error.set(failure instanceof Error ? failure.message : 'Conversation could not be loaded.'); notice.set('') } }
    finally { if (!disposed && version === selection) threadLoading.set(false) }
  }

  async function markRead() {
    const item = current()
    const last = messages().reduce((latest, message) => Number(message.id) > Number(latest) ? String(message.id) : latest, '')
    if (!item || !last || error()) return
    const selectedProject = project()
    try {
      const result = await request(`/api/support/projects/${encodeURIComponent(selectedProject)}/conversations/${encodeURIComponent(String(item.id))}/read`, { method: 'POST', body: JSON.stringify({ lastMessageId: last }) })
      if (disposed || selectedProject !== project()) return
      conversations.update(items => items.map(row => String(row.id) === String(item.id) ? { ...row, unread_count: Number(result.unreadCount) } : row))
    }
    catch (failure) { if (!disposed) notice.set(failure instanceof Error ? failure.message : 'The read marker could not be saved.') }
  }

  async function send() {
    const body = draft().trim()
    const item = current()
    if (!item || !body || !contact() || threadLoading() || sending() || routingBusy()) return
    const selectedProject = project()
    sending.set(true)
    error.set('')
    try {
      const fingerprint = JSON.stringify({ project: selectedProject, id: item.id, body, visibility: visibility() })
      if (!retryKey || retryFingerprint !== fingerprint) { retryKey = crypto.randomUUID(); retryFingerprint = fingerprint }
      const result = await request(`/api/support/projects/${encodeURIComponent(selectedProject)}/conversations/${encodeURIComponent(String(item.id))}/messages`, { method: 'POST', body: JSON.stringify({ body, visibility: visibility(), idempotencyKey: retryKey }) })
      if (!result.message?.id) throw new Error('Reply could not be confirmed. Retry without changing the draft to recover the same message.')
      if (disposed || selectedProject !== project()) return
      notice.set(visibility() === 'internal' ? 'Internal note saved.' : 'Reply saved.')
      draft.set(''); drafts.delete(draftId(selectedProject, item))
      retryKey = ''; retryFingerprint = ''
      await selectAfterSend(item)
    }
    catch (failure) { if (!disposed) { stashDraft(); error.set(failure instanceof Error ? failure.message : 'Message was not sent. Your draft is saved here.') } }
    finally { if (!disposed) sending.set(false) }
  }

  async function selectAfterSend(item: Conversation) {
    const data = await request(`/api/support/projects/${encodeURIComponent(project())}/conversations/${encodeURIComponent(String(item.id))}`)
    if (disposed) return
    messages.set(data.messages || [])
    current.set(data.conversation)
    notice.set(visibility() === 'internal' ? 'Internal note saved.' : 'Reply saved.')
  }

  async function changeStatus() {
    const item = current()
    if (!item || !contact() || threadLoading() || sending() || routingBusy()) return
    sending.set(true)
    error.set('')
    try {
      const status = item.status === 'closed' ? 'open' : 'closed'
      const data = await request(`/api/support/projects/${encodeURIComponent(project())}/conversations/${encodeURIComponent(String(item.id))}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      if (disposed) return
      current.set(data.conversation); syncRouting(data.conversation)
      conversations.update(items => items.map(row => String(row.id) === String(item.id) ? { ...row, ...data.conversation } : row))
      routingNotice.set(routingReasonLabel(data.reason)); await Promise.all([loadCatalog(generation), loadHistory()])
      notice.set(status === 'closed' ? 'Conversation resolved.' : 'Conversation reopened.')
    }
    catch (failure) { error.set(failure instanceof Error ? failure.message : 'Status could not be changed.') }
    finally { sending.set(false) }
  }

  async function createWorkspace() {
    if (!workspaceName().trim() || creating()) return
    creating.set(true)
    error.set('')
    try {
      await request('/api/support/workspaces', { method: 'POST', body: JSON.stringify({ name: workspaceName().trim() }) })
      await load()
    }
    catch (failure) { error.set(failure instanceof Error ? failure.message : 'Workspace could not be created.') }
    finally { creating.set(false) }
  }

  async function createProject() {
    if (!projectName().trim() || creating() || !workspaces()[0]) return
    creating.set(true)
    error.set('')
    try {
      await request(`/api/support/workspaces/${encodeURIComponent(String(workspaces()[0]!.id))}/projects`, { method: 'POST', body: JSON.stringify({ name: projectName().trim() }) })
      await load()
    }
    catch (failure) { error.set(failure instanceof Error ? failure.message : 'Project could not be created.') }
    finally { creating.set(false) }
  }

  function formatDate(value?: string) {
    if (!value) return ''
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  function destroy() { disposed = true; generation++; selection++; drafts.clear(); for (const cleanup of detailsCleanup.splice(0)) cleanup(); detailsScroll?.set(false); detailsOpener = null }
  return { narrowDetails, setupDetails, openDetails, closeDetails, toggleDetails, threadLoading, inboxes, identities, agents, teams, teamMembers, inboxFilter, nextCursor, routingInbox, routingAssignee, routingBusy, routingError, routingNotice, assignments, canManage, canAutoRoute, candidateAgents, person, inboxName, candidateDisabled, agentLabel, actorLabel, routingReasonLabel, loadHistory, changeFilter, loadMore, route, user, workspaces, projectName, needsProject, createProject, projects, project, conversations, current, messages, contact, search, filter, draft, visibility, loading, sending, error, notice, workspaceName, creating, needsWorkspace, detailsOpen, filtered, selectedTitle, customerName, customerInitial, load, refresh, changeProject, select, markRead, send, changeStatus, createWorkspace, formatDate, destroy }
}
