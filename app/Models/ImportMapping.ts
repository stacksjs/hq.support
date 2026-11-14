import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'ImportMapping',
  table: 'support_import_mappings',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_import_mappings_identity', columns: ['project_id', 'provider', 'entity_type', 'external_id'], unique: true }],
  attributes: {
    workspaceId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    provider: { fillable: true, required: true, validation: { rule: schema.string() } },
    entityType: { fillable: true, required: true, validation: { rule: schema.string() } },
    externalId: { fillable: true, required: true, validation: { rule: schema.string() } },
    targetId: { fillable: true, required: true, type: 'bigint', foreignKey: false, validation: { rule: schema.number().integer() } },
    sourceHash: { fillable: true, required: true, validation: { rule: schema.string() } },
    sourcePayload: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() } },
  },
} as const)
