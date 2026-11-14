import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions/runtime'
import { config, overridesReady } from '@stacksjs/config'
import { getAIProviderConfiguration } from '@stacksjs/ai/client'
import { agentProject, member, workspace, usage } from '../../Support/service'
import { SupportError, fail, identifier } from '../../Support/errors'
import { indexingBudgetView } from '../../Support/indexing-budget'
import { copilotBudgetView } from '../../Support/copilot-budget'
import { billingPolicy, limitsFor, periodOf } from '../../Support/limits'
import type { Plan } from '../../Support/limits'
import { indexArticle, knowledgeIndexCapabilities, removeKnowledgeSource } from '../../Support/knowledge-index'
import { removeArticle } from '../../Support/knowledge'
import { one, query, workspaceTransaction } from '../../Support/database'

async function handle(request: RequestInstance, operation: 'capabilities' | 'index' | 'status' | 'remove' | 'permissions') {
  try {
    const user = await request.user()
    if (!user) fail(401, 'unauthorized', 'Sign in to continue.')
    const project = await agentProject(Number(user.id), request.getParam('project'))
    let result: unknown
    if (operation === 'capabilities') {
      await overridesReady
      let provider: { configured: boolean, provider?: string }
      try { const selected = getAIProviderConfiguration(config.ai); provider = { configured: selected.configured, provider: selected.provider } }
      catch { provider = { configured: false } }
      const owner = await workspace(Number(project.workspace_id)), limits = limitsFor(owner.plan as Plan), used = await usage(Number(owner.id), 'ai')
      result = { provider, retrieval: await knowledgeIndexCapabilities(project), copilot: await copilotBudgetView(owner), indexing: await indexingBudgetView(owner), customerAi: { period: periodOf(), used, limit: limits.ai, remaining: limits.ai === null ? null : Math.max(0, limits.ai - used), maxTurns: billingPolicy.aiMaxTurns, maxTokens: billingPolicy.aiMaxTokens, copilotIncluded: false } }
    }
    else {
      const articleId = identifier(request.getParam('id'))
      if (!await one('SELECT id FROM support_articles WHERE id = ? AND project_id = ? AND workspace_id = ?', [articleId, project.id, project.workspace_id])) fail(404, 'not_found', 'Article not found.')
      if (operation === 'status') {
        const source = await one('SELECT * FROM support_knowledge_sources WHERE article_id = ? AND project_id = ? AND workspace_id = ?', [articleId, project.id, project.workspace_id])
        const index = source ? await one('SELECT status, revision, embedding_model, dimensions, chunk_count, reserved_tokens, actual_tokens, token_accounting FROM support_knowledge_indexes WHERE id = ? AND source_id = ?', [source.active_index_id, source.id]) : undefined
        result = { source: source ? { id: String(source.id), revision: Number(source.current_revision), audience: String(source.audience), language: String(source.language), permissionGranted: Boolean(source.permission_granted), deleted: Number(source.deleted_at) > 0, indexing: Boolean(source.requested_token) && Number(source.indexing_lease_until) > Date.now(), retryAt: Number(source.indexing_lease_until), lastError: String(source.last_error) } : null, index: index ? { ...index, revision: Number(index.revision), dimensions: Number(index.dimensions), chunk_count: Number(index.chunk_count) } : null }
      }
      else {
        await member(Number(user.id), Number(project.workspace_id), ['owner', 'admin'])
        if (operation === 'index') result = await indexArticle(project, articleId)
        else if (operation === 'remove') result = await removeArticle(project, articleId, request.get('revision'), Number(user.id))
        else {
          const granted = request.get('permissionGranted')
          if (typeof granted !== 'boolean') fail(422, 'invalid_input', 'permissionGranted must be a boolean.')
          result = await workspaceTransaction(Number(project.workspace_id), async () => {
            const source = await one('SELECT id FROM support_knowledge_sources WHERE article_id = ? AND project_id = ? AND workspace_id = ?', [articleId, project.id, project.workspace_id])
            if (!source) fail(404, 'not_found', 'Knowledge source has not been indexed.')
            if (!granted) await removeKnowledgeSource(project, articleId)
            await query('UPDATE support_knowledge_sources SET permission_granted = ?, deleted_at = 0, updated_at = ? WHERE id = ?', [granted, new Date().toISOString(), source.id])
            return { permissionGranted: granted, indexingRequired: granted }
          })
        }
      }
    }
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
  }
  catch (error) {
    return Response.json({ error: { code: error instanceof SupportError ? error.code : 'index_unavailable', message: error instanceof SupportError ? error.message : 'Knowledge indexing is unavailable. Retry after configuring the provider.' } }, { status: error instanceof SupportError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
export function knowledgeIndexAction(operation: 'capabilities' | 'index' | 'status' | 'remove' | 'permissions') {
  return new Action({ name: `Knowledge index ${operation}`, method: ['capabilities', 'status'].includes(operation) ? 'GET' : operation === 'remove' ? 'DELETE' : operation === 'permissions' ? 'PATCH' : 'POST', handle: request => handle(request, operation) })
}
