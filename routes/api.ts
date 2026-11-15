import { route } from '@stacksjs/router'
import { createCsrfCookie, csrfCookieToken, generateCsrfToken } from '@stacksjs/defaults/app/Middleware/Csrf.ts'
import { supportAction } from '../app/Actions/Support/SupportAction'
import { customerOrigin } from '../app/Support/customer-http'

// Keep the native auth actions reachable behind the application's /api proxy.
route.get('/csrf-token', (request) => {
  const token = csrfCookieToken(request as Request) || generateCsrfToken()
  return Response.json({ token }, { headers: { 'Cache-Control': 'no-store', 'Set-Cookie': createCsrfCookie(request as Request, token) } })
})
route.post('/login', 'Actions/Auth/LoginAction').rateLimit(5, 'minute')
route.post('/register', 'Actions/Auth/RegisterAction').rateLimit(3, 'minute')
route.post('/verify-two-factor-login', 'Actions/Auth/VerifyTwoFactorLoginAction').rateLimit(5, 'minute')
route.post('/logout', 'Actions/Auth/LogoutAction').middleware('auth')

route.get('/support/me', supportAction('me', 'GET')).middleware('auth')
route.post('/support/workspaces', supportAction('workspaces.create', 'POST')).middleware('auth').rateLimit(5, 'hour')
route.post('/support/workspaces/{workspace}/projects', supportAction('projects.create', 'POST')).middleware('auth')
route.post('/support/workspaces/{workspace}/invitations', supportAction('invitations.create', 'POST')).middleware('auth').rateLimit(20, 'hour')
route.post('/support/invitations/{id}/accept', supportAction('invitations.accept', 'POST')).middleware('auth')
route.get('/support/projects/{project}/inbox', supportAction('inbox', 'GET')).middleware('auth').rateLimit(120, 'minute')
route.get('/support/projects/{project}/conversations/{id}', supportAction('conversation.detail', 'GET')).middleware('auth')
route.patch('/support/projects/{project}/conversations/{id}', supportAction('conversation.update', 'PATCH')).middleware('auth')
route.post('/support/projects/{project}/conversations/{id}/messages', supportAction('agent.reply', 'POST')).middleware('auth')
route.patch('/support/projects/{project}', supportAction('projects.settings', 'PATCH')).middleware('auth')
route.post('/support/projects/{project}/keys', supportAction('keys.create', 'POST')).middleware('auth').rateLimit(10, 'hour')
route.get('/support/projects/{project}/tickets', supportAction('tickets.list', 'GET')).middleware('auth')
route.post('/support/projects/{project}/tickets', supportAction('tickets.create', 'POST')).middleware('auth')
route.patch('/support/projects/{project}/tickets/{id}', supportAction('tickets.update', 'PATCH')).middleware('auth')
route.get('/support/projects/{project}/articles', supportAction('articles.list', 'GET')).middleware('auth')
route.post('/support/projects/{project}/articles', supportAction('articles.create', 'POST')).middleware('auth')
route.patch('/support/projects/{project}/articles/{id}', supportAction('articles.update', 'PATCH')).middleware('auth')
route.get('/support/projects/{project}/reports', supportAction('reports', 'GET')).middleware('auth')
route.get('/support/projects/{project}/billing', supportAction('billing', 'GET')).middleware('auth')
route.get('/support/projects/{project}/workflows', supportAction('workflows.list', 'GET')).middleware('auth')
route.post('/support/projects/{project}/workflows', supportAction('workflows.create', 'POST')).middleware('auth')

// These APIs require their own project/customer bearer and never use cookies.
route.post('/v1/projects/{project}/sessions', supportAction('sessions', 'POST')).skipCsrf().rateLimit(120, 'minute')
route.post('/v1/projects/{project}/events', supportAction('events', 'POST')).skipCsrf().rateLimit(300, 'minute')
route.get('/v1/projects/{project}/conversations', supportAction('conversations.list', 'GET')).rateLimit(120, 'minute')
route.post('/v1/projects/{project}/conversations', supportAction('conversations.create', 'POST')).skipCsrf().rateLimit(120, 'minute')
route.post('/v1/projects/{project}/conversations/{id}/messages', supportAction('messages.create', 'POST')).skipCsrf().rateLimit(120, 'minute')
route.post('/widget/projects/{project}/session/revoke', supportAction('widget.session.revoke', 'POST')).skipCsrf().rateLimit(30, 'minute')
route.post('/widget/projects/{project}/session', supportAction('widget.session', 'POST')).skipCsrf().rateLimit(30, 'minute')
route.post('/widget/projects/{project}/events', supportAction('widget.events', 'POST')).skipCsrf().rateLimit(120, 'minute')
route.get('/widget/projects/{project}/conversations', supportAction('widget.conversations', 'GET')).rateLimit(120, 'minute')
route.post('/widget/projects/{project}/conversations', supportAction('widget.create', 'POST')).skipCsrf().rateLimit(30, 'minute')
route.get('/widget/projects/{project}/conversations/{id}', supportAction('widget.detail', 'GET')).rateLimit(120, 'minute')
route.post('/widget/projects/{project}/conversations/{id}/messages', supportAction('widget.reply', 'POST')).skipCsrf().rateLimit(60, 'minute')
route.get('/widget/projects/{project}/articles', supportAction('widget.articles', 'GET')).rateLimit(120, 'minute')
route.post('/widget/projects/{project}/tickets', supportAction('widget.tickets.create', 'POST')).skipCsrf().rateLimit(20, 'minute')
route.get('/widget/projects/{project}/tickets/{id}', supportAction('widget.tickets.detail', 'GET')).rateLimit(120, 'minute')
route.options('/widget/projects/{project}/*', async (request) => {
  const { project } = await import('../app/Support/service')
  let origin: string
  try { origin = customerOrigin(request, await project(request.getParam('project') || '')) }
  catch { return new Response(null, { status: 403, headers: { Vary: 'Origin' } }) }
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', 'Vary': 'Origin' } })
}).skipCsrf()

route.post('/cli/connect', supportAction('hq.start', 'POST')).skipCsrf().rateLimit(10, 'minute')
route.get('/cli/connect/{code}', supportAction('hq.poll', 'GET')).rateLimit(120, 'minute')
route.get('/support/connect/{code}', supportAction('hq.describe', 'GET')).middleware('auth')
route.post('/support/connect/{code}/approve', supportAction('hq.approve', 'POST')).middleware('auth').rateLimit(5, 'minute')
route.get('/v1/usage', supportAction('hq.usage', 'GET')).rateLimit(120, 'minute')
