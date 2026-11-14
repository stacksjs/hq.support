import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'SupportRoutingAgent',
  table: 'support_routing_agents',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_routing_agent_identity', columns: ['workspace_id', 'user_id'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    userId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    availability: { fillable: true, required: true, default: 'available', validation: { rule: schema.string() } },
    capacity: { type: 'bigint', fillable: true, required: true, default: 10, validation: { rule: schema.number().integer() } },
  },
} as const)
