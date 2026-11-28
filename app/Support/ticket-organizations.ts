import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, identifier, text } from './errors'

function scope(project: Row) {
  return [project.workspace_id, project.id]
}

export function verifiedTicketCustomer(customer: Row): boolean {
  return typeof customer.external_id === 'string' && !customer.external_id.startsWith('anonymous:')
}

export const sharedTicketAccess = `EXISTS (
  SELECT 1 FROM support_ticket_org_grants grant_row
  JOIN support_customer_org_members member ON member.organization_id = grant_row.organization_id
    AND member.workspace_id = grant_row.workspace_id AND member.project_id = grant_row.project_id
  WHERE grant_row.ticket_id = t.id AND grant_row.workspace_id = t.workspace_id
    AND grant_row.project_id = t.project_id AND member.contact_id = ?
)`

async function organization(project: Row, reference: unknown): Promise<Row> {
  const row = await one('SELECT id, name FROM support_customer_organizations WHERE workspace_id = ? AND project_id = ? AND id = ?', [...scope(project), identifier(reference)])
  if (!row) fail(404, 'not_found', 'Customer organization not found.')
  return row
}

export async function ticketOrganizations(project: Row) {
  return await query('SELECT id, name FROM support_customer_organizations WHERE workspace_id = ? AND project_id = ? ORDER BY name, id', scope(project))
}

export async function createTicketOrganization(project: Row, input: Row) {
  const name = text(input.name, 'name', 120)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const previous = await one('SELECT id, name FROM support_customer_organizations WHERE workspace_id = ? AND project_id = ? AND name = ?', [...scope(project), name])
    if (previous) return previous
    const row = await insert('support_customer_organizations', { workspace_id: project.workspace_id, project_id: project.id, name })
    return { id: row.id, name: row.name }
  })
}

export async function findOrganizationCustomers(project: Row, input: unknown) {
  const term = text(input, 'search', 120).toLowerCase()
  if (term.length < 2) fail(422, 'invalid_query', 'Enter at least two characters to find a customer.')
  const pattern = '%' + term.replace(/[!%_]/g, '!$&') + '%'
  return await query(`SELECT id, name, email FROM support_contacts
    WHERE workspace_id = ? AND project_id = ? AND external_id NOT LIKE 'anonymous:%'
      AND (LOWER(name) LIKE ? ESCAPE '!' OR LOWER(email) LIKE ? ESCAPE '!')
    ORDER BY name, id LIMIT 20`, [...scope(project), pattern, pattern])
}

export async function organizationCustomers(project: Row, reference: unknown) {
  const row = await organization(project, reference)
  return await query(`SELECT c.id, c.name, c.email FROM support_contacts c
    JOIN support_customer_org_members m ON m.contact_id = c.id AND m.workspace_id = c.workspace_id AND m.project_id = c.project_id
    WHERE m.workspace_id = ? AND m.project_id = ? AND m.organization_id = ? ORDER BY c.id`, [...scope(project), row.id])
}

export async function changeOrganizationCustomer(project: Row, reference: unknown, contactReference: unknown, active: boolean) {
  const contactId = identifier(contactReference)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const row = await organization(project, reference)
    const customer = await one('SELECT id, external_id FROM support_contacts WHERE workspace_id = ? AND project_id = ? AND id = ?', [...scope(project), contactId])
    if (!customer) fail(404, 'not_found', 'Customer contact not found.')
    const keys = [...scope(project), row.id, contactId]
    if (!active) {
      await query('DELETE FROM support_customer_org_members WHERE workspace_id = ? AND project_id = ? AND organization_id = ? AND contact_id = ?', keys)
      return
    }
    if (!verifiedTicketCustomer(customer)) fail(422, 'verified_customer_required', 'Use a server-issued customer identity for organization membership.')
    const now = new Date().toISOString()
    await query(`INSERT INTO support_customer_org_members (workspace_id, project_id, organization_id, contact_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, project_id, organization_id, contact_id) DO NOTHING`, [...keys, now, now])
  })
}

export async function organizationsForTicket(project: Row, ticketReference: unknown) {
  const ticketId = await grantableTicket(project, ticketReference)
  return await query(`SELECT o.id, o.name FROM support_customer_organizations o
    JOIN support_ticket_org_grants g ON g.organization_id = o.id AND g.workspace_id = o.workspace_id AND g.project_id = o.project_id
    WHERE g.workspace_id = ? AND g.project_id = ? AND g.ticket_id = ? ORDER BY o.name, o.id`, [...scope(project), ticketId])
}

async function grantableTicket(project: Row, ticketReference: unknown) {
  const ticketId = identifier(ticketReference)
  if (!await one("SELECT id FROM support_tickets WHERE workspace_id = ? AND project_id = ? AND id = ? AND kind = 'customer'", [...scope(project), ticketId]))
    fail(404, 'not_found', 'Customer ticket not found.')
  return ticketId
}

export async function changeTicketOrganization(project: Row, ticketReference: unknown, organizationReference: unknown, active: boolean) {
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const ticketId = await grantableTicket(project, ticketReference)
    const row = await organization(project, organizationReference)
    const keys = [...scope(project), ticketId, row.id]
    if (!active) {
      await query('DELETE FROM support_ticket_org_grants WHERE workspace_id = ? AND project_id = ? AND ticket_id = ? AND organization_id = ?', keys)
      return
    }
    const now = new Date().toISOString()
    await query(`INSERT INTO support_ticket_org_grants (workspace_id, project_id, ticket_id, organization_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, project_id, ticket_id, organization_id) DO NOTHING`, [...keys, now, now])
  })
}
