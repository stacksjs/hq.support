import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'ImportRun',
  table: 'support_import_runs',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_import_runs_identity', columns: ['project_id', 'provider', 'source_hash'], unique: true }],
  attributes: {
    workspaceId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    provider: { fillable: true, required: true, validation: { rule: schema.string() } },
    sourceHash: { fillable: true, required: true, validation: { rule: schema.string() } },
    sourceKey: { fillable: true, required: true, validation: { rule: schema.string() } },
    sourceDisk: { fillable: true, required: true, validation: { rule: schema.string() } },
    sourceName: { fillable: true, required: true, validation: { rule: schema.string() } },
    sourceBytes: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    totalRecords: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    cursor: { fillable: true, required: true, type: 'bigint', default: 0, validation: { rule: schema.number().integer() } },
    processed: { fillable: true, required: true, type: 'bigint', default: 0, validation: { rule: schema.number().integer() } },
    imported: { fillable: true, required: true, type: 'bigint', default: 0, validation: { rule: schema.number().integer() } },
    skipped: { fillable: true, required: true, type: 'bigint', default: 0, validation: { rule: schema.number().integer() } },
    failed: { fillable: true, required: true, type: 'bigint', default: 0, validation: { rule: schema.number().integer() } },
    status: { fillable: true, required: true, default: 'uploading', validation: { rule: schema.string() } },
    leaseToken: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    leaseUntil: { fillable: true, required: true, type: 'bigint', default: 0, validation: { rule: schema.number().integer() } },
    lastError: { fillable: true, required: true, type: 'text', default: '', validation: { rule: schema.string() } },
  },
} as const)
