import { derived, state } from '@stacksjs/stx'

export interface SupportProject { id: number, public_id: string, name: string, workspace_id: number }
export interface SupportWorkspace { id: number, name: string, plan: string, role: string }

export function createSupportConsole() {
  const projects = state<SupportProject[]>([])
  const workspaces = state<SupportWorkspace[]>([])
  const project = state('')
  const loading = state(false)
  const pending = state(false)
  const error = state('')
  const notice = state('')
  const ready = state(false)
  const workspace = derived(() => workspaces().find(item => Number(item.id) === Number(projects().find(row => row.public_id === project())?.workspace_id)))
  const canManage = derived(() => ['owner', 'admin'].includes(workspace()?.role || ''))
  let csrf = ''
  let version = 0
  let disposed = false

  async function request(path: string, options: RequestInit = {}) {
    if (options.method && options.method !== 'GET' && !csrf) {
      const response = await fetch('/api/csrf-token', { credentials: 'same-origin', cache: 'no-store' })
      const data = await response.json()
      if (!response.ok || !data.token) throw new Error('A secure session could not be started. Refresh and try again.')
      csrf = data.token
    }
    const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...options.headers } })
    const data = await response.json().catch(() => { if (response.ok) throw new Error('The server returned an unreadable response. Refresh and try again.'); return {} })
    if (!response.ok) throw new Error(data.error?.message || data.message || (typeof data.error === 'string' ? data.error : '') || `Request failed (${response.status}).`)
    return data
  }
  function projectPath(suffix: string) { if (!project()) throw new Error('Select a project first.'); return `/api/support/projects/${encodeURIComponent(project())}${suffix}` }
  async function boot() {
    loading.set(true)
    error.set('')
    try {
      const data = await request('/api/support/me')
      if (disposed) return
      projects.set(data.projects || [])
      workspaces.set(data.workspaces || [])
      project.set(data.projects?.[0]?.public_id || '')
      ready.set(true)
    }
    catch (failure) { error.set(failure instanceof Error ? failure.message : 'Your workspace could not be loaded.') }
    finally { loading.set(false) }
  }
  async function run<T>(operation: () => Promise<T>, busy = loading): Promise<T | undefined> {
    const current = ++version
    busy.set(true)
    error.set('')
    try {
      const result = await operation()
      if (disposed || current !== version) return
      return result
    }
    catch (failure) { if (!disposed && current === version) error.set(failure instanceof Error ? failure.message : 'Request could not be completed.') }
    finally { if (!disposed && current === version) busy.set(false) }
  }
  function destroy() { disposed = true; version++ }
  return { projects, workspaces, project, workspace, canManage, loading, pending, error, notice, ready, request, projectPath, boot, run, destroy }
}
