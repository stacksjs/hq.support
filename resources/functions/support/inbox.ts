import { derived, nextTick, state } from '@stacksjs/stx'
import { useEventListener } from '@stacksjs/stx/composables/use-event-listener'
import { useMediaQuery } from '@stacksjs/stx/composables/use-media-query'
import { useScrollLock } from '@stacksjs/stx/composables/use-scroll-lock'
import { useDebounce } from '@stacksjs/stx/composables/use-timer'
import type { AgentIdentity, Assignment, RoutingAgent, SupportTeamMember, SupportTeam, TeamInbox } from './team-routing'
import { routingReasonLabel } from './team-routing'
import { createInboxPresence } from './inbox-presence'

interface Project { id: string | number, public_id: string, name: string, workspace_id: string | number }
interface Conversation { id: string | number, subject: string, status: string, channel?: string, customer_id?: string | number, updated_at?: string, unread_count?: number, assignee_id?: string | number, team_id?: string | number, inbox_id?: string | number, routing_reason?: string, resolved_at?: number, continued_from_id?: string | null, continuation_id?: string | null }
interface ReplyImage { file: File, key: string, id?: string }
interface Message { id: string | number, body: string, visibility: string, author_type: string, created_at: string }
interface Contact { id?: string | number, name?: string, email?: string, company?: string }
interface ThreadAttachment { id: string, fileName: string }
interface ThreadDetail { conversation: Conversation, messages: Message[], messagesNextCursor: string | null, attachments: ThreadAttachment[], attachmentsNextCursor: string | null, contact: Contact | null, lastAgentReplyId?: string }
interface RetentionEvidence {
  scope: 'closed_conversation_content'
  conversationId: string
  projectId: string
  held: boolean
  policy: { days: number, enabled: boolean } | null
  content: { subjectPresent: boolean, messageBodies: number, attachmentRecords: number, attachmentsNotDeleted: number }
  lastRedaction: { auditEventId: string, occurredAt: string } | null
}

function isRecordCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRetentionEvidence(value: unknown): value is RetentionEvidence {
  if (!value || typeof value !== 'object') return false
  const evidence = value as Partial<RetentionEvidence>
  if (evidence.scope !== 'closed_conversation_content' || typeof evidence.conversationId !== 'string'
    || typeof evidence.projectId !== 'string' || typeof evidence.held !== 'boolean') return false

  const { content, policy, lastRedaction } = evidence
  if (!content || typeof content.subjectPresent !== 'boolean' || !isRecordCount(content.messageBodies)
    || !isRecordCount(content.attachmentRecords) || !isRecordCount(content.attachmentsNotDeleted)
    || content.attachmentsNotDeleted > content.attachmentRecords) return false
  if (policy !== null && (!policy || !isRecordCount(policy.days) || policy.days === 0 || typeof policy.enabled !== 'boolean')) return false
  return lastRedaction === null || Boolean(lastRedaction && typeof lastRedaction.auditEventId === 'string'
    && lastRedaction.auditEventId && typeof lastRedaction.occurredAt === 'string' && Number.isFinite(Date.parse(lastRedaction.occurredAt)))
}

export function createInbox() {
  const user = state<{ id: string | number, name: string, email: string } | null>(null)
  const workspaces = state<{ id: string | number, name: string, role: string }[]>([])
  const projects = state<Project[]>([])
  const project = state('')
  const conversations = state<Conversation[]>([])
  const current = state<Conversation | null>(null)
  const messages = state<Message[]>([])
  const messagesNext = state<string | null>(null), messagesLoading = state(false), messagesError = state(false)
  const newerMessagesAvailable = state(false)
  const pendingAgentReply = state<string | null>(null)
  const replyTimelineBlocked = derived(() => newerMessagesAvailable() || pendingAgentReply() !== null)
  let earlierMessagesLoaded = false
  let messagesController: AbortController | undefined
  let latestReview: { selection: number, refreshPending: boolean } | undefined
  const attachments = state<ThreadAttachment[]>([])
  const attachmentsNext = state<string | null>(null), attachmentsLoading = state(false), attachmentsError = state(false)
  let attachmentsRevision = 0
  const contact = state<Contact | null>(null)
  const search = state('')
  const searchError = state(''), searchMode = state('')
  let listController: AbortController | undefined
  const filter = state('open')
  const draft = state('')
  const visibility = state('public')
  const replyImage = state<ReplyImage | null>(null)
  const replyImageError = state('')
  const canAttachReplyImage = derived(() => visibility() === 'public' && ['sms', 'whatsapp', 'discord'].includes(current()?.channel || ''))
  const hasReply = derived(() => Boolean(draft().trim() || (canAttachReplyImage() && replyImage())))
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
  const retentionEvidence = state<RetentionEvidence | null>(null)
  const retentionLoading = state(false)
  const retentionError = state(false)
  let retentionRequest: AbortController | undefined
  const canAutoRoute = derived(() => { const box = inboxes().find(row => String(row.id) === routingInbox()); return !!box && box.active && box.assignment_mode === 'round_robin' && !!teams().find(row => String(row.id) === String(box.team_id))?.active })
  const candidateAgents = derived(() => {
    const selected = inboxes().find(row => String(row.id) === routingInbox())
    return identities().filter(row => !selected || teamMembers().some(item => String(item.team_id) === String(selected.team_id) && String(item.user_id) === String(row.id) && item.active && item.workspace_status === 'active'))
  })
  const drafts = new Map<string, { body: string, visibility: string, image: ReplyImage | null, key: string, fingerprint: string, cursor: string | undefined, replyAtStart: string | null }>()
  let retryFingerprint = '', retryCursor: string | undefined, routingKey = '', routingFingerprint = '', messageRefresh = 0
  const seenReply = state('0'), replyAtStart = state<string | null>(null)
  const presence = createInboxPresence(request, async () => { await refreshConversation() }, conversationAccessLost)
  const viewerNames = derived(() => presence.viewers().map(viewer => person(viewer.userId)).join(', '))
  const composingNames = derived(() => presence.viewers().filter(viewer => viewer.composing).map(viewer => person(viewer.userId)).join(', '))
  const replyChanged = derived(() => visibility() === 'public' && hasReply() && replyAtStart() !== null && Number(presence.latestReply()) > Number(replyAtStart()))
  const collision = derived(() => visibility() === 'public' && hasReply() && (replyChanged() || !!composingNames()))
  function trackReplyDraft(value: string, mode: string, editing = false) {
    if (!value.trim() && !(mode === 'public' && replyImage())) replyAtStart.set(null)
    else if (replyAtStart() === null) replyAtStart.set(seenReply())
    presence.update(editing && mode === 'public' && !!value.trim())
  }
  function draftActivity(event: Event) { trackReplyDraft((event.target as HTMLTextAreaElement).value, visibility(), true) }
  function visibilityActivity(event: Event) {
    const mode = (event.target as HTMLSelectElement).value
    replyImageError.set('')
    trackReplyDraft(draft(), mode)
  }
  function selectReplyImage(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file || !canAttachReplyImage()) return
    if (!['image/jpeg', 'image/png'].includes(file.type)) { replyImageError.set('replyImageType'); return }
    if (!file.size || file.size >= 5000000) { replyImageError.set('replyImageSize'); return }
    replyImage.set({ file, key: crypto.randomUUID() })
    replyImageError.set('')
    trackReplyDraft(draft(), visibility())
  }
  function removeReplyImage() {
    replyImage.set(null)
    replyImageError.set('')
    trackReplyDraft(draft(), visibility())
    document.getElementById('reply-image')?.focus()
  }
  function draftId(selectedProject: string, item: Conversation) { return `${selectedProject}:${item.id}` }
  function stashDraft(selectedProject = project()) {
    const item = current()
    if (!item) return
    const key = draftId(selectedProject, item)
    if (draft() || replyImage()) drafts.set(key, { body: draft(), visibility: visibility(), image: replyImage(), key: retryKey, fingerprint: retryFingerprint, cursor: retryCursor, replyAtStart: replyAtStart() })
    else drafts.delete(key)
  }
  function restoreDraft(item: Conversation) { const saved = drafts.get(draftId(project(), item)); draft.set(saved?.body || ''); visibility.set(saved?.visibility || 'public'); replyImage.set(saved?.image || null); replyImageError.set(''); retryKey = saved?.key || ''; retryFingerprint = saved?.fingerprint || ''; retryCursor = saved?.cursor; replyAtStart.set(saved?.replyAtStart ?? null) }
  function person(id?: string | number) { return Number(id) ? identities().find(row => String(row.id) === String(id))?.name || `User #${id}` : 'Unassigned' }
  function inboxName(id?: string | number) { const row = inboxes().find(item => String(item.id) === String(id)); return row ? row.name + (row.active ? '' : ' (inactive)') : Number(id) ? `Inbox #${id}` : 'Without team inbox' }
  function candidateDisabled(id: string | number) { const row = agents().find(item => String(item.user_id) === String(id)); return !!row && (row.availability !== 'available' || (current()?.status === 'open' && Number(row.open_count) >= Number(row.capacity) && String(current()?.assignee_id) !== String(id))) }
  function agentLabel(id: string | number) { const row = agents().find(item => String(item.user_id) === String(id)); return `${person(id)}${row ? ` · ${row.availability}, ${row.open_count}/${row.capacity} open` : ''}` }
  function actorLabel(item: Assignment) {
    if (item.source === 'workflow') return `Workflow run #${item.workflow_run_id}`
    if (item.source === 'ingress') return 'Default inbox routing'
    if (item.source === 'overflow') return 'Automatic overflow assignment'
    return `${item.source === 'configuration' ? 'Team configuration' : 'Manual change'} · ${person(item.actor_id)}`
  }
  function syncRouting(item: Conversation) { routingInbox.set(String(item.inbox_id || 0)); routingAssignee.set(String(item.assignee_id || 0)) }
  function listPath(cursor?: string | null) { const query = new URLSearchParams(); if (search().trim()) query.set('q', search().trim()); if (inboxFilter()) query.set('inboxId', inboxFilter()); if (filter() !== 'all') query.set('status', filter()); if (cursor) query.set('cursor', cursor); return `/api/support/projects/${encodeURIComponent(project())}/inbox?${query}` }
  function queryIssue() { return search().length > 200 ? 'Search is limited to 200 characters.' : search().trim().length === 1 ? 'Enter at least 2 characters to search subjects and messages.' : '' }
  function cancelList() { generation++; listController?.abort(); listController = undefined; debouncedSearch.cancel() }
  const debouncedSearch = useDebounce(() => { if (!disposed) void refresh() }, 300)
  function searchChanged() {
    cancelList(); conversations.set([]); nextCursor.set(null); searchMode.set(''); error.set(''); searchError.set(queryIssue())
    if (!project() || searchError()) { loading.set(false); return }
    loading.set(true)
    if (!search().trim()) void refresh()
    else debouncedSearch()
  }
  function clearPrivateState() { presence.stop(!disposed); drafts.clear(); conversations.set([]); current.set(null); clearRetentionEvidence(); resetTranscript(); resetAttachments(); contact.set(null); draft.set(''); replyImage.set(null); replyImageError.set(''); seenReply.set('0'); replyAtStart.set(null); visibility.set('public'); search.set(''); searchError.set(''); searchMode.set(''); nextCursor.set(null); inboxes.set([]); identities.set([]); agents.set([]); teams.set([]); teamMembers.set([]); assignments.set([]); routingError.set(''); routingNotice.set(''); routingInbox.set('0'); routingAssignee.set('0'); retryKey = ''; retryFingerprint = ''; retryCursor = undefined; routingKey = ''; routingFingerprint = ''; csrf = '' }
  function conversationAccessLost() {
    selection++
    clearRetentionEvidence()
    const item = current()
    if (item) drafts.delete(draftId(project(), item))
    current.set(null); contact.set(null); resetTranscript(); resetAttachments(); assignments.set([]); draft.set(''); replyImage.set(null); replyImageError.set(''); replyAtStart.set(null); seenReply.set('0'); retryKey = ''; retryFingerprint = ''; retryCursor = undefined
    threadLoading.set(false); sending.set(false); routingBusy.set(false)
    error.set('This conversation is no longer available to your account.')
  }
  function sessionExpired() { cancelList(); selection++; clearPrivateState(); user.set(null); workspaces.set([]); projects.set([]); project.set(''); activeProject = ''; needsWorkspace.set(false); workspaceName.set(''); projectName.set(''); loading.set(false); threadLoading.set(false); sending.set(false); routingBusy.set(false); creating.set(false); notice.set(''); error.set('Sign in to open your workspace.'); if (narrowDetails()) void closeDetails() }
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
  function clearRetentionEvidence() {
    retentionRequest?.abort()
    retentionRequest = undefined
    retentionEvidence.set(null)
    retentionLoading.set(false)
    retentionError.set(false)
  }
  async function loadRetentionEvidence() {
    const item = current()
    const workspace = selectedWorkspace()
    const selectedProject = projects().find(entry => entry.public_id === project())
    if (!item || !workspace || !selectedProject || !canManage() || threadLoading() || retentionLoading()) return

    clearRetentionEvidence()
    const controller = new AbortController()
    retentionRequest = controller
    retentionLoading.set(true)
    const workspaceId = encodeURIComponent(String(workspace.id))
    const conversationId = encodeURIComponent(String(item.id))
    try {
      const evidence: unknown = await request(`/api/support/workspaces/${workspaceId}/enterprise/retention/conversations/${conversationId}`, { signal: controller.signal })
      if (retentionRequest !== controller) return
      if (!isRetentionEvidence(evidence) || evidence.conversationId !== String(item.id)
        || evidence.projectId !== String(selectedProject.id))
        throw new Error('Invalid evidence for the selected conversation.')
      retentionEvidence.set(evidence)
    }
    catch {
      if (retentionRequest === controller) retentionError.set(true)
    }
    finally {
      if (retentionRequest === controller) {
        retentionRequest = undefined
        retentionLoading.set(false)
      }
    }
  }
  async function changeFilter(value: string) { filter.set(value); await refresh() }
  async function loadMore() {
    if (!nextCursor() || loading() || queryIssue()) return
    const version = generation, selectedProject = project(), controller = new AbortController(); listController = controller; loading.set(true)
    try { const data = await request(listPath(nextCursor()), { signal: controller.signal }); if (disposed || version !== generation || selectedProject !== project()) return; conversations.update(rows => [...rows, ...(data.conversations || []).filter((row: Conversation) => !rows.some(item => String(item.id) === String(row.id)))]); nextCursor.set(data.nextCursor || null) }
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
  const filtered = derived(() => conversations().filter(item => filter() === 'all' || item.status === filter()))
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
    const response = await fetch(path, { ...options, cache: 'no-store', credentials: 'include', headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), Accept: 'application/json', ...(csrf ? { 'X-CSRF-TOKEN': csrf } : {}), ...options.headers } })
    const data = await response.json().catch(() => { if (response.ok) throw new Error('The server response could not be read. Retry the same operation; your draft is unchanged.'); return {} })
    if (response.status === 401) {
      if (!disposed) sessionExpired()
      const failure = new Error('Sign in to open your workspace.')
      Object.assign(failure, { unauthorized: true })
      throw failure
    }
    if (!response.ok) { const failure = new Error(data.message || data.error?.message || (typeof data.error === 'string' ? data.error : '') || `Request failed (${response.status}).`); Object.assign(failure, { code: data.error?.code, status: response.status }); throw failure }
    return data
  }

  async function load() {
    clearRetentionEvidence()
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
    finally { if (!disposed && !project()) loading.set(false) }
  }

  async function refresh() {
    if (!project()) return
    cancelList()
    const version = generation, controller = new AbortController(); listController = controller
    error.set(''); searchError.set(queryIssue()); nextCursor.set(null); searchMode.set('')
    if (searchError()) { conversations.set([]); loading.set(false); return }
    loading.set(true)
    try {
      const [data] = await Promise.all([request(listPath(), { signal: controller.signal }), loadCatalog(version)])
      if (disposed || version !== generation) return
      conversations.set(data.conversations || [])
      nextCursor.set(data.nextCursor || null); searchMode.set(data.search?.mode || '')
      const selected = (data.conversations || []).find((row: Conversation) => String(row.id) === String(current()?.id))
      if (selected && current()) current.set({ ...current()!, ...selected })
    }
    catch (failure) { if (!disposed && version === generation) error.set(failure instanceof Error ? failure.message : 'Inbox could not be refreshed.') }
    finally { if (!disposed && version === generation) loading.set(false) }
  }

  async function changeProject() {
    stashDraft(activeProject)
    presence.stop()
    cancelList(); search.set(''); searchError.set(''); searchMode.set(''); nextCursor.set(null); conversations.set([]); threadLoading.set(false)
    selection++
    clearRetentionEvidence()
    current.set(null)
    contact.set(null)
    resetTranscript()
    resetAttachments()
    draft.set('')
    replyImage.set(null)
    replyImageError.set('')
    retryKey = ''; retryFingerprint = ''; retryCursor = undefined; seenReply.set('0'); replyAtStart.set(null); inboxFilter.set(''); inboxes.set([]); identities.set([]); agents.set([]); teams.set([]); teamMembers.set([]); assignments.set([]); routingError.set(''); routingNotice.set(''); activeProject = project()
    await refresh()
  }

  function conversationPath(selectedProject: string, id: string | number) { return `/api/support/projects/${encodeURIComponent(selectedProject)}/conversations/${encodeURIComponent(String(id))}` }
  function threadDetailPath(selectedProject: string, id: string | number, beforeAttachment?: string) {
    const query = new URLSearchParams({ attachmentLimit: '20' })
    if (beforeAttachment) {
      query.set('beforeAttachment', beforeAttachment)
      query.set('limit', '1')
    }
    return `${conversationPath(selectedProject, id)}?${query}`
  }
  function attachmentDownloadPath(id: string) { return `/api/support/projects/${encodeURIComponent(project())}/attachments/${encodeURIComponent(id)}` }
  function resetAttachments(data?: ThreadDetail) {
    attachmentsRevision++
    attachments.set(data?.attachments?.toReversed() ?? [])
    attachmentsNext.set(data?.attachmentsNextCursor ?? null)
    attachmentsLoading.set(false)
    attachmentsError.set(false)
  }
  async function loadOlderAttachments() {
    const item = current(), cursor = attachmentsNext(), selectedProject = project(), selected = selection, revision = attachmentsRevision
    if (!item || !cursor || threadLoading() || attachmentsLoading()) return
    const active = () => !disposed && selected === selection && selectedProject === project() && revision === attachmentsRevision
    const buttonHadFocus = document.activeElement?.id === 'load-older-attachments'
    attachmentsLoading.set(true)
    attachmentsError.set(false)
    try {
      const data: ThreadDetail = await request(threadDetailPath(selectedProject, item.id, cursor))
      if (!active()) return
      if (String(data.conversation.id) !== String(item.id)) throw new Error('Unexpected attachment conversation.')
      const known = new Set(attachments().map(file => file.id))
      const page = data.attachments.toReversed().filter(file => !known.has(file.id))
      attachments.update(files => [...files, ...page])
      attachmentsNext.set(data.attachmentsNextCursor)
      if (buttonHadFocus && !data.attachmentsNextCursor && page.length) {
        await nextTick()
        if (active() && document.activeElement === document.body) document.getElementById(`conversation-attachment-${page[0]!.id}`)?.focus()
      }
    }
    catch { if (active()) attachmentsError.set(true) }
    finally { if (active()) attachmentsLoading.set(false) }
  }
  function resetMessagePages() {
    messagesController?.abort()
    messagesController = undefined
    earlierMessagesLoaded = false
    messagesNext.set(null)
    messagesLoading.set(false)
    messagesError.set(false)
    newerMessagesAvailable.set(false)
  }
  function resetTranscript() {
    resetMessagePages()
    messages.set([])
    pendingAgentReply.set(null)
  }
  function acknowledgeLoadedReply() {
    const pending = pendingAgentReply()
    if (pending === null || !messages().some(message => String(message.id) === pending)) return
    seenReply.set(pending)
    pendingAgentReply.set(null)
  }
  async function loadOlderMessages() {
    const item = current(), cursor = messagesNext(), selectedProject = project(), selected = selection
    if (!item || !cursor || threadLoading() || messagesLoading()) return
    const controller = new AbortController()
    messagesController = controller
    const active = () => !disposed && selected === selection && selectedProject === project() && messagesController === controller
    const buttonHadFocus = document.activeElement?.id === 'load-older-messages'
    messagesLoading.set(true)
    messagesError.set(false)
    try {
      const query = new URLSearchParams({ beforeMessage: cursor, limit: '50', attachmentLimit: '1' })
      const data: ThreadDetail = await request(`${conversationPath(selectedProject, item.id)}?${query}`, { signal: controller.signal })
      if (!active() || messagesNext() !== cursor) return
      if (String(data.conversation.id) !== String(item.id)) throw new Error('Unexpected message conversation.')
      if (data.conversation.subject !== current()?.subject) {
        resetTranscript()
        resetAttachments()
        current.set(data.conversation)
        await reviewReply()
        return
      }
      const known = new Set(messages().map(message => String(message.id)))
      const page = data.messages.filter(message => !known.has(String(message.id)))
      earlierMessagesLoaded = true
      messages.update(items => [...page, ...items])
      messagesNext.set(data.messagesNextCursor)
      acknowledgeLoadedReply()
      if (buttonHadFocus && !data.messagesNextCursor) {
        const oldest = messages()[0]
        await nextTick()
        if (active() && document.activeElement === document.body && oldest) document.getElementById(`thread-message-${oldest.id}`)?.focus()
      }
    }
    catch (failure) {
      if (!active()) return
      const status = (failure as { status?: number })?.status
      if (status === 403 || status === 404) conversationAccessLost()
      else messagesError.set(true)
    }
    finally {
      if (active()) {
        messagesController = undefined
        messagesLoading.set(false)
      }
    }
  }
  function showMessages(data: ThreadDetail, revealLatest = false) {
    const threadMessages = data.messages || []
    const last = threadMessages.reduce((latest, message) => message.visibility === 'public' && message.author_type === 'agent' && Number(message.id) > Number(latest) ? String(message.id) : latest, data.lastAgentReplyId ?? '0')
    const previous = messages()
    const readingOlder = earlierMessagesLoaded || messagesController || messagesError()
    const cachedBodies = readingOlder && new Map(previous.map(message => [String(message.id), message.body]))
    const changedBody = cachedBodies && threadMessages.some(message => cachedBodies.has(String(message.id)) && cachedBodies.get(String(message.id)) !== message.body)
    if (changedBody || current()?.subject !== data.conversation.subject) resetTranscript()
    current.set(data.conversation)
    const shown = messages()
    const first = threadMessages[0]
    const shownNewest = shown.at(-1)
    pendingAgentReply.set((readingOlder || pendingAgentReply() !== null) && Number(last) > Number(seenReply()) ? last : null)
    if (!revealLatest && readingOlder && data.messagesNextCursor && first && shownNewest && Number(first.id) > Number(shownNewest.id)) {
      // Keep the archive visible and the reply cursor tied to the messages displayed.
      newerMessagesAvailable.set(true)
      return
    }
    newerMessagesAvailable.set(false)
    if (first && readingOlder && data.messagesNextCursor && shown.some(message => String(message.id) === String(first.id))) {
      // The refreshed head overlaps the loaded timeline. Keep only its earlier prefix.
      messages.set([...shown.filter(message => Number(message.id) < Number(first.id)), ...threadMessages])
    }
    else {
      if (readingOlder) resetMessagePages()
      messages.set(threadMessages)
      messagesNext.set(data.messagesNextCursor ?? null)
    }
    resetAttachments(data)
    if (pendingAgentReply() === null) seenReply.set(last)
    else acknowledgeLoadedReply()
  }
  async function select(item: Conversation, loaded?: ThreadDetail) {
    if (sending() || routingBusy()) return
    stashDraft()
    presence.stop()
    const version = ++selection
    const selectedProject = project()
    clearRetentionEvidence()
    current.set(item)
    resetTranscript()
    resetAttachments()
    contact.set(null)
    restoreDraft(item)
    syncRouting(item); assignments.set([]); routingError.set(''); routingNotice.set('')
    error.set('')
    notice.set('Loading conversation...'); threadLoading.set(true)
    try {
      const path = conversationPath(selectedProject, item.id)
      const data: ThreadDetail = loaded ?? await request(threadDetailPath(selectedProject, item.id))
      if (disposed || version !== selection || selectedProject !== project()) return
      current.set(data.conversation); syncRouting(data.conversation)
      showMessages(data)
      contact.set(data.contact || null)
      if (draft().trim() && replyAtStart() === null) replyAtStart.set(seenReply())
      presence.start(path + '/presence', seenReply())
      notice.set(''); await loadHistory()
    }
    catch (failure) { if (!disposed && version === selection) { error.set(failure instanceof Error ? failure.message : 'Conversation could not be loaded.'); notice.set('') } }
    finally { if (!disposed && version === selection) threadLoading.set(false) }
  }

  async function openLinked(direction: 'previous' | 'next') {
    const item = current(), selectedProject = project(), selected = selection
    const id = direction === 'previous' ? item?.continued_from_id : item?.continuation_id
    if (!id || threadLoading() || sending() || routingBusy()) return
    stashDraft(); threadLoading.set(true); error.set('')
    try {
      const data: ThreadDetail = await request(threadDetailPath(selectedProject, id))
      if (disposed || selected !== selection || selectedProject !== project()) return
      if (String(data.conversation?.id) !== id) throw new Error('The linked request could not be confirmed. Your current reply draft is unchanged.')
      await select(data.conversation, data)
    }
    catch (failure) { if (!disposed && selected === selection) error.set(failure instanceof Error ? failure.message : 'The linked request could not be loaded. Your draft is unchanged.') }
    finally { if (!disposed && selected === selection) threadLoading.set(false) }
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

  async function refreshConversation(revealLatest = false) {
    const item = current(), selectedProject = project(), selected = selection
    if (!item) return
    if (!revealLatest && latestReview?.selection === selected) {
      latestReview.refreshPending = true
      return
    }
    const refresh = ++messageRefresh
    const data: ThreadDetail = await request(threadDetailPath(selectedProject, item.id))
    if (disposed || selectedProject !== project() || selected !== selection || messageRefresh !== refresh) return
    showMessages(data, revealLatest)
    return true
  }
  async function reviewReply() {
    const selected = selection, jumping = newerMessagesAvailable()
    if (latestReview?.selection === selected) return
    const trigger = document.activeElement
    const review = { selection: selected, refreshPending: false }
    latestReview = review
    error.set('')
    try {
      const refreshed = await refreshConversation(true)
      if (!refreshed || !jumping) return
      const latest = messages().at(-1)
      await nextTick()
      if (disposed || selected !== selection || !latest) return
      if (trigger?.id === 'load-latest-messages' && (document.activeElement === trigger || document.activeElement === document.body))
        document.getElementById(`thread-message-${latest.id}`)?.focus()
      await markRead()
    }
    catch (failure) {
      if (disposed || selected !== selection) return
      const status = (failure as { status?: number })?.status
      if (status === 403 || status === 404) conversationAccessLost()
      else error.set(failure instanceof Error ? failure.message : 'The conversation could not be refreshed.')
    }
    finally {
      if (latestReview === review) {
        latestReview = undefined
        if (review.refreshPending && !disposed && selected === selection) void refreshConversation().catch(() => undefined)
      }
    }
  }
  async function send(confirmed = false) {
    const body = draft().trim()
    const item = current()
    if (!item || !hasReply() || !contact() || threadLoading() || sending() || routingBusy()) return
    const selectedProject = project(), path = conversationPath(selectedProject, item.id)
    const mode = visibility(), isPublic = mode === 'public', image = canAttachReplyImage() ? replyImage() : null
    if (image && image.file.size + new TextEncoder().encode(body).byteLength >= 5000000) {
      replyImageError.set('replyImageSize')
      return
    }
    const fingerprint = JSON.stringify({ project: selectedProject, id: item.id, body, visibility: mode, imageKey: image?.key })
    const retrying = !!retryKey && retryFingerprint === fingerprint
    if (isPublic && replyTimelineBlocked()) return
    if (!retrying && !confirmed && collision()) return
    const acknowledged = Number(presence.latestReply()) > Number(seenReply()) ? presence.latestReply() : seenReply()
    sending.set(true)
    if (isPublic) presence.update(false)
    error.set('')
    replyImageError.set('')
    try {
      if (isPublic && confirmed && !retrying && acknowledged !== seenReply()) {
        await refreshConversation()
        if (seenReply() !== acknowledged) return
      }
      if (disposed || selectedProject !== project() || current()?.id !== item.id) return
      if (!retrying) { retryKey = crypto.randomUUID(); retryFingerprint = fingerprint; retryCursor = isPublic ? confirmed ? acknowledged : replyAtStart() ?? seenReply() : undefined }
      if (image && !image.id) {
        const form = new FormData()
        form.set('file', image.file)
        form.set('idempotencyKey', image.key)
        const result = await request(path + '/attachments', { method: 'POST', body: form })
        if (!result.attachment?.id) throw new Error('Image upload could not be confirmed. Retry with the same image.')
        image.id = String(result.attachment.id)
      }
      if (disposed || selectedProject !== project() || current()?.id !== item.id) return
      const result = await request(path + '/messages', { method: 'POST', body: JSON.stringify({ body, visibility: mode, idempotencyKey: retryKey, afterAgentReplyId: retryCursor, ...(image ? { attachmentIds: [image.id] } : {}) }) })
      if (!result.message?.id) throw new Error('Reply could not be confirmed. Retry without changing the draft to recover the same message.')
      if (disposed || selectedProject !== project()) return
      notice.set(!isPublic ? 'Internal note saved.' : result.delivery ? 'Reply queued.' : 'Reply saved.')
      draft.set('')
      if (image) replyImage.set(null)
      retryKey = ''; retryFingerprint = ''; retryCursor = undefined; trackReplyDraft('', mode)
      stashDraft(selectedProject)
      await selectAfterSend(item, selectedProject)
    }
    catch (failure) {
      if (!disposed && selectedProject === project() && current()?.id === item.id) {
        if ((failure as { code?: string }).code === 'agent_reply_changed') {
          retryKey = ''; retryFingerprint = ''; retryCursor = undefined
          void presence.refresh()
        }
        stashDraft()
        error.set(failure instanceof Error ? failure.message : 'Message was not sent. Your draft is saved here.')
      }
    }
    finally { if (!disposed) sending.set(false) }
  }

  async function selectAfterSend(item: Conversation, selectedProject: string) {
    const selected = selection
    if (latestReview?.selection === selected) {
      latestReview.refreshPending = true
      return
    }
    const refresh = ++messageRefresh
    const data: ThreadDetail = await request(threadDetailPath(selectedProject, item.id))
    if (disposed || selectedProject !== project() || selected !== selection) return
    if (messageRefresh === refresh) showMessages(data)
    current.set(data.conversation)
  }

  async function changeStatus() {
    const item = current(), selectedProject = project(), selected = selection
    if (!item || !contact() || threadLoading() || sending() || routingBusy()) return
    sending.set(true)
    error.set('')
    try {
      const status = item.status === 'closed' ? 'open' : 'closed'
      const data = await request(`/api/support/projects/${encodeURIComponent(selectedProject)}/conversations/${encodeURIComponent(String(item.id))}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      if (disposed || selectedProject !== project() || selected !== selection) return
      current.set(data.conversation); syncRouting(data.conversation)
      conversations.update(items => items.map(row => String(row.id) === String(item.id) ? { ...row, ...data.conversation } : row))
      routingNotice.set(routingReasonLabel(data.reason)); await Promise.all([loadCatalog(generation), loadHistory()])
      notice.set(status === 'closed' ? 'Conversation resolved.' : 'Conversation reopened.')
    }
    catch (failure) { if (!disposed && selected === selection) error.set(failure instanceof Error ? failure.message : 'Status could not be changed.') }
    finally { if (!disposed && selected === selection) sending.set(false) }
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

  function formatDate(value?: string, locale?: string) {
    if (!value) return ''
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  }
  function setupPresence() { detailsCleanup.push(presence.listen()) }
  function destroy() { presence.stop(); disposed = true; cancelList(); selection++; clearPrivateState(); user.set(null); workspaces.set([]); projects.set([]); project.set(''); activeProject = '';  for (const cleanup of detailsCleanup.splice(0)) cleanup(); detailsScroll?.set(false); detailsOpener = null }
  return { retentionEvidence, retentionLoading, retentionError, loadRetentionEvidence, messagesNext, messagesLoading, messagesError, newerMessagesAvailable, pendingAgentReply, replyTimelineBlocked, loadOlderMessages, attachments, attachmentsNext, attachmentsLoading, attachmentsError, attachmentDownloadPath, loadOlderAttachments, canAttachReplyImage, hasReply, replyImage, replyImageError, selectReplyImage, removeReplyImage, searchChanged, searchError, searchMode, narrowDetails, setupDetails, openDetails, closeDetails, toggleDetails, threadLoading, inboxes, identities, agents, teams, teamMembers, inboxFilter, nextCursor, routingInbox, routingAssignee, routingBusy, routingError, routingNotice, assignments, canManage, canAutoRoute, candidateAgents, person, inboxName, candidateDisabled, agentLabel, actorLabel, routingReasonLabel, loadHistory, changeFilter, loadMore, route, user, workspaces, projectName, needsProject, createProject, projects, project, conversations, current, messages, contact, search, filter, draft, visibility, loading, sending, error, notice, workspaceName, creating, needsWorkspace, detailsOpen, filtered, selectedTitle, customerName, customerInitial, load, refresh, changeProject, select, openLinked, markRead, send, changeStatus, createWorkspace, formatDate, destroy, setupPresence, viewerNames, composingNames, replyChanged, collision, draftActivity, visibilityActivity, reviewReply }
}
