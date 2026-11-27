import type { RequestInstance } from '@stacksjs/types'
import { readJsonBody, RequestBodyError } from '@stacksjs/router/body'
import type { Row } from './database'
import { one, query, workspaceTransaction } from './database'
import { SupportError, fail, identifier, text } from './errors'
import { billingPolicy, limitsFor, plans } from './limits'
import type { Plan } from './limits'
import * as support from './service'
import { approve, hq } from './hq'
import { createWorkflow, listWorkflows } from './workflows'
import { createArticle, searchArticles, updateArticle } from './knowledge'
import { confirmationCode } from '@stacksjs/hq/service'
import { requireWidgetOrigin } from './widget-origin'
import { projectReports } from './reports'

export type Operation = 'me' | 'workspaces.create' | 'projects.create' | 'projects.settings' | 'keys.create' | 'invitations.create' | 'invitations.accept' | 'inbox' | 'conversation.detail' | 'conversation.update' | 'agent.reply' | 'agent.presence' | 'sessions' | 'events' | 'conversations.create' | 'conversations.list' | 'messages.create' | 'widget.session' | 'widget.session.revoke' | 'widget.events' | 'widget.conversations' | 'widget.create' | 'widget.detail' | 'widget.typing' | 'widget.reply' | 'hq.start' | 'hq.poll' | 'hq.describe' | 'hq.approve' | 'hq.usage' | 'tickets.list' | 'tickets.create' | 'tickets.update' | 'widget.tickets.create' | 'widget.tickets.detail' | 'widget.ticket-types' | 'articles.list' | 'articles.create' | 'articles.update' | 'widget.articles' | 'reports' | 'billing' | 'workflows.list' | 'workflows.create'

const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
function bearer(request: RequestInstance): string { return /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')?.[1] ?? '' }
async function user(request: RequestInstance) {
  const row = await request.user()
  if (!row) fail(401, 'unauthorized', 'Sign in to continue.')
  return { id: Number(row.id), name: String(row.name), email: row.email, emailVerified: Boolean(row.email_verified_at) }
}
function input(request: RequestInstance): Row {
  const value = support.object(request.all())
  if (JSON.stringify(value).length > 100_000) fail(413, 'body_too_large', 'Request body is too large.')
  return value
}
function parameters(request: RequestInstance) {
  return { project: request.getParam('project'), id: request.getParam('id'), workspace: request.getParam('workspace'), code: request.getParam('code') }
}
async function handleCore(request: RequestInstance, operation: Operation): Promise<Response> {
  const acceptedAt = Date.now()
  try {
    const params = parameters(request)
    if (operation === 'agent.presence') {
      const account = await user(request)
      const project = await support.agentProject(account.id, params.project)
      if (new URL(request.url).search) fail(422, 'invalid_presence', 'Send presence only in the request body.')
      const body = support.object(await readJsonBody(request as unknown as Request, 1024, { rejectDuplicateKeys: true }))
      return response(await (await import('./inbox-presence')).updateInboxPresence(project, params.id, account.id, body))
    }
    const data = input(request)
    if (operation === 'hq.start') {
      const started = await (await hq()).startConnect({ url: request.url, headers: request.headers, json: async () => data })
      if (!started.ok) return started
      const body = await started.json() as { code: string, approveUrl: string }
      return response({ ...body, confirmCode: await confirmationCode(body.code) }, started.status)
    }
    if (operation === 'hq.poll') return await (await hq()).pollConnect({ url: request.url, headers: request.headers }, params.code)
    if (operation === 'hq.usage') return await (await hq()).usage({ url: request.url, headers: request.headers })
    if (operation === 'hq.describe') return response({ connection: await (await hq()).describeConnect(params.code) })
    if (operation === 'hq.approve') return response(await approve(params.code, text(data.confirmCode, 'confirmCode', 32), { ...await user(request), ...(data.workspaceId === undefined ? {} : { workspaceId: identifier(data.workspaceId) }) }))
    if (operation === 'me') {
      const account = await user(request)
      const workspaces = await query("SELECT w.id, w.public_id, w.name, w.plan, w.trial_ends_at, m.role FROM support_workspaces w JOIN support_memberships m ON m.workspace_id = w.id WHERE m.user_id = ? AND m.status = 'active' ORDER BY w.id", [account.id])
      const projects = await query("SELECT p.id, p.workspace_id, p.public_id, p.name, p.allowed_origins, p.anonymous_enabled, p.buddy_connected_at, p.verified_origin, p.deployment_verified_at, p.created_at, p.updated_at FROM support_projects p JOIN support_memberships m ON m.workspace_id = p.workspace_id WHERE m.user_id = ? AND m.status = 'active' ORDER BY p.id", [account.id])
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
      if (!account.emailVerified) fail(403, 'email_verification_required', 'Verify your email before accepting a workspace invitation.')
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
      cors = requireWidgetOrigin(request, project.allowed_origins)
      if (operation === 'widget.session') {
        if (data.token) {
          const contact = await support.customer(project, text(data.token, 'token', 256))
          const session = await one('SELECT expires_at FROM support_customer_sessions WHERE digest = ?', [support.digest(String(data.token))])
          return response({ token: data.token, expiresAt: Number(session?.expires_at), contact: { id: String(contact.id), externalId: String(contact.external_id), name: String(contact.name), email: String(contact.email) } })
        }
        if (!project.anonymous_enabled) fail(403, 'identity_required', 'This project requires a server-issued customer session.')
        return response(await support.createSession(project, { externalId: `anonymous:${crypto.randomUUID()}`, name: 'Visitor' }), 201)
      }
      if (operation === 'widget.session.revoke') return response(await (await import('./credentials')).revokeOwnCustomerSession(project, bearer(request)))
      person = await support.customer(project, bearer(request))
      if (operation === 'widget.typing') {
        if (new URL(request.url).search) fail(422, 'invalid_query', 'Typing status does not take query parameters.')
        return response(await (await import('./inbox-presence')).customerTyping(project, params.id, person))
      }
    }
    let body: unknown, status = 200
    if (operation === 'sessions') {
      const session = await support.createSession(project, data)
      body = { ...session, expiresAt: new Date(session.expiresAt).toISOString() }
    }
    else if (operation === 'events' || operation === 'widget.events') body = await support.track(project, { ...data, ...(person ? { externalId: person.external_id } : {}) })
    else if (operation === 'conversations.create' || operation === 'widget.create') { body = await support.createConversation(project, data, data, person); status = 201 }
    else if (operation === 'inbox' || operation === 'conversations.list' || operation === 'widget.conversations') {
      const search = new URL(request.url).searchParams
      for (const name of ['cursor', 'status', 'limit', 'inboxId', 'q']) if (search.getAll(name).length > 1) fail(422, 'duplicate_query', `Provide ${name} once.`)
      if (search.has('q') && operation !== 'inbox') fail(403, 'search_agent_required', 'Transcript search requires an authenticated agent.')
      body = await support.conversations(project, person, search.get('cursor'), operation === 'inbox' ? account?.id : undefined, { status: search.get('status') ?? undefined, limit: search.get('limit') ?? undefined, ...(operation === 'inbox' ? { inboxId: search.get('inboxId') ?? undefined, q: search.get('q') ?? undefined } : {}) })
    }
    else if (operation === 'conversation.detail' || operation === 'widget.detail') {
      const search = new URL(request.url).searchParams
      for (const name of search.keys()) if (!['beforeMessage', 'limit', 'beforeAttachment', 'attachmentLimit'].includes(name)) fail(422, 'invalid_query', 'Unsupported history query parameter.')
      for (const name of ['beforeMessage', 'limit', 'beforeAttachment', 'attachmentLimit']) if (search.getAll(name).length > 1) fail(422, 'duplicate_query', `Provide ${name} once.`)
      body = await support.detail(project, params.id, person, search.get('beforeMessage'), { limit: search.get('limit') ?? undefined, beforeAttachment: search.get('beforeAttachment'), attachmentLimit: search.get('attachmentLimit') ?? undefined })
    }
    else if (operation === 'messages.create' || operation === 'agent.reply' || operation === 'widget.reply') { body = operation === 'agent.reply' ? await (await import('./managed-channels')).createChannelReply(project, params.id, data, Number(account?.id)) : operation === 'widget.reply' ? await workspaceTransaction(Number(project.workspace_id), async () => await support.reply(project, params.id, data, { customer: await support.customer(project, bearer(request)), acceptedAt })) : await support.reply(project, params.id, data, { customer: person, userId: account?.id }); status = 201 }
    else if (operation === 'conversation.update') body = await support.updateConversation(project, params.id, data, account!.id)
    else if (operation === 'keys.create') { await support.member(account!.id, Number(project.workspace_id), ['owner', 'admin']); body = await (await import('./credentials')).createProjectKeys(project, account!.id, data.idempotencyKey); status = 201 }
    else if (operation === 'projects.settings') {
      await support.member(account!.id, Number(project.workspace_id), ['owner', 'admin'])
      if (!Array.isArray(data.allowedOrigins) || data.allowedOrigins.length > 20) fail(422, 'invalid_input', 'allowedOrigins must contain up to 20 explicit origins.')
      const origins = data.allowedOrigins.map(value => { const url = new URL(text(value, 'origin', 255)); if (url.origin !== value || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) fail(422, 'invalid_input', 'Use HTTPS origins, or localhost for development.'); return url.origin })
      await query('UPDATE support_projects SET allowed_origins = ?, anonymous_enabled = ?, updated_at = ? WHERE id = ?', [JSON.stringify(origins), data.anonymousEnabled === true, new Date().toISOString(), project.id])
      body = { project: await support.project(String(project.public_id)) }
    }
    else if (operation === 'widget.ticket-types') {
      const { publicForm, storedJson } = await import('./ticket-forms')
      body = { types: (await query("SELECT * FROM support_ticket_types WHERE project_id = ? AND kind = 'customer' ORDER BY id LIMIT 100", [project.id])).map(row => ({ id: String(row.id), name: row.name, ...publicForm({ fields: storedJson(row.fields, []), states: storedJson(row.states, []) }) })) }
    }
    else if (operation === 'tickets.list') {
      const { ticketView } = await import('./tickets')
      body = { tickets: await Promise.all((await query('SELECT * FROM support_tickets WHERE project_id = ? ORDER BY id DESC LIMIT 100', [project.id])).map(row => ticketView(row))) }
    }
    else if (operation === 'tickets.create' || operation === 'widget.tickets.create') {
      const { submitTicket } = await import('./tickets')
      body = await submitTicket(project, data, person ? { customer: person } : { userId: account!.id }); status = 201
    }
    else if (operation === 'widget.tickets.detail' || operation === 'tickets.update') {
      const { ticket, ticketView, updateTicket } = await import('./tickets')
      body = { ticket: operation === 'tickets.update' ? await updateTicket(project, params.id, data) : await ticketView(await ticket(project, params.id, person), true) }
    }
    else if (operation === 'articles.list' || operation === 'widget.articles') {
      const url = new URL(request.url)
      body = await searchArticles(project, url.searchParams.get('q') || '', { internal: !widget, locale: url.searchParams.get('locale') || undefined })
    }
    else if (operation === 'articles.create') { body = { article: await createArticle(project, data, account!.id) }; status = 201 }
    else if (operation === 'articles.update') body = { article: await updateArticle(project, params.id, data, account!.id) }
    else if (operation === 'billing') {
      const owner = await support.workspace(Number(project.workspace_id))
      body = { workspace: { id: owner.id, plan: owner.plan, trialEndsAt: Number(owner.trial_ends_at), overagesEnabled: Boolean(owner.overages_enabled), spendingCapCents: Number(owner.spending_cap_cents), walletCents: Number(owner.wallet_cents) }, limits: limitsFor(owner.plan as Plan), plans, policy: billingPolicy, checkoutAvailable: false, usage: { conversations: await support.usage(Number(owner.id), 'conversations'), ai: await support.usage(Number(owner.id), 'ai'), storageBytes: Number(owner.storage_bytes) } }
    }
    else if (operation === 'reports') body = await projectReports(project, acceptedAt)
    else if (operation === 'workflows.list') body = await listWorkflows(project)
    else if (operation === 'workflows.create') { body = { workflow: await createWorkflow(project, data, account!.id), executionAvailable: true, workerRequired: true }; status = 201 }
    else fail(404, 'not_found', 'Endpoint not found.')
    const result = response(body, status)
    if (cors) { result.headers.set('Access-Control-Allow-Origin', cors); result.headers.set('Vary', 'Origin') }
    return result
  }
  catch (error) {
    if (error instanceof SupportError) return response({ error: { code: error.code, message: error.message } }, error.status)
    if (error instanceof RequestBodyError) return response({ error: { code: 'invalid_presence', message: 'Send a bounded JSON presence update.' } }, error.status)
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
      const origin = requireWidgetOrigin(request, selected.allowed_origins)
      result.headers.set('Access-Control-Allow-Origin', origin)
      result.headers.set('Vary', 'Origin')
    }
    catch { /* A missing project never widens origin access. */ }
  }
  return result
}
