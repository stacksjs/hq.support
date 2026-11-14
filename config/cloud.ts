import type { CloudConfig } from '@stacksjs/types'
import type { CloudConfig as TsCloudConfig } from '@stacksjs/ts-cloud'
import { env } from '@stacksjs/env'

// Buddy cache-busts this module with the explicitly selected deployment target.
// A plain application import keeps the production blueprint; a target never
// inherits another environment's domains, ports, database or release directory.
const selected = new URL(import.meta.url).searchParams.get('env') || 'production'
if (!['production', 'staging', 'development'].includes(selected)) throw new Error('Configure a supported HQ.support deployment environment.')
const target = selected === 'staging' ? 'staging' : selected === 'development' ? 'development' : 'production'
const suffix = target === 'production' ? '' : `-${target}`
const zone = env.APP_DOMAIN || 'hq.support'
const domain = `${target === 'production' ? '' : target === 'staging' ? 'staging.' : 'dev.'}${zone}`
const database = `hq_support${target === 'production' ? '' : `_${target}`}`
const webPort = target === 'production' ? 3340 : target === 'staging' ? 3350 : 3360
const apiPort = webPort + 8
const namespace = `hq-support${suffix}`
function variablesFor(environment: 'production' | 'staging' | 'development') {
  const databaseName = `hq_support${environment === 'production' ? '' : `_${environment}`}`
  const prefix = `hq-support${environment === 'production' ? '' : `-${environment}`}`
  return {
    APP_ENV: environment, NODE_ENV: 'production', LOG_LEVEL: 'info',
    DB_CONNECTION: 'postgres', DB_DATABASE: databaseName, DB_USERNAME: databaseName,
    QUEUE_DRIVER: 'database', CACHE_DRIVER: 'redis',
    QUEUE_PREFIX: `${prefix}:queue`, CACHE_PREFIX: `${prefix}:cache`,
  }
}
const variables = variablesFor(target)

/** Shared HQ host, isolated database, Redis namespaces and loopback processes. */
export const tsCloud: TsCloudConfig = {
  project: { name: namespace, slug: namespace, region: 'us-east-1' },
  stateDir: target === 'production' ? 'storage/cloud' : `storage/cloud/${target}`,
  cloud: { provider: 'hetzner', attachTo: 'stacks' },
  mode: 'server',
  environments: {
    production: {
      type: 'production', deployBranch: 'main', region: 'us-east-1',
      variables: variablesFor('production'),
    },
    staging: { type: 'staging', deployBranch: 'main', region: 'us-east-1', variables: variablesFor('staging') },
    development: { type: 'development', region: 'us-east-1', variables: variablesFor('development') },
  },
  infrastructure: {
    compute: {
      instances: 1, size: 'small', disk: { size: 20, type: 'ssd', encrypted: true },
      webServer: 'rpx',
      proxy: { engine: 'rpx', onDemandTls: true, onDemandTlsEmail: 'hello@hq.support' },
      managedServices: { postgres: true, redis: true },
    },
    appDatabase: { engine: 'postgres', name: database, username: database, password: env.DB_PASSWORD, port: 5432 },
    dns: { provider: 'porkbun', domain: zone },
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
      root: '.', path: '/', domain, framework: 'stacks', port: webPort,
      start: 'bun node_modules/@stacksjs/buddy/dist/serve-entry.js',
      preStart: ['bun install --frozen-lockfile', 'bun node_modules/@stacksjs/buddy/dist/cli.js migrate', 'bun node_modules/@stacksjs/buddy/dist/cli.js queue:table'],
      queues: [{ connection: 'database', queue: 'support-workflows,support-retention,support-imports,support-delivery,support-channels,support-sla,support-email,support-knowledge,default', processes: 2, timeout: 120, tries: 5, memory: 384, stopWaitSecs: 120 }],
      scheduler: true,
      memoryHigh: '768M', memoryMax: '1536M',
      env: { ...variables, HOST: '127.0.0.1', PORT: String(webPort), PORT_API: String(apiPort), API_URL: `http://127.0.0.1:${apiPort}` },
    },
    api: {
      root: '.', domain: `api.${domain}`, port: apiPort,
      start: 'bun node_modules/@stacksjs/actions/dist/serve/api.js',
      memoryHigh: '768M', memoryMax: '1536M',
      env: { ...variables, HOST: '127.0.0.1', PORT_API: String(apiPort) },
    },
    www: { domain: `www.${domain}`, redirect: `https://${domain}` },
  },
}

export default {} satisfies CloudConfig
