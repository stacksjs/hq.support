import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'KnowledgeChunk',
  table: 'support_knowledge_chunks',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  databaseExtensions: ['vector'],
  indexes: [
    { name: 'support_knowledge_chunk_position', columns: ['index_id', 'position'], unique: true },
    { name: 'support_knowledge_chunk_scope', columns: ['workspace_id', 'project_id', 'source_id', 'revision'] },
  ],
  attributes: {
    workspaceId: { required: true, validation: { rule: schema.number().integer() } },
    projectId: { required: true, validation: { rule: schema.number().integer() } },
    sourceId: { required: true, validation: { rule: schema.number().integer() }, foreignKey: { table: 'support_knowledge_sources', onDelete: 'cascade' } },
    indexId: { required: true, validation: { rule: schema.number().integer() }, foreignKey: { table: 'support_knowledge_indexes', onDelete: 'cascade' } },
    revision: { required: true, validation: { rule: schema.number().integer() } },
    position: { required: true, validation: { rule: schema.number().integer() } },
    content: { required: true, type: 'text', validation: { rule: schema.string() }, default: '' },
    embedding: { required: true, type: 'text', validation: { rule: schema.string() }, default: '' },
    contentHash: { required: true, validation: { rule: schema.string() }, default: '' },
  },
} as const)
