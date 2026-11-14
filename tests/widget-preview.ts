import { resolve, sep } from 'node:path'
import { config, overridesReady } from '@stacksjs/config'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'

const root = resolve(import.meta.dir, '..')
let nativeApi: ((request: Request) => Promise<Response>) | undefined
if (process.env.SUPPORT_NATIVE_UI === '1') {
  if (!String(process.env.DB_DATABASE_PATH).startsWith('/tmp/hq-support-ui-'))
    throw new Error('Live UI proof requires a disposable /tmp/hq-support-ui- database.')
  await overridesReady
  config.database.queryLogging.enabled = false
  config.email.default = 'capture'
  const auth = await migrateAuthTables()
  const migrated = await runDatabaseMigration()
  if (!auth.success || !migrated.isOk) throw new Error('Native test database migration failed.')
  await injectGlobalAutoImports()
  await route.importRoutes()
  nativeApi = request => route.handleRequest(request)
}
const messages: { id: number, author_type: string, body: string }[] = []
const seen = new Map<string, object>()
const server = Bun.serve({
  hostname: '127.0.0.1', port: 4407,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/proof') return new Response(Bun.file(resolve(root, 'tests/widget-host.html')))
    if (url.pathname.startsWith('/api/widget/projects/proof/')) {
      const resource = url.pathname.slice('/api/widget/projects/proof'.length)
      if (resource === '/session') return Response.json({ token: 'fixture-session', contact: { id: 'fixture' } })
      if (request.headers.get('Authorization') !== 'Bearer fixture-session') return Response.json({ message: 'Forbidden' }, { status: 403 })
      if (resource === '/conversations' && request.method === 'GET') return Response.json({ conversations: messages.length ? [{ id: 1 }] : [] })
      if (resource === '/events') return Response.json({ accepted: true })
      if ((resource === '/conversations' || resource.endsWith('/messages')) && request.method === 'POST') {
        const body = await request.json()
        if (body.body === 'FAIL') return Response.json({ message: 'Fixture delivery error. Retry the message.' }, { status: 503 })
        if (!seen.has(body.idempotencyKey)) {
          messages.push({ id: messages.length + 1, author_type: 'contact', body: body.body })
          seen.set(body.idempotencyKey, { conversation: { id: 1 } })
        }
        return Response.json(seen.get(body.idempotencyKey))
      }
      if (resource === '/conversations/1') return Response.json({ conversation: { id: 1 }, messages })
      return Response.json({ message: 'Not available in the compiler fixture.' }, { status: 404 })
    }
    if (nativeApi && url.pathname.startsWith('/api/')) return nativeApi(request)
    const base = url.pathname.startsWith('/widgets/') ? resolve(root, 'public') : resolve(root, 'dist')
    let path = resolve(base, `.${decodeURIComponent(url.pathname)}`)
    if (path !== base && !path.startsWith(base + sep)) return new Response('Forbidden', { status: 403 })
    if (url.pathname.endsWith('/')) path = resolve(path, 'index.html')
    if (!(await Bun.file(path).exists()) && !url.pathname.includes('.')) path = path + '.html'
    return (await Bun.file(path).exists()) ? new Response(Bun.file(path)) : new Response('Not found', { status: 404 })
  },
})
console.info(`HQ.support UI and compiler proof: ${server.url}proof`)

if (nativeApi) {
  const customer = Bun.serve({ hostname: '127.0.0.1', port: 4409, fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/widgets/bundle.js') return new Response(Bun.file(resolve(root, 'public/widgets/bundle.js')))
    return new Response(Bun.file(resolve(root, 'tests/widget-customer.html')))
  } })
  console.info(`Real customer widget proof: ${customer.url}?project=YOUR_PUBLIC_PROJECT_ID`)
}
