import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'TicketOrganizationGrant',
  table: 'support_ticket_org_grants',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_ticket_org_grant_access', columns: ['workspace_id', 'project_id', 'ticket_id', 'organization_id'], unique: true }],
  attributes: {
    workspaceId: { type: 'bigint', required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', required: true, foreignKey: { table: 'support_projects', onDelete: 'cascade' }, validation: { rule: schema.number().integer() } },
    ticketId: { type: 'bigint', required: true, foreignKey: { table: 'support_tickets', onDelete: 'cascade' }, validation: { rule: schema.number().integer() } },
    organizationId: { type: 'bigint', required: true, foreignKey: { table: 'support_customer_organizations', onDelete: 'cascade' }, validation: { rule: schema.number().integer() } },
  },
} as const)
