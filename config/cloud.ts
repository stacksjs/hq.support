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
const helpDomain = `help.${domain}`
const assetDomain = `cdn.${domain}`
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
    QUEUE_FAILED_PREFIX: `${prefix}:failed`, QUEUE_BATCH_PREFIX: `${prefix}:batches`,
    SUPPORT_REALTIME_DRIVER: 'redis', SUPPORT_REALTIME_NAMESPACE: `${prefix}:replay-v1`,
  }
}
const variables = variablesFor(target)
const installRuntimeDependencies = 'bun install --frozen-lockfile'
const siteMessengerProject = target === 'production' ? process.env.SUPPORT_SITE_MESSENGER_PROJECT_ID?.trim() : undefined
if (siteMessengerProject && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(siteMessengerProject))
  throw new Error('SUPPORT_SITE_MESSENGER_PROJECT_ID must be a public project UUID.')

/** The production tenant shares Stacks compute. Staging owns its rehearsal host. */
export const tsCloud: TsCloudConfig = {
  project: { name: namespace, slug: namespace, region: 'us-east-1' },
  stateDir: target === 'production' ? 'storage/cloud' : `storage/cloud/${target}`,
  cloud: { provider: 'hetzner', ...(target !== 'staging' ? { attachTo: 'stacks' } : {}) },
  ...(target === 'staging' ? { hetzner: { location: 'nbg1' } } : {}),
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
      domains: [domain, `www.${domain}`, `api.${domain}`, helpDomain, assetDomain],
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
      sharedPaths: ['storage/app'],
      preStart: [installRuntimeDependencies, 'bun node_modules/@stacksjs/buddy/dist/cli.js migrate', 'bun node_modules/@stacksjs/buddy/dist/cli.js queue:table'],
      queues: [{ connection: 'database', queue: 'support-workflows,support-retention,support-imports,support-delivery,support-channels,support-sla,support-email,support-knowledge,default', processes: 2, timeout: 120, tries: 5, memory: 384, stopWaitSecs: 120 }],
      scheduler: true,
      memoryHigh: '768M', memoryMax: '1536M',
      env: { ...variables, HOST: '127.0.0.1', PORT: String(webPort), PORT_API: String(apiPort), API_URL: `http://127.0.0.1:${apiPort}` },
    },
    api: {
      root: '.', domain: `api.${domain}`, port: apiPort,
      start: 'bun node_modules/@stacksjs/actions/dist/serve/api.js',
      sharedPaths: ['storage/app'],
      preStart: [installRuntimeDependencies],
      memoryHigh: '768M', memoryMax: '1536M',
      env: { ...variables, ...(siteMessengerProject ? { SUPPORT_SITE_MESSENGER_PROJECT_ID: siteMessengerProject } : {}), HOST: '127.0.0.1', PORT_API: String(apiPort) },
    },
    www: { domain: `www.${domain}`, redirect: `https://${domain}` },
    help: { domain: helpDomain, redirect: { to: `https://${domain}/help`, preservePath: true } },
    widgetLoader: { domain: assetDomain, path: '/support.js', proxyTo: `127.0.0.1:${webPort}` },
    widgetAssets: { domain: assetDomain, path: '/widgets', proxyTo: `127.0.0.1:${webPort}` },
  },
}

export default {} satisfies CloudConfig
