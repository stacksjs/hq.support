import type { CloudConfig } from '@stacksjs/types'
import type { CloudConfig as TsCloudConfig } from '@stacksjs/ts-cloud'
import { env } from '@stacksjs/env'

const domain = env.APP_DOMAIN || 'hq.support'

/** Shared HQ host, isolated database, Redis namespaces and loopback processes. */
export const tsCloud: TsCloudConfig = {
  project: { name: 'hq-support', slug: 'hq-support', region: 'us-east-1' },
  stateDir: 'storage/cloud',
  cloud: { provider: 'hetzner', attachTo: 'stacks' },
  mode: 'server',
  environments: {
    production: {
      type: 'production', deployBranch: 'main', region: 'us-east-1',
      variables: {
        APP_ENV: 'production', NODE_ENV: 'production', LOG_LEVEL: 'info',
        DB_CONNECTION: 'postgres', QUEUE_DRIVER: 'database', CACHE_DRIVER: 'redis',
        QUEUE_PREFIX: 'hq-support:queue', CACHE_PREFIX: 'hq-support:cache',
      },
    },
  },
  infrastructure: {
    compute: {
      instances: 1, size: 'small', disk: { size: 20, type: 'ssd', encrypted: true },
      webServer: 'rpx',
      proxy: { engine: 'rpx', onDemandTls: true, onDemandTlsEmail: 'hello@hq.support' },
      managedServices: { postgres: true, redis: true },
    },
    appDatabase: { engine: 'postgres', name: 'hq_support', username: 'hq_support', password: env.DB_PASSWORD, port: 5432 },
    dns: { provider: 'porkbun', domain },
    ssl: {
      enabled: true, provider: 'letsencrypt', redirectHttp: true,
      domains: [domain, `www.${domain}`, `api.${domain}`],
      letsEncrypt: { email: 'hello@hq.support', staging: false, autoRenew: true },
    },
    storage: {
      uploads: { public: false, encryption: true, versioning: true },
      assets: { public: true, encryption: true, versioning: true },
    },
  },
  sites: {
    main: {
      root: '.', path: '/', domain, framework: 'stacks', port: 3340,
      start: 'bun node_modules/@stacksjs/buddy/dist/serve-entry.js',
      preStart: ['bun install --frozen-lockfile', 'bun node_modules/@stacksjs/buddy/dist/cli.js migrate', 'bun node_modules/@stacksjs/buddy/dist/cli.js queue:table'],
      queues: [{ connection: 'database', queue: 'support-workflows,support-retention,support-imports,support-delivery,support-channels,support-sla,support-email,support-knowledge,default', processes: 2, timeout: 120, tries: 5, memory: 384, stopWaitSecs: 120 }],
      scheduler: true,
      memoryHigh: '768M', memoryMax: '1536M',
      env: { APP_ENV: 'production', NODE_ENV: 'production', PORT: '3340', PORT_API: '3348', API_URL: 'http://127.0.0.1:3348' },
    },
    api: {
      root: '.', domain: `api.${domain}`, port: 3348,
      start: 'bun node_modules/@stacksjs/actions/dist/serve/api.js',
      memoryHigh: '768M', memoryMax: '1536M',
      env: { HOST: '127.0.0.1', APP_ENV: 'production', NODE_ENV: 'production', PORT_API: '3348' },
    },
    www: { domain: `www.${domain}`, redirect: `https://${domain}` },
  },
}

export default {} satisfies CloudConfig
