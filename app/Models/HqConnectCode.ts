import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'HqConnectCode',
  table: 'hq_connect_codes',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    codeHash: { fillable: true, required: true, unique: true, validation: { rule: schema.string() } },
    app: { fillable: true, required: true, validation: { rule: schema.string() } },
    status: { fillable: true, required: true, validation: { rule: schema.string() } },
    sealedGrant: { fillable: true, type: 'text', validation: { rule: schema.string() }, nullable: true },
    claim: { fillable: true, validation: { rule: schema.string() }, nullable: true },
    expiresAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
  },
} as const)
