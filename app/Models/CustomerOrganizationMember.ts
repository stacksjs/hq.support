import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'CustomerOrganizationMember',
  table: 'support_customer_org_members',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_customer_org_member_unique', columns: ['workspace_id', 'project_id', 'organization_id', 'contact_id'], unique: true },
    { name: 'support_customer_org_member_access', columns: ['workspace_id', 'project_id', 'contact_id', 'organization_id'] },
  ],
  attributes: {
    workspaceId: { type: 'bigint', required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', required: true, foreignKey: { table: 'support_projects', onDelete: 'cascade' }, validation: { rule: schema.number().integer() } },
    organizationId: { type: 'bigint', required: true, foreignKey: { table: 'support_customer_organizations', onDelete: 'cascade' }, validation: { rule: schema.number().integer() } },
    contactId: { type: 'bigint', required: true, foreignKey: { table: 'support_contacts', onDelete: 'cascade' }, validation: { rule: schema.number().integer() } },
  },
} as const)
