import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Contact',
  table: 'support_contacts',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_contact_external', columns: ['project_id', 'external_id'], unique: true },
  ],
  attributes: {
    workspaceId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    externalId: { fillable: true, required: true, validation: { rule: schema.string() } },
    name: { fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
    email: { fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
    company: { fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
    attributes: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() }, default: '{}' },
  },
} as const)
