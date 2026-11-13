import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Attachment',
  table: 'support_attachments',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    conversationId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    storageKey: { fillable: true, required: true, unique: true, validation: { rule: schema.string() } },
    fileName: { fillable: true, required: true, validation: { rule: schema.string() } },
    mimeType: { fillable: true, required: true, validation: { rule: schema.string() } },
    bytes: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    status: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'reserved' },
  },
} as const)
