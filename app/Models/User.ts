import { defineModel, selfOwnership } from '@stacksjs/orm'
import { makeHashSync } from '@stacksjs/security'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'User',
  table: 'users',
  ownership: selfOwnership(),
  dashboard: { access: false },
  traits: { useAuth: { usePasskey: true }, useUuid: true, useTimestamps: true },
  attributes: {
    supportFreeWorkspaceId: { type: 'bigint', foreignKey: false, guarded: true, hidden: true, required: true, default: 0, validation: { rule: schema.number().integer() } },

    avatar: { fillable: true, nullable: true, validation: { rule: schema.string() } },
    name: { fillable: true, required: true, validation: { rule: schema.string().min(2).max(100) } },
    email: { fillable: true, required: true, unique: true, validation: { rule: schema.string().email() } },
    password: { fillable: true, required: true, hidden: true, validation: { rule: schema.string().min(8).max(72) } },
  },
  set: { password: attributes => makeHashSync(String(attributes.password)) },
} as const)
