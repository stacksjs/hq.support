import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'CustomerOrganization',
  table: 'support_customer_organizations',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_customer_org_name', columns: ['workspace_id', 'project_id', 'name'], unique: true }],
  attributes: {
    workspaceId: { type: 'bigint', required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', required: true, foreignKey: { table: 'support_projects', onDelete: 'cascade' }, validation: { rule: schema.number().integer() } },
    name: { required: true, validation: { rule: schema.string().max(120) } },
  },
} as const)
