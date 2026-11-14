import { state } from '@stacksjs/stx'

interface Project { workspace_id: number, public_id: string, name: string, allowed_origins: string, anonymous_enabled: boolean }
interface KeyMetadata { id: string, scope: string, status: 'active' | 'revoked', createdAt: string, revokedAt: number }
interface KeyOperation { project: string, kind: 'create' | 'rotate', id?: string, operationId: string }
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
  const keys = state<{ ingestKey?: string, readKey?: string, secret?: string, scope?: string }>({})
  const keyList = state<KeyMetadata[]>([])
  const keyCursor = state<string | null>(null)
  const keyRetry = state(false)
  let operation: KeyOperation | undefined
  let generation = 0, keyRequest = 0, destroyed = false
  function canAdmin() {
    const selected = projects().find(item => item.public_id === project())
    return workspaces().some(item => String(item.id) === String(selected?.workspace_id) && ['owner', 'admin'].includes(item.role))
  }
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
    generation++
    operation = undefined
    keyRetry.set(false)
    keyList.set([])
    keyCursor.set(null)
    const selected = projects().find(item => item.public_id === project())
    keys.set({})
    notice.set('')
    let allowed: string[] = []
    try { allowed = JSON.parse(selected?.allowed_origins || '[]') }
    catch { allowed = [] }
    origins.set(allowed.join('\n'))
    anonymous.set(!!selected?.anonymous_enabled)
    if (selected && canAdmin()) void loadKeys()
  }
  async function load() {
    pending.set(true)
    error.set('')
    try {
      const data = await request('/api/support/me')
      if (destroyed) return
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
  async function loadKeys(more = false) {
    if (!project() || !canAdmin() || destroyed) return
    const current = generation, requestId = ++keyRequest, selected = project(), cursor = more ? keyCursor() : null
    try {
      const result = await request(`/api/support/projects/${encodeURIComponent(selected)}/keys${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
      if (destroyed || current !== generation || requestId !== keyRequest) return
      keyList.set(more ? [...keyList(), ...result.keys] : result.keys)
      keyCursor.set(result.nextCursor)
    }
    catch (failure) { if (!destroyed && current === generation && requestId === keyRequest) error.set(failure instanceof Error ? failure.message : 'Key metadata could not be loaded.') }
  }
  async function changeKeys(kind: 'create' | 'rotate', id?: string) {
    if (!project() || pending() || !canAdmin() || destroyed) return
    if (operation && (operation.project !== project() || operation.kind !== kind || operation.id !== id)) return
    operation ??= { project: project(), kind, id, operationId: crypto.randomUUID() }
    const selected = operation, current = generation
    pending.set(true)
    keyRetry.set(false)
    keys.set({})
    error.set('')
    notice.set('')
    try {
      const result = await request(`/api/support/projects/${encodeURIComponent(selected.project)}/keys${kind === 'rotate' ? `/${encodeURIComponent(id!)}/rotate` : ''}`, { method: 'POST', body: JSON.stringify({ idempotencyKey: selected.operationId }) })
      if (destroyed || current !== generation) return
      operation = undefined
      if (result.revealed) {
        keys.set({ ingestKey: result.ingestKey, readKey: result.readKey, secret: result.secret, scope: result.key?.scope })
        notice.set(kind === 'rotate' ? `Key #${result.replacedKeyId} is revoked. Save replacement #${result.key.id} now; its secret is shown once.` : 'Save these keys securely. They are shown once and are not stored in this browser.')
      }
      else notice.set(`This operation already completed. Its secrets cannot be recovered. ${result.key ? `Replacement #${result.key.id} is ${result.key.status}. ` : ''}To obtain a fresh secret, explicitly rotate an active key below.`)
      await loadKeys()
    }
    catch (failure) {
      if (!destroyed && current === generation) {
        keyRetry.set(true)
        error.set(`${failure instanceof Error ? failure.message : 'Key operation failed.'} Retry this operation to learn whether it committed; a secret is never replayed.`)
      }
    }
    finally { if (!destroyed && current === generation) pending.set(false) }
  }
  const issueKeys = () => changeKeys('create')
  const rotateKey = (id: string) => changeKeys('rotate', id)
  function retryKeys() { if (operation) return changeKeys(operation.kind, operation.id) }
  function discardRetry() {
    operation = undefined
    keyRetry.set(false)
    error.set('')
    notice.set('Retry context discarded. Review the key list and explicitly rotate an active key if its secret was lost.')
    void loadKeys()
  }
  async function revokeKey(id: string) {
    if (pending() || keyRetry() || !canAdmin() || destroyed) return
    const selected = project(), current = generation
    pending.set(true)
    keys.set({})
    error.set('')
    try {
      await request(`/api/support/projects/${encodeURIComponent(selected)}/keys/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: '{}' })
      if (destroyed || current !== generation) return
      notice.set(`Key #${id} is revoked. New requests using it are denied.`)
      await loadKeys()
    }
    catch (failure) { if (!destroyed && current === generation) error.set(failure instanceof Error ? failure.message : 'Key revocation failed. Retrying revoke is safe.') }
    finally { if (!destroyed && current === generation) pending.set(false) }
  }
  async function signOut() {
    await request('/api/logout', { method: 'POST', body: '{}' })
    keys.set({})
  }
  function destroy() { destroyed = true; generation++; operation = undefined; keys.set({}); keyList.set([]); keyCursor.set(null); keyRetry.set(false) }
  return { projects, workspaces, project, origins, anonymous, pending, error, notice, keys, keyList, keyCursor, keyRetry, canAdmin, loadKeys, rotateKey, revokeKey, retryKeys, discardRetry, load, select, save, issueKeys, signOut, destroy }
}
