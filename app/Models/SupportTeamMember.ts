import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'SupportTeamMember',
  table: 'support_team_members',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_team_member_identity', columns: ['team_id', 'user_id'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    teamId: { foreignKey: { table: 'support_teams' }, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    userId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    active: { fillable: true, required: true, default: true, validation: { rule: schema.boolean() } },
  },
} as const)
