import { Action } from '@stacksjs/actions/runtime'
import { agentProject, customer, object, project as findProject } from '../../Support/service'
import { configureCsat, csatReport, csatSettings, customerCsat, submitCsat } from '../../Support/csat'
import { fail, SupportError } from '../../Support/errors'
import { requireWidgetOrigin } from '../../Support/widget-origin'

export function csatAction(operation: 'settings' | 'configure' | 'report' | 'widget.read' | 'widget.submit') {
  return new Action({ name: `Support CSAT ${operation}`, apiResponse: false, method: operation === 'configure' ? 'PATCH' : operation === 'widget.submit' ? 'POST' : 'GET', async handle(request) {
    let origin: string | null = null
    const respond = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}) } })
    try {
      const widget = operation.startsWith('widget.'), user = widget ? undefined : await request.user()
      if (!widget && !user) fail(401, 'unauthorized', 'Sign in to continue.')
      const project = widget ? await findProject(request.getParam('project')) : await agentProject(Number(user!.id), request.getParam('project'))
      const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')?.[1] ?? ''
      if (widget) origin = requireWidgetOrigin(request, project.allowed_origins)
      const person = widget ? await customer(project, token) : undefined
      const input = { ...object(request.all()) }; delete input.project; delete input.id
      if (JSON.stringify(input).length > 10000) fail(413, 'csat_body_large', 'Survey input exceeds the request bound.')
      const parameters = new URL(request.url).searchParams
      if (parameters.getAll('period').length > 1) fail(422, 'duplicate_period', 'Supply period once.')
      const result = operation === 'settings' ? await csatSettings(project, Number(user!.id)) : operation === 'configure' ? await configureCsat(project, Number(user!.id), input) : operation === 'report' ? await csatReport(project, Number(user!.id), parameters.get('period') ?? undefined) : operation === 'widget.read' ? await customerCsat(project, request.getParam('id'), person!) : await submitCsat(project, request.getParam('id'), token, input)
      return respond(result, operation === 'widget.submit' ? 201 : 200)
    }
    catch (error) { return respond({ error: { code: error instanceof SupportError ? error.code : 'csat_unavailable', message: error instanceof SupportError ? error.message : 'Feedback is unavailable. Retry with the same operation key.' } }, error instanceof SupportError ? error.status : 503) }
  } })
}
