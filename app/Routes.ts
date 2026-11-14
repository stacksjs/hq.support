import type { RouteRegistry } from '@stacksjs/router'
import defaults from '@stacksjs/defaults/app/Routes.ts'

export default {
  ...defaults,
  supportAssets: { path: 'support-assets', prefix: '/api' },
  supportKnowledge: { path: 'support-knowledge', prefix: '/api' },
  supportBilling: { path: 'support-billing', prefix: '/api' },
  supportWorkflows: { path: 'support-workflows', prefix: '/api' },
  supportEnterprise: { path: 'support-enterprise', prefix: '/api' },
  supportVerification: { path: 'support-verification', prefix: '/api' },
  supportImports: { path: 'support-imports', prefix: '/api' },
  supportDocumentation: { path: 'support-documentation', prefix: '/api' },
  supportInstallation: { path: 'support-installation', prefix: '/api' },
  supportPhone: { path: 'support-phone', prefix: '/api' },
  supportChannels: { path: 'support-channels', prefix: '/api' },
  supportTickets: { path: 'support-tickets', prefix: '/api' },
  supportEmail: { path: 'support-email', prefix: '/api' },
} satisfies RouteRegistry
