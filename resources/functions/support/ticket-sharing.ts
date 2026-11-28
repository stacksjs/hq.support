import { state } from '@stacksjs/stx'
import type { createSupportConsole } from './console'

interface Organization { id: string | number, name: string }
interface Customer { id: string | number, name: string, email: string }

export function createTicketSharing(workspace: ReturnType<typeof createSupportConsole>) {
  const organizations = state<Organization[]>([])
  const members = state<Customer[]>([])
  const customers = state<Customer[]>([])
  const grants = state<Organization[]>([])
  const selected = state('')
  const name = state('')
  const search = state('')
  const customerId = state('')
  const ticketId = state('')
  const grantOrganization = state('')
  let project = ''
  let loadedTicket = ''

  async function load() {
    const current = workspace.project()
    if (project !== current) {
      project = current
      selected.set(''); name.set(''); search.set(''); customerId.set(''); ticketId.set(''); grantOrganization.set('')
      organizations.set([]); members.set([]); customers.set([]); grants.set([])
      loadedTicket = ''
    }
    if (!current || !workspace.canManage()) return
    const result = await workspace.run(() => workspace.request(workspace.projectPath('/ticket-organizations')), workspace.pending)
    if (result && workspace.project() === current) organizations.set(result.organizations || [])
  }

  async function loadMembers() {
    const current = workspace.project(), id = selected()
    members.set([])
    if (!current || !id) return
    const result = await workspace.run(() => workspace.request(workspace.projectPath(`/ticket-organizations/${id}/members`)), workspace.pending)
    if (result && workspace.project() === current && selected() === id) members.set(result.members || [])
  }

  async function createOrganization() {
    if (!workspace.canManage() || workspace.pending()) return
    const current = workspace.project()
    const result = await workspace.run(() => workspace.request(workspace.projectPath('/ticket-organizations'), { method: 'POST', body: JSON.stringify({ name: name() }) }), workspace.pending)
    if (!result || workspace.project() !== current) return
    selected.set(String(result.organization.id))
    name.set('')
    await load()
    await loadMembers()
  }

  async function findCustomers() {
    if (!workspace.canManage() || workspace.pending()) return
    const current = workspace.project(), term = search()
    customerId.set('')
    customers.set([])
    const result = await workspace.run(() => workspace.request(workspace.projectPath('/ticket-organizations/customers?q=' + encodeURIComponent(term))), workspace.pending)
    if (result && workspace.project() === current && search() === term) customers.set(result.customers || [])
  }

  async function changeCustomer(id: string, active: boolean) {
    if (!workspace.canManage() || workspace.pending() || !selected() || !id) return
    const current = workspace.project(), organization = selected()
    const path = `/ticket-organizations/${organization}/members/${id}`
    const result = await workspace.run(() => workspace.request(workspace.projectPath(path), { method: active ? 'PUT' : 'DELETE' }), workspace.pending)
    if (result && workspace.project() === current && selected() === organization) await loadMembers()
  }

  async function loadGrants() {
    if (!workspace.canManage() || workspace.pending() || !/^[1-9]\d*$/.test(ticketId())) return
    const current = workspace.project(), ticket = ticketId()
    loadedTicket = ''
    grants.set([])
    const result = await workspace.run(() => workspace.request(workspace.projectPath(`/tickets/${ticket}/organizations`)), workspace.pending)
    if (!result || workspace.project() !== current || ticketId() !== ticket) return
    loadedTicket = ticket
    grants.set(result.organizations || [])
  }

  function clearGrants() { grants.set([]); loadedTicket = '' }

  async function changeGrant(id: string, active: boolean) {
    const ticket = ticketId()
    if (!workspace.canManage() || workspace.pending() || !/^[1-9]\d*$/.test(ticket) || !id || (!active && loadedTicket !== ticket)) return
    const current = workspace.project()
    const result = await workspace.run(() => workspace.request(workspace.projectPath(`/tickets/${ticket}/organizations/${id}`), { method: active ? 'PUT' : 'DELETE' }), workspace.pending)
    if (result && workspace.project() === current && ticketId() === ticket) await loadGrants()
  }

  return { organizations, members, customers, grants, selected, name, search, customerId, ticketId, grantOrganization, load, loadMembers, createOrganization, findCustomers, changeCustomer, loadGrants, clearGrants, changeGrant }
}
