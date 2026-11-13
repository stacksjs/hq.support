import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Attachment',
  table: 'support_attachments',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_attachment_idempotency', columns: ['project_id', 'idempotency_key'], unique: true }],
  attributes: {
    idempotencyKey: { fillable: true, required: true, validation: { rule: schema.string() } },
    sha256: { fillable: true, required: true, validation: { rule: schema.string() } },
    storageDisk: { fillable: true, required: true, default: 'local', validation: { rule: schema.string() } },
    leaseToken: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    leaseUntil: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    conversationId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    storageKey: { fillable: true, required: true, unique: true, validation: { rule: schema.string() } },
    fileName: { fillable: true, required: true, validation: { rule: schema.string() } },
    mimeType: { fillable: true, required: true, validation: { rule: schema.string() } },
    bytes: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    status: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'reserved' },
  },
} as const)
