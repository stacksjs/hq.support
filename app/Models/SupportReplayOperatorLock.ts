import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'SupportReplayOperatorLock', table: 'support_replay_operator_locks',
  traits: { useTimestamps: false }, dashboard: { access: false },
  attributes: {
    name: { required: true, unique: true, validation: { rule: schema.string().max(32) } },
  },
} as const)
