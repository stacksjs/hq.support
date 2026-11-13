import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Article',
  table: 'support_articles',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_article_slug', columns: ['project_id', 'locale', 'slug'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    slug: { fillable: true, required: true, validation: { rule: schema.string() } },
    title: { fillable: true, required: true, validation: { rule: schema.string() } },
    body: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() } },
    status: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'draft' },
    visibility: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'public' },
    locale: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'en' },
    collection: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'General' },
    revision: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 1 },
  },
} as const)
