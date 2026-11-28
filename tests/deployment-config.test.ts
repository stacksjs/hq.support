import { expect, test } from 'bun:test'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing'
import { supportRealtimeRedisUrl } from '../app/Support/realtime-config'

interface DeploymentProjection {
  project: { slug: string }, stateDir: string, cloud: { provider: string, attachTo?: string },
  main: { domain: string, port: number, preStart: string[], sharedPaths: string[], env: Record<string, string> },
  api: { domain: string, port: number, preStart: string[], sharedPaths: string[], env: Record<string, string> },
  www: { redirect: string }, dns: { domain: string },
  mail: { domain: string, mailboxes: { email: string, passwordPolicy: string }[], enabled: boolean, attachTo: string, exactMailboxes: boolean },
  database: { name: string, username: string }, sslDomains: string[],
  gateway: {
    domains: string[],
    routes: { to: string, path?: string, from?: string, redirect?: { to: string, status?: number, preservePath?: boolean } }[],
  },
}

test('deployed realtime reuses managed Redis settings or a dedicated Redis URL', () => {
  expect(supportRealtimeRedisUrl({ CACHE_DRIVER: 'redis' })).toBeUndefined()
  expect(supportRealtimeRedisUrl({ SUPPORT_REALTIME_DRIVER: 'redis', REDIS_HOST: '127.0.0.1' })).toBe('redis://127.0.0.1:6379/0')
  const url = 'rediss://cache.example.test:6380/2'
  expect(supportRealtimeRedisUrl({ SUPPORT_REALTIME_DRIVER: 'redis', REDIS_URL: url })).toBe(url)
  expect(supportRealtimeRedisUrl({ SUPPORT_REALTIME_REDIS_URL: url, REDIS_URL: 'redis://other.example.test' })).toBe(url)
  const encoded = supportRealtimeRedisUrl({ SUPPORT_REALTIME_DRIVER: 'redis', REDIS_HOST: '::1', REDIS_PORT: '6381', REDIS_DB: '3', REDIS_USERNAME: 'worker user', REDIS_PASSWORD: 'p@ss%word' })
  expect(encoded).toBe('redis://worker%20user:p%40ss%25word@[::1]:6381/3')
})

test('deployment targets isolate domains, ports, database ownership and release state', async () => {
  const siteMessengerProject = '9cdd1242-1272-4878-9c49-024aae67d541'
  const configurations: DeploymentProjection[] = []
  for (const target of ['production', 'staging', 'development']) {
    // Each Buddy invocation selects one environment in a fresh process.
    const result = await runIsolated('tests/fixtures/deployment-config.ts', { inheritEnv: false, env: { SUPPORT_DEPLOYMENT_TEST: target, APP_DOMAIN: 'hq.support', SUPPORT_SITE_MESSENGER_PROJECT_ID: siteMessengerProject }, envFile: false, preload: [] })
    assertIsolatedOk(result)
    const config = JSON.parse(result.stdout.trim()) as DeploymentProjection
    configurations.push(config)
    const main = config.main, api = config.api
    expect(config.cloud.provider).toBe('hetzner')
    expect(config.cloud.attachTo).toBe(target === 'staging' ? undefined : 'stacks')
    expect(main.domain).toBe(target === 'production' ? config.dns.domain : `${target === 'staging' ? 'staging' : 'dev'}.${config.dns.domain}`)
    expect(api.domain).toBe(`api.${main.domain}`)
    expect(main.env.HOST).toBe('127.0.0.1')
    expect(api.env.HOST).toBe('127.0.0.1')
    expect(main.env.APP_ENV).toBe(target)
    expect(api.env.APP_ENV).toBe(target)
    expect(main.env.SUPPORT_REALTIME_DRIVER).toBe('redis')
    expect(api.env.SUPPORT_REALTIME_DRIVER).toBe('redis')
    expect(main.env.DB_DATABASE).toBe(config.database.name)
    expect(api.env.DB_USERNAME).toBe(config.database.username)
    expect(main.env.PORT_API).toBe(String(api.port))
    expect(main.env.API_URL).toBe(`http://127.0.0.1:${api.port}`)
    expect(main.preStart[0]).toBe('bun install --frozen-lockfile')
    expect(api.preStart).toEqual(['bun install --frozen-lockfile'])
    expect(main.sharedPaths).toContain('storage/app')
    expect(api.sharedPaths).toContain('storage/app')
    expect(main.env.SUPPORT_SITE_MESSENGER_PROJECT_ID).toBeUndefined()
    expect(api.env.SUPPORT_SITE_MESSENGER_PROJECT_ID).toBe(target === 'production' ? siteMessengerProject : undefined)
    expect(config.sslDomains).toContain(main.domain)
    expect(config.www.redirect).toBe(`https://${main.domain}`)
    const helpDomain = `help.${main.domain}`
    const assetDomain = `cdn.${main.domain}`
    expect(config.sslDomains).toEqual(expect.arrayContaining([helpDomain, assetDomain]))
    expect(config.gateway.domains).toEqual(expect.arrayContaining([helpDomain, assetDomain]))
    expect(config.gateway.routes.filter(route => route.to === helpDomain)).toEqual([
      { to: helpDomain, redirect: { to: `https://${main.domain}/help`, preservePath: true } },
    ])
    expect(config.gateway.routes.filter(route => route.to === assetDomain)).toEqual([
      { to: assetDomain, path: '/support.js', from: `127.0.0.1:${main.port}` },
      { to: assetDomain, path: '/widgets', from: `127.0.0.1:${main.port}` },
    ])
    expect(config.mail.enabled).toBe(target === 'production')
    expect(config.mail.attachTo).toBe('stacks')
    expect(config.mail.exactMailboxes).toBe(true)
    expect(config.mail.mailboxes.map(box => box.email)).toEqual(target === 'production' ? ['hello', 'chris', 'glenn', 'support', 'billing', 'privacy', 'security', 'abuse', 'postmaster'] : [])
    if (target === 'production') {
      expect(config.mail.domain).toBe('hq.support')
      expect(config.mail.mailboxes[0]?.passwordPolicy).toBe('managed')
      expect(config.mail.mailboxes.slice(1).every(box => box.passwordPolicy === 'initial-change')).toBe(true)
    }
  }
  for (const value of [
    (config: DeploymentProjection) => config.project.slug,
    (config: DeploymentProjection) => config.stateDir,
    (config: DeploymentProjection) => config.main.port,
    (config: DeploymentProjection) => config.api.port,
    (config: DeploymentProjection) => config.database.name,
    (config: DeploymentProjection) => config.database.username,
    (config: DeploymentProjection) => config.main.env.CACHE_PREFIX,
    (config: DeploymentProjection) => config.main.env.QUEUE_PREFIX,
  ]) expect(new Set(configurations.map(value)).size).toBe(3)
})
