import { state } from '@stacksjs/stx'

interface SavedReply { id: string, name: string, body: string, revision: number }

function savedRepliesPath(project: string) {
  return `/api/support/projects/${encodeURIComponent(project)}/saved-replies`
}

function isSavedReply(value: unknown): value is SavedReply {
  if (!value || typeof value !== 'object') return false
  const reply = value as Partial<SavedReply>
  return typeof reply.id === 'string' && /^\d+$/.test(reply.id) && typeof reply.name === 'string'
    && typeof reply.body === 'string' && typeof reply.revision === 'number' && Number.isSafeInteger(reply.revision) && reply.revision > 0
}

export function createSavedReplyList(project: () => string, available: () => boolean, request: (path: string, options?: RequestInit) => Promise<unknown>) {
  const items = state<SavedReply[]>([])
  const search = state('')
  const cursor = state<string | null>(null)
  const loading = state(false)
  const error = state('')
  let controller: AbortController | undefined
  let loadedSearch = ''

  function reset() {
    controller?.abort()
    controller = undefined
    loadedSearch = ''
    items.set([])
    cursor.set(null)
    search.set('')
    loading.set(false)
    error.set('')
  }

  async function load(more = false) {
    const selected = project()
    if (!selected || !available() || (more && (loading() || !cursor()))) return
    controller?.abort()
    const current = new AbortController()
    controller = current
    const isCurrent = () => controller === current && selected === project() && available()
    const query = new URLSearchParams()
    if (more) query.set('cursor', cursor()!)
    else {
      loadedSearch = search().trim()
      items.set([])
      cursor.set(null)
    }
    if (loadedSearch) query.set('q', loadedSearch)
    loading.set(true)
    error.set('')
    try {
      const result = await request(`${savedRepliesPath(selected)}?${query}`, { signal: current.signal }) as { replies?: unknown, nextCursor?: unknown } | null
      if (!isCurrent()) return
      if (!Array.isArray(result?.replies) || !result.replies.every(isSavedReply)
        || (result.nextCursor !== null && (typeof result.nextCursor !== 'string' || !/^\d+$/.test(result.nextCursor)))) {
        throw new Error('Saved replies could not be confirmed.')
      }
      items.set(more ? [...items(), ...result.replies] : result.replies)
      cursor.set(result.nextCursor)
    }
    catch (failure) {
      if (isCurrent()) error.set(failure instanceof Error ? failure.message : 'Saved replies could not be loaded.')
    }
    finally {
      if (controller === current) {
        controller = undefined
        loading.set(false)
      }
    }
  }

  return { items, search, cursor, loading, error, load, reset }
}

export function createSavedReplyEditor(project: () => string, available: () => boolean, request: (path: string, options?: RequestInit) => Promise<unknown>) {
  const list = createSavedReplyList(project, available, request)
  const name = state('')
  const body = state('')
  const editing = state<SavedReply | null>(null)
  const busy = state(false)
  const error = state('')
  const notice = state('')
  let generation = 0
  let attempt: { fingerprint: string, key: string } | undefined

  function clearDraft() {
    editing.set(null)
    name.set('')
    body.set('')
    attempt = undefined
    error.set('')
  }

  function reset() {
    generation++
    list.reset()
    clearDraft()
    busy.set(false)
    notice.set('')
  }

  function edit(id: string) {
    if (busy() || !available()) return
    const selected = list.items().find(item => item.id === id)
    if (!selected) return
    clearDraft()
    notice.set('')
    editing.set(selected)
    name.set(selected.name)
    body.set(selected.body)
  }

  async function submit(archiveId?: string) {
    const projectId = project(), selected = editing()
    if (!projectId || !available() || busy()) return
    if (archiveId ? !list.items().some(item => item.id === archiveId) : !name().trim() || !body().trim()) return
    const current = generation
    const isCurrent = () => available() && current === generation && project() === projectId
    const base = savedRepliesPath(projectId)
    const id = archiveId ?? selected?.id
    const path = (id ? `${base}/${encodeURIComponent(id)}` : base) + (archiveId ? '/archive' : '')
    const fields = { name: name().trim(), body: body().trim(), ...(selected ? { revision: selected.revision } : {}) }
    if (!archiveId) {
      const fingerprint = JSON.stringify([path, fields])
      if (attempt?.fingerprint !== fingerprint) attempt = { fingerprint, key: crypto.randomUUID() }
    }
    busy.set(true)
    error.set('')
    notice.set('')
    try {
      const result = await request(path, { method: archiveId || !selected ? 'POST' : 'PATCH', body: archiveId ? '{}' : JSON.stringify({ ...fields, idempotencyKey: attempt?.key }) }) as { reply?: unknown, archived?: unknown } | null
      if (!isCurrent()) return
      if (archiveId ? result?.archived !== true : !isSavedReply(result?.reply)) throw new Error('The change could not be confirmed.')
      if (!archiveId || selected?.id === archiveId) clearDraft()
      notice.set(archiveId ? 'Saved reply archived.' : 'Saved reply saved.')
      await list.load()
    }
    catch (failure) {
      if (isCurrent()) error.set(failure instanceof Error ? failure.message : 'Saved reply could not be updated.')
    }
    finally {
      if (isCurrent()) busy.set(false)
    }
  }

  return { list, name, body, editing, busy, error, notice, edit, clearDraft, reset, submit }
}
