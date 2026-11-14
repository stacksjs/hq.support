import { derived, state } from '@stacksjs/stx'

interface Project { id: string | number, public_id: string, name: string, workspace_id: string | number }
interface Conversation { id: string | number, subject: string, status: string, customer_id?: string | number, updated_at?: string, unread_count?: number }
interface Message { id: string | number, body: string, visibility: string, author_type: string, created_at: string }
interface Contact { id?: string | number, name?: string, email?: string, company?: string }

export function createInbox() {
  const user = state<{ name: string, email: string } | null>(null)
  const workspaces = state<{ id: string | number, name: string }[]>([])
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
  const sending = state(false)
  const error = state('')
  const notice = state('')
  const workspaceName = state('')
  const projectName = state('')
  const creating = state(false)
  const needsWorkspace = state(false)
  const detailsOpen = state(true)
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
    const data = await response.json().catch(() => ({}))
    if (response.status === 401) {
      const failure = new Error('Sign in to open your workspace.')
      Object.assign(failure, { unauthorized: true })
      throw failure
    }
    if (!response.ok)
      throw new Error(data.message || data.error?.message || (typeof data.error === 'string' ? data.error : '') || `Request failed (${response.status}).`)
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
      const data = await request(`/api/support/projects/${encodeURIComponent(project())}/inbox`)
      if (disposed || version !== generation) return
      conversations.set(data.conversations || [])
      if (current() && !data.conversations?.some((item: Conversation) => String(item.id) === String(current()?.id))) {
        current.set(null)
        messages.set([])
        contact.set(null)
      }
    }
    catch (failure) { if (!disposed && version === generation) error.set(failure instanceof Error ? failure.message : 'Inbox could not be refreshed.') }
    finally { if (!disposed && version === generation) loading.set(false) }
  }

  async function changeProject() {
    selection++
    current.set(null)
    contact.set(null)
    messages.set([])
    draft.set('')
    retryKey = ''
    await refresh()
  }

  async function select(item: Conversation) {
    if (sending()) return
    const version = ++selection
    const selectedProject = project()
    current.set(item)
    messages.set([])
    contact.set(null)
    draft.set('')
    visibility.set('public')
    error.set('')
    notice.set('Loading conversation...')
    retryKey = ''
    try {
      const data = await request(`/api/support/projects/${encodeURIComponent(selectedProject)}/conversations/${encodeURIComponent(String(item.id))}`)
      if (disposed || version !== selection || selectedProject !== project()) return
      current.set(data.conversation)
      messages.set(data.messages || [])
      contact.set(data.contact || null)
      notice.set('')
    }
    catch (failure) { if (!disposed && version === selection) { error.set(failure instanceof Error ? failure.message : 'Conversation could not be loaded.'); notice.set('') } }
  }

  async function send() {
    const body = draft().trim()
    const item = current()
    if (!item || !body || sending()) return
    const selectedProject = project()
    sending.set(true)
    error.set('')
    try {
      retryKey ||= crypto.randomUUID()
      await request(`/api/support/projects/${encodeURIComponent(selectedProject)}/conversations/${encodeURIComponent(String(item.id))}/messages`, { method: 'POST', body: JSON.stringify({ body, visibility: visibility(), idempotencyKey: retryKey }) })
      if (disposed || selectedProject !== project()) return
      draft.set('')
      retryKey = ''
      await selectAfterSend(item)
    }
    catch (failure) { if (!disposed) error.set(failure instanceof Error ? failure.message : 'Message was not sent. Your draft is saved here.') }
    finally { if (!disposed) sending.set(false) }
  }

  async function selectAfterSend(item: Conversation) {
    const data = await request(`/api/support/projects/${encodeURIComponent(project())}/conversations/${encodeURIComponent(String(item.id))}`)
    if (disposed) return
    messages.set(data.messages || [])
    current.set(data.conversation)
    notice.set(visibility() === 'internal' ? 'Internal note saved.' : 'Reply sent.')
  }

  async function changeStatus() {
    const item = current()
    if (!item || sending()) return
    sending.set(true)
    error.set('')
    try {
      const status = item.status === 'closed' ? 'open' : 'closed'
      await request(`/api/support/projects/${encodeURIComponent(project())}/conversations/${encodeURIComponent(String(item.id))}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      current.set({ ...item, status })
      conversations.update(items => items.map(row => String(row.id) === String(item.id) ? { ...row, status } : row))
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
  function destroy() { disposed = true; generation++; selection++ }
  return { user, workspaces, projectName, needsProject, createProject, projects, project, conversations, current, messages, contact, search, filter, draft, visibility, loading, sending, error, notice, workspaceName, creating, needsWorkspace, detailsOpen, filtered, selectedTitle, customerName, customerInitial, load, refresh, changeProject, select, send, changeStatus, createWorkspace, formatDate, destroy }
}
