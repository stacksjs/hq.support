import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'ImportRecord',
  table: 'support_import_records',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_import_records_identity', columns: ['import_run_id', 'position'], unique: true }],
  attributes: {
    workspaceId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    importRunId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    position: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    entityType: { fillable: true, required: true, validation: { rule: schema.string() } },
    externalId: { fillable: true, required: true, validation: { rule: schema.string() } },
    status: { fillable: true, required: true, validation: { rule: schema.string() } },
    targetId: { fillable: true, required: true, type: 'bigint', foreignKey: false, default: 0, validation: { rule: schema.number().integer() } },
    errorCode: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    message: { fillable: true, required: true, type: 'text', default: '', validation: { rule: schema.string() } },
    sourcePayload: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() } },
  },
} as const)
