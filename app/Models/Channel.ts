import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Channel',
  table: 'support_channels',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    publicId: { fillable: true, required: true, unique: true, validation: { rule: schema.string() } },
    label: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    externalId: { foreignKey: false, fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    verifiedAt: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    lastError: { type: 'text', fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    provider: { fillable: true, required: true, validation: { rule: schema.string() } },
    status: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'unconfigured' },
    configuration: { encrypted: true, hidden: true, fillable: true, required: true, type: 'text', validation: { rule: schema.string() }, default: '{}' },
  },
} as const)
