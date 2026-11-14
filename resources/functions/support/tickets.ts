import { derived, state } from '@stacksjs/stx'
import { createSupportConsole } from './console'

interface Ticket { id: string | number, title: string, description: string, status: string, priority: string, assignee_id?: number, contact_id: number, conversation_id?: number, created_at: string, updated_at: string }
export function createTickets() {
  const workspace = createSupportConsole()
  const tickets = state<Ticket[]>([])
  const agents = state<{ id: string, name: string, role: string }[]>([])
  const assignee = state('')
  const selected = state<Ticket | null>(null)
  const query = state('')
  const filter = state('all')
  const status = state('open')
  const priority = state('normal')
  const filtered = derived(() => tickets().filter(item => (filter() === 'all' || item.status === filter()) && item.title.toLowerCase().includes(query().toLowerCase())))
  async function load() {
    selected.set(null)
    if (!workspace.project()) return
    const selectedProject = workspace.project()
    const result = await workspace.run(async () => {
      const data = await workspace.request(workspace.projectPath('/tickets'))
      let roster = { agents: [] }
      try { roster = await workspace.request(workspace.projectPath('/agents')) }
      catch { /* Tickets remain usable if the roster cannot be loaded. */ }
      return { tickets: data.tickets || [], agents: roster.agents || [] }
    })
    if (!result || selectedProject !== workspace.project()) return
    tickets.set(result.tickets)
    agents.set(result.agents)
  }
  async function boot() { await workspace.boot(); await load() }
  function select(ticket: Ticket) { selected.set(ticket); status.set(ticket.status); priority.set(ticket.priority); assignee.set(ticket.assignee_id ? String(ticket.assignee_id) : ''); workspace.notice.set('') }
  async function save() {
    const item = selected()
    if (!item || workspace.pending()) return
    const result = await workspace.run(() => workspace.request(workspace.projectPath(`/tickets/${encodeURIComponent(String(item.id))}`), { method: 'PATCH', body: JSON.stringify({ status: status(), priority: priority(), assigneeId: Number(assignee()) }) }), workspace.pending)
    if (!result?.ticket) return
    tickets.update(items => items.map(row => String(row.id) === String(item.id) ? result.ticket : row))
    select(result.ticket)
    workspace.notice.set('Ticket updated.')
  }
  function date(value?: string) { if (!value) return 'Unavailable'; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? 'Unavailable' : parsed.toLocaleString() }
  return { workspace, agents, assignee, tickets, selected, query, filter, status, priority, filtered, boot, load, select, save, date }
}
