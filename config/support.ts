import { env } from '@stacksjs/env'

export interface SupportConfig { deploymentMode: 'hosted' | 'selfhost' }

/** Operator-only deployment configuration. HTTP workspace input never selects this mode. */
export default {
  get deploymentMode() { return env.SUPPORT_DEPLOYMENT_MODE ?? 'hosted' },
} satisfies SupportConfig
