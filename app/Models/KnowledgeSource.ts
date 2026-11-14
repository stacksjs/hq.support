import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'KnowledgeSource',
  table: 'support_knowledge_sources',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_knowledge_article', columns: ['project_id', 'article_id'], unique: true },
    { name: 'support_knowledge_scope', columns: ['workspace_id', 'project_id', 'publication', 'audience', 'language'] },
  ],
  attributes: {
    workspaceId: { required: true, validation: { rule: schema.number().integer() } },
    projectId: { required: true, validation: { rule: schema.number().integer() } },
    articleId: { required: true, validation: { rule: schema.number().integer() }, foreignKey: { table: 'support_articles', onDelete: 'cascade' } },
    sourceKey: { required: true, validation: { rule: schema.string() }, default: '' },
    currentRevision: { required: true, validation: { rule: schema.number().integer() } },
    activeIndexId: { required: true, validation: { rule: schema.number().integer() }, default: 0, foreignKey: false },
    audience: { required: true, validation: { rule: schema.string() }, default: '' },
    language: { required: true, validation: { rule: schema.string() }, default: '' },
    publication: { required: true, validation: { rule: schema.string() }, default: '' },
    permissionGranted: { required: true, validation: { rule: schema.boolean() }, default: true },
    deletedAt: { required: true, type: 'bigint', validation: { rule: schema.number().integer() }, default: 0 },
    indexingLeaseUntil: { required: true, type: 'bigint', default: 0, validation: { rule: schema.number().integer() } },
    lastError: { required: true, type: 'text', default: '', validation: { rule: schema.string() } },
    requestedToken: { required: true, validation: { rule: schema.string() }, default: '' },
  },
} as const)
