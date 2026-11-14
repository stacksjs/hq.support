import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'CsatSetting', table: 'support_csat_settings', traits: { useTimestamps: true }, dashboard: { access: false },
  indexes: [{ name: 'support_csat_setting_project', columns: ['project_id'], unique: true }],
  attributes: {
    workspaceId: { type: 'bigint', required: true, fillable: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', required: true, fillable: true, foreignKey: { table: 'support_projects', onDelete: 'cascade' }, validation: { rule: schema.number().integer() } },
    enabled: { required: true, fillable: true, default: false, validation: { rule: schema.boolean() } },
    revision: { type: 'bigint', required: true, fillable: true, default: 1, validation: { rule: schema.number().integer() } },
    question: { required: true, fillable: true, default: 'How was your support experience?', validation: { rule: schema.string() } },
  },
} as const)
