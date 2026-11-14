import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'SupportTeam',
  table: 'support_teams',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_team_workspace', columns: ['workspace_id'] },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    name: { fillable: true, required: true, validation: { rule: schema.string() } },
    active: { fillable: true, required: true, default: true, validation: { rule: schema.boolean() } },
  },
} as const)
