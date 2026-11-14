import { defineModel } from '@stacksjs/orm'
import NativeEmailSuppression from '@stacksjs/defaults/app/Models/EmailSuppression.ts'

/** Keep the native suppression schema and GDPR retention; expose no unscoped CRUD routes. */
export default defineModel({
  ...NativeEmailSuppression,
  traits: { gdpr: NativeEmailSuppression.traits.gdpr, useTimestamps: true },
  dashboard: { access: false },
} as const)
