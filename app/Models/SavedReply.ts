import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'SavedReply',
  table: 'support_saved_replies',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_saved_reply_project_page', columns: ['workspace_id', 'project_id', 'archived', 'id'] },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    name: { fillable: true, required: true, validation: { rule: schema.string().min(1).max(120) } },
    searchName: { type: 'text', fillable: true, required: true, validation: { rule: schema.string() } },
    body: { type: 'text', fillable: true, required: true, validation: { rule: schema.string().min(1).max(10000) } },
    revision: { type: 'bigint', fillable: true, required: true, default: 1, validation: { rule: schema.number().integer() } },
    archived: { fillable: true, required: true, default: false, validation: { rule: schema.boolean() } },
  },
} as const)
