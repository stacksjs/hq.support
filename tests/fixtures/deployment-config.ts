import { resolve } from 'node:path'
// Use the same path specifier as Buddy's loadTsCloudConfig, including its query.
const module = resolve(import.meta.dir, '../../config/cloud.ts') + '?env=' + process.env.SUPPORT_DEPLOYMENT_TEST
const { tsCloud: config } = await import(module)
// Exclude credentials from the child process output.
console.info(JSON.stringify({
  project: config.project, stateDir: config.stateDir,
  main: config.sites.main, api: config.sites.api, www: config.sites.www,
  dns: config.infrastructure.dns,
  database: { name: config.infrastructure.appDatabase.name, username: config.infrastructure.appDatabase.username },
  sslDomains: config.infrastructure.ssl.domains,
}))
export {}
