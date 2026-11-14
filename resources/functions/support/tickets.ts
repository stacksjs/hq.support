import { derived, state } from '@stacksjs/stx'
import { createSupportConsole } from './console'
import { fieldInputs, inputType, normalizeType, ticketStates, typedFields } from './ticket-fields'
import type { TicketForm, TicketType } from './ticket-fields'

interface Sla { cycle: number, phase: string, firstDueAt: number, resolutionDueAt: number, firstResponseAt: number, resolvedAt: number, firstBreachedAt: number, resolutionBreachedAt: number }
interface Ticket { id: string | number, title: string, description: string, status: string, state?: string, kind?: string, priority: string, assignee_id?: number, contact_id: number, conversation_id?: number, created_at: string, updated_at: string, form?: TicketForm, customFields?: Record<string, unknown>, sla?: Sla | null }
interface Relation { id: string | number, kind: string, related_ticket_id: string | number }
interface Source { id: string | number, subject: string, customer_id: string | number }
export function createTickets() {
  const workspace = createSupportConsole()
  const tickets = state<Ticket[]>([]), agents = state<{ id: string, name: string, role: string }[]>([]), types = state<TicketType[]>([])
  const assignee = state(''), selected = state<Ticket | null>(null), query = state(''), filter = state('all'), status = state('open'), priority = state('normal')
  const values = state<Record<string, string>>({}), dirty = state(false), configurationError = state('')
  const relations = state<Relation[]>([]), relationError = state(''), relationKind = state('parent'), relatedId = state('')
  const now = state(Date.now()), creating = state(false), sources = state<Source[]>([]), sourceId = state(''), createTypeId = state(''), title = state(''), description = state(''), createValues = state<Record<string, string>>({})
  const selectedStates = derived(() => selected()?.form?.states?.length ? selected()!.form!.states : ticketStates)
  const selectedFields = derived(() => selected()?.form?.fields || [])
  const createFields = derived(() => types().find(type => String(type.id) === createTypeId())?.fields || [])
  const targets = derived(() => tickets().filter(item => String(item.id) !== String(selected()?.id) && (relationKind() === 'parent' || (item.kind || 'customer') === relationKind())))
  const filtered = derived(() => tickets().filter(item => (filter() === 'all' || item.status === filter()) && item.title.toLowerCase().includes(query().toLowerCase())))
  const slaRows = derived(() => {
    const sla = selected()?.sla
    if (!sla) return []
    return [{ key: 'first', label: 'First public response', due: sla.firstDueAt, done: sla.firstResponseAt, breach: sla.firstBreachedAt }, { key: 'resolution', label: 'Resolution', due: sla.resolutionDueAt, done: sla.resolvedAt, breach: sla.resolutionBreachedAt }].map(row => ({ ...row, outcome: row.done ? row.breach ? 'Completed late' : 'Completed' : row.breach ? 'Breach recorded' : sla.phase === 'paused' ? 'Paused' : sla.phase === 'resolved' ? 'Cycle resolved' : row.due ? row.due <= now() ? 'Deadline reached' : 'Running' : 'No active target', countdown: row.done || row.breach || sla.phase !== 'running' || !row.due ? '' : countdown(row.due) }))
  })
  let projectKey = '', relationVersion = 0, disposed = false, timer: ReturnType<typeof setInterval> | undefined, createKey = '', createFingerprint = ''
  function apply(ticket: Ticket) { selected.set(ticket); status.set(ticket.state || ticket.status); priority.set(ticket.priority); assignee.set(ticket.assignee_id ? String(ticket.assignee_id) : ''); values.set(fieldInputs(ticket.form?.fields || [], ticket.customFields)); dirty.set(false) }
  async function load() {
    if (!workspace.project()) return
    const currentProject = workspace.project(), changed = projectKey !== currentProject
    if (changed) { selected.set(null); tickets.set([]); relations.set([]); dirty.set(false); creating.set(false); configurationError.set(''); relationVersion++ }
    projectKey = currentProject
    const result = await workspace.run(async () => {
      const results = await Promise.allSettled([workspace.request(workspace.projectPath('/tickets')), workspace.request(workspace.projectPath('/agents')), workspace.request(workspace.projectPath('/ticket-configuration'))])
      const list = results[0]
      if (!list || list.status === 'rejected') throw list?.reason || new Error('Tickets could not be loaded.')
      return { tickets: list.value.tickets || [], agents: results[1]?.status === 'fulfilled' ? results[1].value.agents || [] : [], configuration: results[2]?.status === 'fulfilled' ? results[2].value : null, configurationError: results[2]?.status === 'rejected' ? 'Ticket configuration could not be loaded. Existing ticket snapshots remain available.' : '' }
    })
    if (!result || currentProject !== workspace.project()) return
    tickets.set(result.tickets); agents.set(result.agents); types.set((result.configuration?.types || []).map(normalizeType)); configurationError.set(result.configurationError)
    const fresh = tickets().find(item => String(item.id) === String(selected()?.id))
    if (fresh) { if (dirty()) selected.set(fresh); else apply(fresh); await loadRelations() }
    else if (selected()) { selected.set(null); values.set({}); dirty.set(false) }
  }
  async function boot() { await workspace.boot(); await load(); timer = setInterval(() => now.set(Date.now()), 1000) }
  async function select(ticket: Ticket) { if (dirty()) { workspace.error.set('Save or discard the current ticket changes before switching tickets.'); return }; apply(ticket); relatedId.set(''); workspace.notice.set(''); await loadRelations() }
  function discard() { const ticket = tickets().find(item => String(item.id) === String(selected()?.id)); if (ticket) apply(ticket); workspace.error.set('') }
  function markDirty() { dirty.set(true) }
  function fieldValue(key: string) { return values()[key] ?? '' }
  function createFieldValue(key: string) { return createValues()[key] ?? '' }
  function editField(key: string, event: Event, create = false) { const value = (event.target as HTMLInputElement).value; const target = create ? createValues : values; target.update(current => ({ ...current, [key]: value })); if (!create) dirty.set(true) }
  async function save() {
    const item = selected()
    if (!item || workspace.pending()) return
    let customFields: Record<string, unknown>
    try { customFields = typedFields(selectedFields(), values()) }
    catch (error) { workspace.error.set(error instanceof Error ? error.message : 'Check custom field values.'); return }
    const result = await workspace.run(() => workspace.request(workspace.projectPath(`/tickets/${encodeURIComponent(String(item.id))}`), { method: 'PATCH', body: JSON.stringify({ state: status(), priority: priority(), assigneeId: Number(assignee()), customFields }) }), workspace.pending)
    if (!result?.ticket) return
    tickets.update(items => items.map(row => String(row.id) === String(item.id) ? result.ticket : row)); apply(result.ticket); workspace.notice.set('Ticket updated. SLA state comes from the server.')
  }
  async function loadRelations() {
    const item = selected(), version = ++relationVersion
    relations.set([]); relationError.set('')
    if (!item) return
    try { const data = await workspace.request(workspace.projectPath(`/tickets/${encodeURIComponent(String(item.id))}/relations`)); if (!disposed && version === relationVersion) relations.set(data.relations || []) }
    catch (error) { if (!disposed && version === relationVersion) relationError.set(error instanceof Error ? error.message : 'Ticket relations could not be loaded.') }
  }
  async function addRelation() {
    if (!selected() || !relatedId() || workspace.pending()) return
    const result = await workspace.run(() => workspace.request(workspace.projectPath(`/tickets/${encodeURIComponent(String(selected()!.id))}/relations`), { method: 'POST', body: JSON.stringify({ relatedTicketId: relatedId(), kind: relationKind() }) }), workspace.pending)
    if (!result?.relation) return
    await loadRelations(); relatedId.set(''); workspace.notice.set('Ticket relation recorded.')
  }
  function relatedTitle(id: string | number) { return tickets().find(item => String(item.id) === String(id))?.title || `Ticket #${id}` }
  function stateLabel(ticket: Ticket) { return ticket.form?.states?.find(item => item.key === (ticket.state || ticket.status))?.label || ticket.state || ticket.status }
  async function startCreate() {
    if (dirty()) { workspace.error.set('Save or discard the current ticket changes first.'); return }
    creating.set(true); title.set(''); description.set(''); createTypeId.set(''); createValues.set({}); sourceId.set(''); createKey = ''; createFingerprint = ''
    const result = await workspace.run(() => workspace.request(workspace.projectPath('/inbox')))
    if (result && creating()) sources.set(result.conversations || [])
  }
  function changeCreateType() { createValues.set(fieldInputs(createFields())) }
  async function createTicket() {
    if (!creating() || workspace.pending()) return
    const source = sources().find(item => String(item.id) === sourceId())
    if (!source) { workspace.error.set('Choose an existing customer conversation.'); return }
    let customFields: Record<string, unknown>
    try { customFields = typedFields(createFields(), createValues()) }
    catch (error) { workspace.error.set(error instanceof Error ? error.message : 'Check custom fields.'); return }
    const payload = { contactId: source.customer_id, conversationId: source.id, typeId: createTypeId() || undefined, title: title(), description: description(), customFields }
    const fingerprint = JSON.stringify(payload)
    if (fingerprint !== createFingerprint) { createFingerprint = fingerprint; createKey = crypto.randomUUID() }
    const result = await workspace.run(() => workspace.request(workspace.projectPath('/tickets'), { method: 'POST', body: JSON.stringify({ ...payload, idempotencyKey: createKey }) }), workspace.pending)
    if (!result?.ticket) return
    tickets.set([result.ticket, ...tickets()]); creating.set(false); apply(result.ticket); await loadRelations(); workspace.notice.set('Ticket created with an immutable form snapshot.')
  }
  function date(value?: string | number) { if (!value) return 'Not recorded'; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? 'Unavailable' : parsed.toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC' }
  function countdown(deadline: number) {
    const seconds = Math.ceil((deadline - now()) / 1000)
    if (seconds <= 0) return 'Deadline passed; awaiting persisted status'
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor(seconds % 86400 / 3600)
    const minutes = Math.floor(seconds % 3600 / 60)
    const parts = []
    if (days) parts.push(`${days}d`)
    if (hours) parts.push(`${hours}h`)
    parts.push(`${minutes}m`, `${seconds % 60}s until deadline`)
    return parts.join(' ')
  }

  function destroy() { disposed = true; relationVersion++; clearInterval(timer); workspace.destroy() }
  return { workspace, agents, types, assignee, tickets, selected, query, filter, status, priority, filtered, selectedStates, selectedFields, fieldValue, createFieldValue, editField, inputType, dirty, markDirty, discard, configurationError, relations, relationError, relationKind, relatedId, targets, addRelation, relatedTitle, stateLabel, slaRows, creating, sources, sourceId, createTypeId, title, description, createFields, startCreate, changeCreateType, createTicket, boot, load, select, save, date, destroy }
}
