import { Action } from '@stacksjs/actions/runtime'
import type { RequestInstance } from '@stacksjs/types'
import { agentProject, customer, project as findProject } from '../../Support/service'
import { SupportError, fail } from '../../Support/errors'
import { download, remove, upload } from '../../Support/attachments'

async function handle(request: RequestInstance, operation: 'upload' | 'download' | 'remove', widget: boolean) {
  let origin: string | null = null
  try {
    const reference = request.getParam('project')
    const project = widget ? await findProject(reference) : await agentProject(Number((await request.user())?.id), reference)
    if (widget) {
      origin = request.headers.get('origin')
      const allowed = JSON.parse(String(project.allowed_origins)) as string[]
      if (!origin || !allowed.includes(origin)) { origin = null; fail(403, 'origin_denied', 'Messenger origin is not allowed.') }
    }
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')?.[1] || ''
    const person = widget ? await customer(project, bearer) : undefined
    let result: Response
    if (operation === 'upload') {
      const candidate = request.files.file
      if (!(candidate instanceof File)) fail(422, 'invalid_file', 'Upload one file in the file field.')
      result = Response.json(await upload(project, request.getParam('id'), candidate, request.get('idempotencyKey'), person), { status: 201 })
    }
    else if (operation === 'download') result = await download(project, request.getParam('id'), person)
    else result = Response.json(await remove(project, request.getParam('id')))
    if (origin) { result.headers.set('Access-Control-Allow-Origin', origin); result.headers.set('Vary', 'Origin') }
    return result
  }
  catch (error) {
    const result = Response.json({ error: { code: error instanceof SupportError ? error.code : 'storage_unavailable', message: error instanceof SupportError ? error.message : 'Attachment storage is unavailable. Retry with the same idempotency key.' } }, { status: error instanceof SupportError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } })
    if (origin) { result.headers.set('Access-Control-Allow-Origin', origin); result.headers.set('Vary', 'Origin') }
    return result
  }
}
export function attachmentAction(operation: 'upload' | 'download' | 'remove', widget = false) {
  return new Action({ name: `Attachment ${operation}`, method: operation === 'upload' ? 'POST' : operation === 'download' ? 'GET' : 'DELETE', handle: request => handle(request, operation, widget) })
}
