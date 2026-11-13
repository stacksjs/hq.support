import type { RequestInstance } from '@stacksjs/types'
import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { SupportError, fail, identifier, text } from './errors'
import { billingPolicy, limitsFor, plans } from './limits'
import type { Plan } from './limits'
import * as support from './service'
import { approve, hq } from './hq'
import { confirmationCode } from '@stacksjs/hq/service'

export type Operation = 'me' | 'workspaces.create' | 'projects.create' | 'projects.settings' | 'keys.create' | 'invitations.create' | 'invitations.accept' | 'inbox' | 'conversation.detail' | 'conversation.update' | 'agent.reply' | 'sessions' | 'events' | 'conversations.create' | 'conversations.list' | 'messages.create' | 'widget.session' | 'widget.events' | 'widget.conversations' | 'widget.create' | 'widget.detail' | 'widget.reply' | 'hq.start' | 'hq.poll' | 'hq.describe' | 'hq.approve' | 'hq.usage' | 'tickets.list' | 'tickets.create' | 'tickets.update' | 'widget.tickets.create' | 'widget.tickets.detail' | 'articles.list' | 'articles.create' | 'articles.update' | 'widget.articles' | 'reports' | 'billing' | 'workflows.list' | 'workflows.create'

const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
function bearer(request: RequestInstance): string { return /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')?.[1] ?? '' }
async function user(request: RequestInstance) {
  const row = await request.user()
  if (!row) fail(401, 'unauthorized', 'Sign in to continue.')
  return { id: Number(row.id), name: String(row.name), email: row.email }
}
function input(request: RequestInstance): Row {
  const value = support.object(request.all())
  if (JSON.stringify(value).length > 100_000) fail(413, 'body_too_large', 'Request body is too large.')
  return value
}
function parameters(request: RequestInstance) {
  return { project: request.getParam('project'), id: request.getParam('id'), workspace: request.getParam('workspace'), code: request.getParam('code') }
}
function originAllowed(request: RequestInstance, project: Row) {
  const origin = request.headers.get('origin')
  const permitted = JSON.parse(String(project.allowed_origins || '[]')) as string[]
  if (!origin || !permitted.includes(origin)) fail(403, 'origin_denied', 'Messenger origin is not allowed for this project.')
  return origin
}
async function handleCore(request: RequestInstance, operation: Operation): Promise<Response> {
  try {
    const params = parameters(request), data = input(request)
    if (operation === 'hq.start') {
      const started = await (await hq()).startConnect({ url: request.url, headers: request.headers, json: async () => data })
      if (!started.ok) return started
      const body = await started.json() as { code: string, approveUrl: string }
      return response({ ...body, confirmCode: await confirmationCode(body.code) }, started.status)
    }
    if (operation === 'hq.poll') return await (await hq()).pollConnect({ url: request.url, headers: request.headers }, params.code)
    if (operation === 'hq.usage') return await (await hq()).usage({ url: request.url, headers: request.headers })
    if (operation === 'hq.describe') return response({ connection: await (await hq()).describeConnect(params.code) })
    if (operation === 'hq.approve') return response(await approve(params.code, text(data.confirmCode, 'confirmCode', 32), await user(request)))
    if (operation === 'me') {
      const account = await user(request)
      const workspaces = await query("SELECT w.id, w.public_id, w.name, w.plan, w.trial_ends_at, m.role FROM support_workspaces w JOIN support_memberships m ON m.workspace_id = w.id WHERE m.user_id = ? AND m.status = 'active' ORDER BY w.id", [account.id])
      const projects = await query("SELECT p.* FROM support_projects p JOIN support_memberships m ON m.workspace_id = p.workspace_id WHERE m.user_id = ? AND m.status = 'active' ORDER BY p.id", [account.id])
      return response({ user: account, workspaces, projects })
    }
    if (operation === 'workspaces.create') return response({ workspace: await support.createWorkspace(await user(request), text(data.name, 'name')) }, 201)
    if (operation === 'projects.create' || operation === 'invitations.create') {
      const account = await user(request), workspaceId = identifier(params.workspace)
      await support.member(account.id, workspaceId, ['owner', 'admin'])
      return operation === 'projects.create'
        ? response({ project: await support.createProject(workspaceId, text(data.name, 'name')) }, 201)
        : response({ invitation: await support.invite(workspaceId, data.email, data.role) }, 201)
    }
    if (operation === 'invitations.accept') {
      const account = await user(request)
      const invitation = await one("SELECT * FROM support_memberships WHERE id = ? AND email = ? AND status = 'pending'", [identifier(params.id), account.email.toLowerCase()])
      if (!invitation) fail(404, 'not_found', 'Invitation not found for this account.')
      await workspaceTransaction(Number(invitation.workspace_id), async () => {
        await query("UPDATE support_memberships SET user_id = ?, status = 'active', updated_at = ? WHERE id = ? AND status = 'pending'", [account.id, new Date().toISOString(), invitation.id])
      })
      return response({ accepted: true })
    }
    const widget = operation.startsWith('widget.'), server = ['sessions', 'events', 'conversations.create', 'conversations.list', 'messages.create'].includes(operation)
    const account = widget || server ? undefined : await user(request)
    const project = widget ? await support.project(params.project) : server ? await support.keyProject(params.project, bearer(request), operation === 'conversations.list' ? 'read' : 'write') : await support.agentProject(account!.id, params.project)
    let person: Row | undefined
    let cors: string | undefined
    if (widget) {
      cors = originAllowed(request, project)
      if (operation === 'widget.session') {
        if (data.token) {
          const contact = await support.customer(project, text(data.token, 'token', 256))
          const session = await one('SELECT expires_at FROM support_customer_sessions WHERE digest = ?', [support.digest(String(data.token))])
          return response({ token: data.token, expiresAt: Number(session?.expires_at), contact: { id: String(contact.id), externalId: String(contact.external_id), name: String(contact.name), email: String(contact.email) } })
        }
        if (!project.anonymous_enabled) fail(403, 'identity_required', 'This project requires a server-issued customer session.')
        return response(await support.createSession(project, { externalId: `anonymous:${crypto.randomUUID()}`, name: 'Visitor' }), 201)
      }
      person = await support.customer(project, bearer(request))
    }
    let body: unknown, status = 200
    if (operation === 'sessions') body = await support.createSession(project, data)
    else if (operation === 'events' || operation === 'widget.events') body = await support.track(project, { ...data, ...(person ? { externalId: person.external_id } : {}) })
    else if (operation === 'conversations.create' || operation === 'widget.create') { body = await support.createConversation(project, data, data, person); status = 201 }
    else if (operation === 'inbox' || operation === 'conversations.list' || operation === 'widget.conversations') body = await support.conversations(project, person, new URL(request.url).searchParams.get('cursor'))
    else if (operation === 'conversation.detail' || operation === 'widget.detail') body = await support.detail(project, params.id, person)
    else if (operation === 'messages.create' || operation === 'agent.reply' || operation === 'widget.reply') { body = await support.reply(project, params.id, data, { customer: person, userId: account?.id }); status = 201 }
    else if (operation === 'conversation.update') body = await support.updateConversation(project, params.id, data)
    else if (operation === 'keys.create') { await support.member(account!.id, Number(project.workspace_id), ['owner', 'admin']); body = await support.issueKeys(project); status = 201 }
    else if (operation === 'projects.settings') {
      await support.member(account!.id, Number(project.workspace_id), ['owner', 'admin'])
      if (!Array.isArray(data.allowedOrigins) || data.allowedOrigins.length > 20) fail(422, 'invalid_input', 'allowedOrigins must contain up to 20 explicit origins.')
      const origins = data.allowedOrigins.map(value => { const url = new URL(text(value, 'origin', 255)); if (url.origin !== value || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) fail(422, 'invalid_input', 'Use HTTPS origins, or localhost for development.'); return url.origin })
      await query('UPDATE support_projects SET allowed_origins = ?, anonymous_enabled = ?, updated_at = ? WHERE id = ?', [JSON.stringify(origins), data.anonymousEnabled === true, new Date().toISOString(), project.id])
      body = { project: await support.project(String(project.public_id)) }
    }
    else if (operation === 'tickets.list') body = { tickets: await query('SELECT * FROM support_tickets WHERE project_id = ? ORDER BY id DESC LIMIT 100', [project.id]) }
    else if (operation === 'tickets.create' || operation === 'widget.tickets.create') {
      body = await support.idempotent(project, `ticket:${person?.id ?? account?.id}`, data.idempotencyKey, data, async () => {
        const contactId = person?.id ?? identifier(data.contactId)
        if (!await one('SELECT id FROM support_contacts WHERE id = ? AND project_id = ?', [contactId, project.id])) fail(404, 'not_found', 'Contact not found.')
        if (data.conversationId) { const row = await support.conversation(project, data.conversationId, person); if (row.contact_id !== contactId) fail(422, 'contact_mismatch', 'Ticket and conversation must belong to the same contact.') }
        const ticket = await insert('support_tickets', { workspace_id: project.workspace_id, project_id: project.id, contact_id: contactId, conversation_id: data.conversationId ? identifier(data.conversationId) : null, title: text(data.title, 'title', 200), description: typeof data.description === 'string' ? data.description.slice(0, 20000) : '' })
        await support.enqueue(project, 'ticket.created', { ticketId: ticket.id })
        return { ticket }
      }); status = 201
    }
    else if (operation === 'widget.tickets.detail' || operation === 'tickets.update') {
      const ticket = await one('SELECT * FROM support_tickets WHERE id = ? AND project_id = ?', [identifier(params.id), project.id])
      if (!ticket || (person && ticket.contact_id !== person.id)) fail(404, 'not_found', 'Ticket not found.')
      if (operation === 'tickets.update') {
        const status = data.status ?? ticket.status, priority = data.priority ?? ticket.priority
        if (!['open', 'pending', 'resolved'].includes(String(status)) || !['low', 'normal', 'high', 'urgent'].includes(String(priority))) fail(422, 'invalid_input', 'Unknown ticket status or priority.')
        const assignee = data.assigneeId === undefined ? ticket.assignee_id : Number(data.assigneeId)
        if (assignee) await support.member(Number(assignee), Number(project.workspace_id))
        await query('UPDATE support_tickets SET status = ?, priority = ?, assignee_id = ?, updated_at = ? WHERE id = ? AND project_id = ?', [status, priority, assignee, new Date().toISOString(), ticket.id, project.id])
      }
      body = { ticket: await one('SELECT * FROM support_tickets WHERE id = ? AND project_id = ?', [ticket.id, project.id]) }
    }
    else if (operation === 'articles.list' || operation === 'widget.articles') {
      const search = new URL(request.url).searchParams.get('q')?.slice(0, 200) || ''
      body = { articles: await query(`SELECT id, slug, title, body, locale, collection, revision, updated_at, status, visibility FROM support_articles WHERE project_id = ?${widget ? " AND status = 'published' AND visibility = 'public'" : ''} AND (LOWER(title) LIKE ? OR LOWER(body) LIKE ?) ORDER BY id DESC LIMIT 50`, [project.id, `%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`]) }
    }
    else if (operation === 'articles.create') {
      const article = await insert('support_articles', { workspace_id: project.workspace_id, project_id: project.id, slug: text(data.slug, 'slug', 200), title: text(data.title, 'title', 200), body: text(data.body, 'body', 100000), status: 'draft', visibility: data.visibility === 'internal' ? 'internal' : 'public', locale: data.locale || 'en', collection: data.collection || 'General' })
      body = { article }; status = 201
    }
    else if (operation === 'articles.update') {
      const article = await one('SELECT * FROM support_articles WHERE id = ? AND project_id = ?', [identifier(params.id), project.id])
      if (!article) fail(404, 'not_found', 'Article not found.')
      const state = data.status ?? article.status
      if (!['draft', 'published', 'archived'].includes(String(state))) fail(422, 'invalid_input', 'Unknown article status.')
      await query('UPDATE support_articles SET title = ?, body = ?, status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND project_id = ?', [data.title === undefined ? article.title : text(data.title, 'title'), data.body === undefined ? article.body : text(data.body, 'body', 100000), state, new Date().toISOString(), article.id, project.id])
      body = { article: await one('SELECT * FROM support_articles WHERE id = ? AND project_id = ?', [article.id, project.id]) }
    }
    else if (operation === 'billing') {
      const owner = await support.workspace(Number(project.workspace_id))
      body = { workspace: { id: owner.id, plan: owner.plan, trialEndsAt: owner.trial_ends_at, overagesEnabled: Boolean(owner.overages_enabled), spendingCapCents: Number(owner.spending_cap_cents), walletCents: Number(owner.wallet_cents) }, limits: limitsFor(owner.plan as Plan), plans, policy: billingPolicy, checkoutAvailable: false, usage: { conversations: await support.usage(Number(owner.id), 'conversations'), ai: await support.usage(Number(owner.id), 'ai'), storageBytes: Number(owner.storage_bytes) } }
    }
    else if (operation === 'reports') body = { conversations: await query('SELECT status, COUNT(*) AS total FROM support_conversations WHERE project_id = ? GROUP BY status', [project.id]), messages: await query('SELECT author_type, COUNT(*) AS total FROM support_messages WHERE project_id = ? GROUP BY author_type', [project.id]), tickets: await query('SELECT status, COUNT(*) AS total FROM support_tickets WHERE project_id = ? GROUP BY status', [project.id]) }
    else if (operation === 'workflows.list') body = { workflows: await query('SELECT * FROM support_workflows WHERE project_id = ? ORDER BY id DESC', [project.id]), executionAvailable: false }
    else if (operation === 'workflows.create') {
      await support.member(account!.id, Number(project.workspace_id), ['owner', 'admin'])
      body = { workflow: await insert('support_workflows', { workspace_id: project.workspace_id, project_id: project.id, name: text(data.name, 'name'), event: text(data.event, 'event'), enabled: false, definition: support.jsonText(data.definition) }), executionAvailable: false }; status = 201
    }
    else fail(404, 'not_found', 'Endpoint not found.')
    const result = response(body, status)
    if (cors) { result.headers.set('Access-Control-Allow-Origin', cors); result.headers.set('Vary', 'Origin') }
    return result
  }
  catch (error) {
    if (error instanceof SupportError) return response({ error: { code: error.code, message: error.message } }, error.status)
    if (error instanceof TypeError || error instanceof SyntaxError) return response({ error: { code: 'invalid_input', message: 'Request could not be parsed.' } }, 422)
    console.error('[support] request failed', error instanceof Error ? error.name : 'UnknownError')
    if (process.env.APP_ENV === 'test') console.error(error)
    return response({ error: { code: 'internal_error', message: 'Request failed. Please retry with the same idempotency key.' } }, 500)
  }
}

export async function handle(request: RequestInstance, operation: Operation): Promise<Response> {
  const result = await handleCore(request, operation)
  if (operation.startsWith('widget.')) {
    try {
      const selected = await support.project(request.getParam('project'))
      const origin = request.headers.get('origin')
      const allowed = JSON.parse(String(selected.allowed_origins)) as string[]
      if (origin && allowed.includes(origin)) {
        result.headers.set('Access-Control-Allow-Origin', origin)
        result.headers.set('Vary', 'Origin')
      }
    }
    catch { /* A missing project never widens origin access. */ }
  }
  return result
}
