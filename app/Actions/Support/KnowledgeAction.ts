import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions/runtime'
import type { AnswerProvider } from '../../Support/ai'
import { answerQuestion } from '../../Support/ai'
import { SupportError, fail } from '../../Support/errors'
import { agentProject, customer, object, project as findProject } from '../../Support/service'
import { agentArticle, articleRevisions, createArticle, publishedArticle, searchArticles, updateArticle } from '../../Support/knowledge'

export type KnowledgeOperation = 'article' | 'search' | 'create' | 'update' | 'import' | 'revisions' | 'public.search' | 'public.article' | 'widget.search' | 'answer' | 'copilot'
async function handle(request: RequestInstance, operation: KnowledgeOperation, provider?: AnswerProvider) {
  let origin: string | null = null
  try {
    const widget = operation.startsWith('widget.') || operation === 'answer', publicRead = operation.startsWith('public.')
    const account = widget || publicRead ? undefined : await request.user()
    if (!widget && !publicRead && !account) fail(401, 'unauthorized', 'Sign in to continue.')
    const project = widget || publicRead ? await findProject(request.getParam('project')) : await agentProject(Number(account!.id), request.getParam('project'))
    if (widget) {
      const candidate = request.headers.get('origin'), allowed = JSON.parse(String(project.allowed_origins)) as string[]
      if (!candidate || !allowed.includes(candidate)) fail(403, 'origin_denied', 'Messenger origin is not allowed.')
      origin = candidate
    }
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')?.[1] ?? ''
    const person = widget ? await customer(project, bearer) : undefined
    const input = object(request.all())
    if (JSON.stringify(input).length > 150_000) fail(413, 'body_too_large', 'Request body is too large.')
    const params = new URL(request.url).searchParams
    let result: unknown, status = 200
    if (['search', 'public.search', 'widget.search'].includes(operation)) result = await searchArticles(project, params.get('q') ?? '', { internal: operation === 'search', ...(params.get('locale') ? { locale: params.get('locale')! } : {}), ...(params.get('collection') ? { collection: params.get('collection')! } : {}) })
    else if (operation === 'article') result = { article: await agentArticle(project, request.getParam('id')) }
    else if (operation === 'public.article') result = { article: await publishedArticle(project, request.getParam('slug'), params.get('locale') ?? 'en') }
    else if (operation === 'create' || operation === 'import') {
      if (operation === 'import' && !['html', 'markdown'].includes(String(input.format))) fail(422, 'invalid_input', 'Choose html or markdown for import.')
      result = { article: await createArticle(project, input, Number(account!.id)) }; status = 201
    }
    else if (operation === 'update') result = { article: await updateArticle(project, request.getParam('id'), input, Number(account!.id)) }
    else if (operation === 'revisions') result = { revisions: await articleRevisions(project, request.getParam('id')) }
    else result = await answerQuestion(project, request.getParam('id'), input, person ? { customer: person } : { userId: Number(account!.id) }, provider)
    return response(result, status, origin)
  }
  catch (error) {
    if (error instanceof SupportError) return response({ error: { code: error.code, message: error.message } }, error.status, origin)
    console.error('[support-knowledge]', error instanceof Error ? error.name : 'UnknownError')
    if (process.env.APP_ENV === 'test') console.error(error)
    return response({ error: { code: 'knowledge_unavailable', message: 'Knowledge is temporarily unavailable. Retry with the same idempotency key.' } }, 503, origin)
  }
}
function response(data: unknown, status: number, origin: string | null) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {}) } })
}
export function knowledgeAction(operation: KnowledgeOperation, provider?: AnswerProvider) {
  return new Action({ name: `Support knowledge ${operation}`, method: ['article', 'search', 'public.search', 'public.article', 'widget.search', 'revisions'].includes(operation) ? 'GET' : operation === 'update' ? 'PATCH' : 'POST', handle: request => handle(request, operation, provider) })
}
