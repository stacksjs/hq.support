import { resolve } from 'node:path'
// Use the same path specifier as Buddy's loadTsCloudConfig, including its query.
const module = resolve(import.meta.dir, '../../config/cloud.ts') + '?env=' + process.env.SUPPORT_DEPLOYMENT_TEST
process.env.APP_ENV = process.env.SUPPORT_DEPLOYMENT_TEST
const { tsCloud: config } = await import(module)
const { default: email } = await import('../../config/email')
// Exclude credentials from the child process output.
console.info(JSON.stringify({
  project: config.project, stateDir: config.stateDir, cloud: config.cloud,
  main: config.sites.main, api: config.sites.api, www: config.sites.www,
  dns: config.infrastructure.dns,
  mail: { domain: email.domain, mailboxes: email.mailboxes.map(({ email, passwordPolicy }) => ({ email, passwordPolicy })), enabled: email.server.enabled, attachTo: email.server.attachTo, exactMailboxes: email.server.exactMailboxes },
  database: { name: config.infrastructure.appDatabase.name, username: config.infrastructure.appDatabase.username },
  sslDomains: config.infrastructure.ssl.domains,
}))
export {}
