import { derived, state } from '@stacksjs/stx'
import { createSavedReplyEditor } from './saved-replies'

interface Project { workspace_id: number, public_id: string, name: string, allowed_origins: string, anonymous_enabled: boolean }
interface KeyMetadata { id: string, scope: string, status: 'active' | 'revoked', createdAt: string, revokedAt: number }
interface KeyOperation { project: string, kind: 'create' | 'rotate', id?: string, operationId: string }
interface Workspace { id: number, name: string, plan: string, role: string }
type PreviewStatus = 'compatible' | 'skipped' | 'needs_review'
interface PreviewRecord { position: number, entityType: string, sourceId: string | null, status: PreviewStatus, errorCode: string | null }
interface MigrationPreview {
  totalRecords: number
  compatibleRecords: number
  skippedRecords: number
  reviewRecords: number
  records: PreviewRecord[]
}
const previewStatusLabels: Record<PreviewStatus, string> = {
  compatible: 'Compatible',
  skipped: 'Skipped',
  needs_review: 'Needs review',
}
const previewPageSize = 25
function isMigrationPreview(value: unknown): value is MigrationPreview {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<MigrationPreview> & { dryRun?: unknown }
  if (result.dryRun !== true || !Array.isArray(result.records) || result.totalRecords !== result.records.length) return false

  const counts = { compatible: 0, skipped: 0, needs_review: 0 }
  for (const [position, row] of result.records.entries()) {
    if (!row || row.position !== position || typeof row.entityType !== 'string'
      || typeof row.status !== 'string' || !Object.hasOwn(previewStatusLabels, row.status)
      || (row.sourceId !== null && typeof row.sourceId !== 'string')
      || (row.errorCode !== null && typeof row.errorCode !== 'string')) return false
    counts[row.status]++
  }
  return counts.compatible === result.compatibleRecords
    && counts.skipped === result.skippedRecords && counts.needs_review === result.reviewRecords
}

export function createSupportSettings() {
  const projects = state<Project[]>([])
  const workspaces = state<Workspace[]>([])
  const project = state('')
  const origins = state('')
  const anonymous = state(false)
  const pending = state(false)
  const signingOut = state(false)
  const error = state('')
  const notice = state('')
  const keys = state<{ ingestKey?: string, readKey?: string, secret?: string, scope?: string }>({})
  const keyList = state<KeyMetadata[]>([])
  const keyCursor = state<string | null>(null)
  const keyRetry = state(false)
  const migrationPreview = state<MigrationPreview | null>(null)
  const migrationFile = state<File | null>(null)
  const migrationError = state('')
  const migrationBusy = state(false)
  const migrationReviewOnly = state(false)
  const migrationPage = state(0)
  const migrationMatches = derived(() => (migrationPreview()?.records ?? [])
    .filter(row => !migrationReviewOnly() || row.status === 'needs_review'))
  const migrationPageCount = derived(() => Math.ceil(migrationMatches().length / previewPageSize))
  const migrationRecords = derived(() => {
    const start = migrationPage() * previewPageSize
    return migrationMatches().slice(start, start + previewPageSize)
  })
  let migrationInput: HTMLInputElement | undefined
  let migrationRequest: AbortController | undefined
  let operation: KeyOperation | undefined
  let generation = 0, keyRequest = 0, destroyed = false
  let logoutRequest: Promise<void> | undefined
  const available = (current = generation) => !destroyed && !signingOut() && current === generation
  const savedReplyEditor = createSavedReplyEditor(project, canAdmin, (path, options) => request(path, options, generation))
  function clearCredentials() {
    generation++
    keyRequest++
    operation = undefined
    savedReplyEditor.reset()
    resetMigrationResult()
    if (migrationInput) migrationInput.value = ''
    migrationInput = undefined
    migrationFile.set(null)
    keys.set({})
    keyList.set([])
    keyCursor.set(null)
    keyRetry.set(false)
  }
  function canAdmin() {
    if (!available()) return false
    const selected = projects().find(item => item.public_id === project())
    return workspaces().some(item => String(item.id) === String(selected?.workspace_id) && ['owner', 'admin'].includes(item.role))
  }
  let csrf = ''
  async function request(path: string, options: RequestInit = {}, current?: number) {
    const checkContext = () => { if (current !== undefined && !available(current)) throw new Error('Settings credential context has ended.') }
    checkContext()
    if (options.method && !csrf) {
      const result = await fetch('/api/csrf-token', { credentials: 'same-origin', cache: 'no-store' })
      const token = (await result.json()).token
      checkContext()
      csrf = token
    }
    checkContext()
    const result = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), Accept: 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) } })
    const data = await result.json().catch(() => ({}))
    if (!result.ok) throw new Error(data.message || data.error?.message || (typeof data.error === 'string' ? data.error : '') || `Request failed (${result.status}).`)
    return data
  }
  function resetMigrationResult() {
    migrationRequest?.abort()
    migrationRequest = undefined
    migrationPreview.set(null)
    migrationError.set('')
    migrationBusy.set(false)
    migrationReviewOnly.set(false)
    migrationPage.set(0)
  }
  function chooseMigrationFile(event: Event) {
    if (!canAdmin()) return
    resetMigrationResult()
    migrationInput = event.currentTarget as HTMLInputElement
    migrationFile.set(migrationInput.files?.[0] ?? null)
  }
  async function previewMigration() {
    const selected = project(), current = generation, file = migrationFile()
    if (!file || !canAdmin() || migrationBusy()) return
    resetMigrationResult()
    const controller = new AbortController()
    migrationRequest = controller
    migrationBusy.set(true)
    const form = new FormData()
    form.set('file', file)
    form.set('dryRun', 'true')
    try {
      const response = await request(`/api/support/projects/${encodeURIComponent(selected)}/imports/intercom`, { method: 'POST', body: form, signal: controller.signal }, current)
      if (migrationRequest !== controller || !available(current) || selected !== project()) return
      if (!isMigrationPreview(response)) throw new Error('The migration preview response was incomplete. Try again.')
      migrationReviewOnly.set(response.reviewRecords > 0)
      migrationPreview.set(response)
    }
    catch (failure) {
      if (migrationRequest === controller && available(current))
        migrationError.set(failure instanceof Error ? failure.message : 'The migration preview failed.')
    }
    finally {
      if (migrationRequest === controller) {
        migrationRequest = undefined
        migrationBusy.set(false)
      }
    }
  }
  function setMigrationPage(index: number) {
    if (Number.isSafeInteger(index))
      migrationPage.set(Math.max(0, Math.min(migrationPageCount() - 1, index)))
  }
  function moveMigrationPage(delta: number) {
    setMigrationPage(migrationPage() + delta)
  }
  function jumpToMigrationPage(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    setMigrationPage(input.valueAsNumber - 1)
    input.value = String(migrationPage() + 1)
  }
  function filterMigrationRecords(reviewOnly: boolean) {
    migrationPage.set(0)
    migrationReviewOnly.set(reviewOnly)
  }
  function select() {
    if (!available()) return
    clearCredentials()
    pending.set(false)
    const selected = projects().find(item => item.public_id === project())
    keys.set({})
    notice.set('')
    let allowed: string[] = []
    try { allowed = JSON.parse(selected?.allowed_origins || '[]') }
    catch { allowed = [] }
    origins.set(allowed.join('\n'))
    anonymous.set(!!selected?.anonymous_enabled)
    if (selected && canAdmin()) {
      void loadKeys()
      void savedReplyEditor.list.load()
    }
  }
  async function load() {
    if (!available() || pending()) return
    const current = generation
    pending.set(true)
    error.set('')
    try {
      const data = await request('/api/support/me', {}, current)
      if (!available(current)) return
      projects.set(data.projects || [])
      workspaces.set(data.workspaces || [])
      project.set(data.projects?.[0]?.public_id || '')
      pending.set(false)
      select()
    }
    catch (failure) { if (available(current)) error.set(failure instanceof Error ? failure.message : 'Settings could not be loaded.') }
    finally { if (available(current)) pending.set(false) }
  }
  async function save() {
    if (!project() || pending() || !available()) return
    const current = generation, selected = project()
    pending.set(true)
    error.set('')
    notice.set('')
    try {
      const allowedOrigins = origins().split('\n').map(item => item.trim()).filter(Boolean)
      await request(`/api/support/projects/${encodeURIComponent(selected)}`, { method: 'PATCH', body: JSON.stringify({ allowedOrigins, anonymousEnabled: anonymous() }) }, current)
      if (!available(current)) return
      projects.update(items => items.map(item => item.public_id === selected ? { ...item, allowed_origins: JSON.stringify(allowedOrigins), anonymous_enabled: anonymous() } : item))
      notice.set('Messenger settings saved.')
    }
    catch (failure) { if (available(current)) error.set(failure instanceof Error ? failure.message : 'Settings could not be saved.') }
    finally { if (available(current)) pending.set(false) }
  }
  async function loadKeys(more = false) {
    if (!project() || !canAdmin() || !available()) return
    const current = generation, requestId = ++keyRequest, selected = project(), cursor = more ? keyCursor() : null
    try {
      const result = await request(`/api/support/projects/${encodeURIComponent(selected)}/keys${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {}, current)
      if (!available(current) || requestId !== keyRequest) return
      keyList.set(more ? [...keyList(), ...result.keys] : result.keys)
      keyCursor.set(result.nextCursor)
    }
    catch (failure) { if (available(current) && requestId === keyRequest) error.set(failure instanceof Error ? failure.message : 'Key metadata could not be loaded.') }
  }
  async function changeKeys(kind: 'create' | 'rotate', id?: string) {
    if (!project() || pending() || !canAdmin() || !available()) return
    if (operation && (operation.project !== project() || operation.kind !== kind || operation.id !== id)) return
    operation ??= { project: project(), kind, id, operationId: crypto.randomUUID() }
    const selected = operation, current = generation
    pending.set(true)
    keyRetry.set(false)
    keys.set({})
    error.set('')
    notice.set('')
    try {
      const result = await request(`/api/support/projects/${encodeURIComponent(selected.project)}/keys${kind === 'rotate' ? `/${encodeURIComponent(id!)}/rotate` : ''}`, { method: 'POST', body: JSON.stringify({ idempotencyKey: selected.operationId }) }, current)
      if (!available(current)) return
      operation = undefined
      if (result.revealed) {
        keys.set({ ingestKey: result.ingestKey, readKey: result.readKey, secret: result.secret, scope: result.key?.scope })
        notice.set(kind === 'rotate' ? `Key #${result.replacedKeyId} is revoked. Save replacement #${result.key.id} now; its secret is shown once.` : 'Save these keys securely. They are shown once and are not stored in this browser.')
      }
      else notice.set(`This operation already completed. Its secrets cannot be recovered. ${result.key ? `Replacement #${result.key.id} is ${result.key.status}. ` : ''}To obtain a fresh secret, explicitly rotate an active key below.`)
      await loadKeys()
    }
    catch (failure) {
      if (available(current)) {
        keyRetry.set(true)
        error.set(`${failure instanceof Error ? failure.message : 'Key operation failed.'} Retry this operation to learn whether it committed; a secret is never replayed.`)
      }
    }
    finally { if (available(current)) pending.set(false) }
  }
  const issueKeys = () => changeKeys('create')
  const rotateKey = (id: string) => changeKeys('rotate', id)
  function retryKeys() { if (operation) return changeKeys(operation.kind, operation.id) }
  function discardRetry() {
    if (!available() || pending()) return
    operation = undefined
    keyRetry.set(false)
    error.set('')
    notice.set('Retry context discarded. Review the key list and explicitly rotate an active key if its secret was lost.')
    void loadKeys()
  }
  async function revokeKey(id: string) {
    if (pending() || keyRetry() || !canAdmin() || !available()) return
    const selected = project(), current = generation
    pending.set(true)
    keys.set({})
    error.set('')
    try {
      await request(`/api/support/projects/${encodeURIComponent(selected)}/keys/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: '{}' }, current)
      if (!available(current)) return
      notice.set(`Key #${id} is revoked. New requests using it are denied.`)
      await loadKeys()
    }
    catch (failure) { if (available(current)) error.set(failure instanceof Error ? failure.message : 'Key revocation failed. Retrying revoke is safe.') }
    finally { if (available(current)) pending.set(false) }
  }
  async function signOut() {
    if (destroyed) return
    if (logoutRequest) return await logoutRequest
    // Terminal for this controller even if logout fails or navigation stalls.
    // The logout button itself remains callable so native logout can be retried.
    signingOut.set(true)
    clearCredentials()
    pending.set(true)
    notice.set('')
    error.set('')
    logoutRequest = request('/api/logout', { method: 'POST', body: '{}' }).then(() => undefined)
    try { await logoutRequest }
    finally { logoutRequest = undefined }
  }
  function destroy() { destroyed = true; clearCredentials(); pending.set(false) }
  return { savedReplyEditor, migrationPreview, migrationFile, migrationError, migrationBusy, migrationReviewOnly, migrationPage, migrationPageCount, migrationRecords,
    migrationStatusLabel: (status: PreviewStatus) => previewStatusLabels[status], chooseMigrationFile, previewMigration, moveMigrationPage, jumpToMigrationPage, filterMigrationRecords,
    projects, workspaces, project, origins, anonymous, pending, signingOut, error, notice, keys, keyList, keyCursor, keyRetry, canAdmin, loadKeys, rotateKey, revokeKey, retryKeys, discardRetry, load, select, save, issueKeys, signOut, destroy }
}
