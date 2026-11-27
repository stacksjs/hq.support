import { resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import serverConfig from '../config/server'
const root = resolve(import.meta.dir, '..')

export async function createWidgetPreview(options: { port?: number, assetsDirectory?: string, native?: boolean, customerPort?: number } = {}) {
  const assets = options.assetsDirectory || resolve(root, 'public')
  let nativeApi: ((request: Request) => Promise<Response>) | undefined
  if (options.native ?? process.env.SUPPORT_NATIVE_UI === '1') {
    const { config, overridesReady } = await import('@stacksjs/config')
    const { migrateAuthTables, runDatabaseMigration } = await import('@stacksjs/database')
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')
    if (!String(process.env.DB_DATABASE_PATH).startsWith('/tmp/hq-support-ui-'))
      throw new Error('Live UI proof requires a disposable /tmp/hq-support-ui- database.')
    await overridesReady
    if (config.database.queryLogging) config.database.queryLogging.enabled = false
    config.email.default = 'capture'
    const initialAuth = await migrateAuthTables()
    const migrated = await runDatabaseMigration()
    // The generated User schema may be created after the first auth pass.
    const auth = await migrateAuthTables()
    if (!initialAuth.success || !migrated.isOk || !auth.success) throw new Error('Native test database migration failed.')
    await injectGlobalAutoImports()
    await route.importRoutes()
    nativeApi = request => route.handleRequest(request)
    if (process.env.SUPPORT_TEST_BILLING === '1') {
      const { configureBillingGateway } = await import('../app/Support/billing')
      const { stripe } = await import('@stacksjs/payments')
      configureBillingGateway({
        checkout: async input => ({ id: `local_test_${input.checkoutId}`, url: `https://checkout.stripe.com/test-local-${input.checkoutId}` }),
        event: async () => { throw new Error('Payment execution is not part of the local UI fixture.') },
      })
      stripe.checkout.sessions.create = (async (input, options) => {
        if (input?.mode !== 'subscription' || !options?.idempotencyKey?.startsWith('hq-support:subscription:')) throw new Error('Invalid subscription fixture request.')
        return { id: `cs_local_${input.metadata?.checkout_id}`, url: `https://checkout.stripe.com/test-local-${input.metadata?.checkout_id}` }
      }) as typeof stripe.checkout.sessions.create
    }
  }
  const messages: { id: string, conversation_id: string, author_type: string, body: string, delivery_status: string }[] = []
  const seen = new Map<string, object>()
  const manifest = await Bun.file(resolve(assets, 'widgets/manifest.json')).json()
  if (!Array.isArray(manifest.csp?.styleSrc) || !manifest.csp.styleSrc.every((value: unknown) => typeof value === 'string' && /^'sha256-[A-Za-z0-9+/]+=*'$/.test(value))) throw new Error('Native widget CSP hashes are required.')
  const originalHost = await Bun.file(resolve(root, 'tests/widget-host.html')).text()
  const inlineProof = /<script type="module">([\s\S]*?)<\/script>/.exec(originalHost)?.[1]
  if (!inlineProof) throw new Error('Native element proof script is missing.')
  const elementHost = originalHost.replace(/<script type="module">[\s\S]*?<\/script>/, '<script type="module" src="/element-proof.js"></script>')
  const hostCss = [...originalHost.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => `'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`)
  const policy = `default-src 'none'; script-src 'self'; style-src ${[...manifest.csp.styleSrc, ...hostCss].join(' ')}; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`
  const loader = await Bun.build({ entrypoints: [resolve(root, 'tests/widget-loader-proof.ts')], target: 'browser', format: 'esm' })
  if (!loader.success || !loader.outputs[0]) throw new Error('Hosted loader fixture did not compile.')
  const server = Bun.serve({
    hostname: '127.0.0.1', port: options.port ?? 4407,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/proof') return new Response(elementHost, { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': policy } })
      if (url.pathname === '/loader-proof') return new Response(Bun.file(resolve(root, 'tests/widget-loader-host.html')), { headers: { 'Content-Security-Policy': policy } })
      if (url.pathname === '/element-proof.js') return new Response(inlineProof, { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' } })
      if (url.pathname === '/loader-proof.js') return new Response(loader.outputs[0], { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' } })
      if (url.pathname === '/support.js') return new Response(Bun.file(resolve(assets, 'support.js')), { headers: { ...serverConfig.headers['/support.js'], 'Content-Type': 'text/javascript' } })
      if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 })
      if (url.pathname.startsWith('/api/widget/projects/proof/')) {
        const resource = url.pathname.slice('/api/widget/projects/proof'.length)
        if (resource === '/session') return Response.json({ token: 'fixture-session', contact: { id: 'fixture' } })
        if (request.headers.get('Authorization') !== 'Bearer fixture-session') return Response.json({ message: 'Forbidden' }, { status: 403 })
        if (resource === '/conversations' && request.method === 'GET') return Response.json({ conversations: messages.length ? [{ id: '1' }] : [] })
        if (resource === '/conversations/1/csat' && request.method === 'GET') return Response.json({ available: false, reason: 'disabled' })
        if (resource === '/ticket-types' && request.method === 'GET') return Response.json({ types: [{ id: '1', name: 'Compiler qualification', fields: [{ key: 'quantity', label: 'Quantity', type: 'number', visibility: 'customer' }, { key: 'reply_email', label: 'Reply email', type: 'email', visibility: 'customer' }, { key: 'incident_date', label: 'Incident date', type: 'date', visibility: 'customer' }] }] })
        if (resource === '/events') return Response.json({ accepted: true })
        if ((resource === '/conversations' || resource.endsWith('/messages')) && request.method === 'POST') {
          const body = await request.json()
          if (body.body === 'FAIL') return Response.json({ message: 'Fixture delivery error. Retry the message.' }, { status: 503 })
          if (!seen.has(body.idempotencyKey)) {
            const message = { id: String(messages.length + 1), conversation_id: '1', author_type: 'customer', body: body.body, delivery_status: 'stored' }
            messages.push(message)
            seen.set(body.idempotencyKey, resource === '/conversations' ? { conversation: { id: '1' } } : { message })
          }
          return Response.json(seen.get(body.idempotencyKey))
        }
        if (resource === '/conversations/1') return Response.json({ conversation: { id: '1' }, messages, attachments: [] })
        return Response.json({ message: 'Not available in the compiler fixture.' }, { status: 404 })
      }
      if (nativeApi && url.pathname.startsWith('/api/')) return nativeApi(request)
      const base = url.pathname.startsWith('/widgets/') ? assets : resolve(root, 'dist')
      let path = resolve(base, `.${decodeURIComponent(url.pathname)}`)
      if (path !== base && !path.startsWith(base + sep)) return new Response('Forbidden', { status: 403 })
      if (url.pathname.endsWith('/')) path = resolve(path, 'index.html')
      if (!(await Bun.file(path).exists()) && !url.pathname.includes('.')) path = path + '.html'
      const widgetHeaders = url.pathname.startsWith('/widgets/') ? {
        ...serverConfig.headers['/widgets/*'],
        ...Object.entries(serverConfig.headers).find(([entry]) => entry === url.pathname)?.[1],
      } : undefined
      return (await Bun.file(path).exists()) ? new Response(Bun.file(path), { headers: widgetHeaders }) : new Response('Not found', { status: 404 })
    },
  })
  let customer: ReturnType<typeof Bun.serve> | undefined
  try {
    if (nativeApi) {
      customer = Bun.serve({ hostname: '127.0.0.1', port: options.customerPort ?? 4409, fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/widgets/bundle.js') return new Response(Bun.file(resolve(root, 'public/widgets/bundle.js')))
        return new Response(Bun.file(resolve(root, 'tests/widget-customer.html')))
      } })
    }
  }
  catch (error) { server.stop(true); throw error }
  return { server, customer, close() { server.stop(true); customer?.stop(true) } }
}

if (import.meta.main) {
  const port = process.env.SUPPORT_WIDGET_PREVIEW_PORT === undefined ? 4407 : Number(process.env.SUPPORT_WIDGET_PREVIEW_PORT)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Widget preview port must be 0 through 65535.')
  const preview = await createWidgetPreview({ port })
  console.info(`HQ.support UI and compiler proof: ${preview.server.url}proof`)
  if (preview.customer) console.info(`Real customer widget proof: ${preview.customer.url}?project=YOUR_PUBLIC_PROJECT_ID`)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { preview.close(); process.exit(0) })
}
