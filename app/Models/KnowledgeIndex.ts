import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'KnowledgeIndex',
  table: 'support_knowledge_indexes',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_knowledge_reservation_recovery', columns: ['workspace_id', 'reservation_state', 'lease_until'] },
    { name: 'support_knowledge_build', columns: ['source_id', 'owner_token'], unique: true },
  ],
  attributes: {
    workspaceId: { required: true, validation: { rule: schema.number().integer() } },
    projectId: { required: true, validation: { rule: schema.number().integer() } },
    sourceId: { required: true, validation: { rule: schema.number().integer() }, foreignKey: { table: 'support_knowledge_sources', onDelete: 'cascade' } },
    revision: { required: true, validation: { rule: schema.number().integer() } },
    status: { required: true, validation: { rule: schema.string() }, default: '' },
    embeddingModel: { required: true, validation: { rule: schema.string() }, default: '' },
    dimensions: { required: true, validation: { rule: schema.number().integer() } },
    chunkCount: { required: true, validation: { rule: schema.number().integer() } },
    contentHash: { required: true, validation: { rule: schema.string() }, default: '' },
    period: { required: true, default: '', validation: { rule: schema.string() } },
    reservedTokens: { required: true, default: 0, type: 'bigint', validation: { rule: schema.number().integer() } },
    actualTokens: { required: true, default: 0, type: 'bigint', validation: { rule: schema.number().integer() } },
    reservationState: { required: true, default: 'none', validation: { rule: schema.string() } },
    tokenAccounting: { required: true, default: '', validation: { rule: schema.string() } },
    leaseUntil: { required: true, default: 0, type: 'bigint', validation: { rule: schema.number().integer() } },
    ownerToken: { required: true, validation: { rule: schema.string() }, default: '' },
  },
} as const)
