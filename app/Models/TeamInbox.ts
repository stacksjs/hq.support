import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'TeamInbox',
  table: 'support_team_inboxes',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_team_inbox_project', columns: ['project_id'] },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    teamId: { foreignKey: { table: 'support_teams' }, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    name: { fillable: true, required: true, validation: { rule: schema.string() } },
    active: { fillable: true, required: true, default: true, validation: { rule: schema.boolean() } },
    isDefault: { fillable: true, required: true, default: false, validation: { rule: schema.boolean() } },
    assignmentMode: { fillable: true, required: true, default: 'round_robin', validation: { rule: schema.string() } },
    lastMemberId: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
  },
} as const)
