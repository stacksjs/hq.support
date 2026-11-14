import { state } from '@stacksjs/stx'

interface Project { public_id: string, name: string, allowed_origins: string, anonymous_enabled: boolean }
interface Workspace { id: number, name: string, plan: string, role: string }
export function createSupportSettings() {
  const projects = state<Project[]>([])
  const workspaces = state<Workspace[]>([])
  const project = state('')
  const origins = state('')
  const anonymous = state(false)
  const pending = state(false)
  const error = state('')
  const notice = state('')
  const keys = state<{ ingestKey?: string, readKey?: string }>({})
  let csrf = ''
  async function request(path: string, options: RequestInit = {}) {
    if (options.method && !csrf) {
      const result = await fetch('/api/csrf-token', { credentials: 'same-origin', cache: 'no-store' })
      csrf = (await result.json()).token
    }
    const result = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) } })
    const data = await result.json().catch(() => ({}))
    if (!result.ok) throw new Error(data.message || data.error?.message || (typeof data.error === 'string' ? data.error : '') || `Request failed (${result.status}).`)
    return data
  }
  function select() {
    const selected = projects().find(item => item.public_id === project())
    keys.set({})
    notice.set('')
    let allowed: string[] = []
    try { allowed = JSON.parse(selected?.allowed_origins || '[]') }
    catch { allowed = [] }
    origins.set(allowed.join('\n'))
    anonymous.set(!!selected?.anonymous_enabled)
  }
  async function load() {
    pending.set(true)
    error.set('')
    try {
      const data = await request('/api/support/me')
      projects.set(data.projects || [])
      workspaces.set(data.workspaces || [])
      project.set(data.projects?.[0]?.public_id || '')
      select()
    }
    catch (failure) { error.set(failure instanceof Error ? failure.message : 'Settings could not be loaded.') }
    finally { pending.set(false) }
  }
  async function save() {
    if (!project() || pending()) return
    pending.set(true)
    error.set('')
    notice.set('')
    try {
      const allowedOrigins = origins().split('\n').map(item => item.trim()).filter(Boolean)
      await request(`/api/support/projects/${encodeURIComponent(project())}`, { method: 'PATCH', body: JSON.stringify({ allowedOrigins, anonymousEnabled: anonymous() }) })
      projects.update(items => items.map(item => item.public_id === project() ? { ...item, allowed_origins: JSON.stringify(allowedOrigins), anonymous_enabled: anonymous() } : item))
      notice.set('Messenger settings saved.')
    }
    catch (failure) { error.set(failure instanceof Error ? failure.message : 'Settings could not be saved.') }
    finally { pending.set(false) }
  }
  async function issueKeys() {
    if (!project() || pending()) return
    pending.set(true)
    keys.set({})
    error.set('')
    try {
      const result = await request(`/api/support/projects/${encodeURIComponent(project())}/keys`, { method: 'POST', body: '{}' })
      keys.set(result)
      notice.set('Save these keys securely. They are shown once and are not stored in this browser.')
    }
    catch (failure) { error.set(failure instanceof Error ? failure.message : 'Keys could not be generated.') }
    finally { pending.set(false) }
  }
  async function signOut() {
    await request('/api/logout', { method: 'POST', body: '{}' })
    keys.set({})
  }
  function destroy() { keys.set({}) }
  return { projects, workspaces, project, origins, anonymous, pending, error, notice, keys, load, select, save, issueKeys, signOut, destroy }
}
