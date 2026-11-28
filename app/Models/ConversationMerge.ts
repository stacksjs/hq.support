import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'ConversationMerge',
  table: 'support_conversation_merges',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_merge_secondary', columns: ['workspace_id', 'project_id', 'secondary_id', 'undone_at'] },
    { name: 'support_merge_primary', columns: ['workspace_id', 'project_id', 'primary_id', 'undone_at'] },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    secondaryId: { type: 'bigint', fillable: true, required: true, foreignKey: { table: 'support_conversations', onDelete: 'cascade' }, validation: { rule: schema.number().integer() } },
    primaryId: { type: 'bigint', fillable: true, required: true, foreignKey: { table: 'support_conversations', onDelete: 'cascade' }, validation: { rule: schema.number().integer() } },
    mergedBy: { type: 'bigint', fillable: true, required: true, foreignKey: false, validation: { rule: schema.number().integer() } },
    previousStatus: { fillable: true, required: true, validation: { rule: schema.enum(['open', 'closed', 'snoozed']) } },
    previousRoutingReason: { fillable: true, required: true, validation: { rule: schema.string() } },
    previousSnoozedUntil: { type: 'bigint', fillable: true, nullable: true, validation: { rule: schema.number().integer() } },
    undoneBy: { type: 'bigint', fillable: true, nullable: true, foreignKey: false, validation: { rule: schema.number().integer() } },
    undoneAt: { type: 'bigint', fillable: true, nullable: true, validation: { rule: schema.number().integer() } },
  },
} as const)
