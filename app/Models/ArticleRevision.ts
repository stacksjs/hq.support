import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'ArticleRevision',
  table: 'support_article_revisions',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_article_revision', columns: ['article_id', 'revision'], unique: true }],
  attributes: {
    workspaceId: { required: true, validation: { rule: schema.number().integer() } },
    projectId: { required: true, validation: { rule: schema.number().integer() } },
    articleId: { required: true, validation: { rule: schema.number().integer() } },
    revision: { required: true, validation: { rule: schema.number().integer() } },
    authorId: { required: true, validation: { rule: schema.number().integer() } },
    snapshot: { required: true, type: 'text', validation: { rule: schema.string() } },
  },
} as const)
