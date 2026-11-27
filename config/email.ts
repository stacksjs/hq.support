import type { EmailConfig } from '@stacksjs/types'
import { env } from '@stacksjs/env'

const production = process.env.APP_ENV === 'production'
const domain = production ? 'hq.support' : env.MAIL_DOMAIN || env.APP_DOMAIN || 'example.com'
const teamMailboxes = ['chris', 'glenn', 'support', 'billing', 'privacy', 'security', 'abuse', 'postmaster']

export default {
  default: (env.MAIL_MAILER || 'log') as EmailConfig['default'],
  from: {
    name: env.MAIL_FROM_NAME || 'HQ Support',
    address: env.MAIL_FROM_ADDRESS || `hello@${domain}`,
  },

  domain,
  mailboxes: production ? [
    { email: 'hello', passwordPolicy: 'managed' },
    ...teamMailboxes.map(email => ({ email, passwordPolicy: 'initial-change' as const })),
  ] : [],
  forwards: {},
  url: env.APP_URL || 'hq.support.localhost',
  charset: 'UTF-8',

  server: {
    enabled: production,
    attachTo: 'stacks',
    exactMailboxes: true,
    dmarc: { policy: 'none', reportTo: 'postmaster@hq.support' },
    scan: true,
    subdomain: 'mail',
  },
} satisfies EmailConfig
