import { Action } from '@stacksjs/actions/runtime'
import { syncDocumentation } from '../../Support/documentation'
import { digest, keyProject } from '../../Support/service'
import { one } from '../../Support/database'
import { fail, SupportError } from '../../Support/errors'

export default new Action({
  name: 'Sync explicitly selected application documentation', method: 'POST', apiResponse: false,
  async handle(request) {
    try {
      const key = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')?.[1] || ''
      const project = await keyProject(request.getParam('project'), key, 'write')
      const credential = await one("SELECT id FROM support_api_keys WHERE project_id = ? AND digest = ? AND scope = 'write' AND revoked_at = 0", [project.id, digest(key)])
      if (!credential) fail(401, 'unauthorized', 'A server integration key is required.')
      return Response.json(await syncDocumentation(project, Number(credential.id), request.all()), { headers: { 'Cache-Control': 'no-store' } })
    }
    catch (error) {
      if (error instanceof SupportError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
      return Response.json({ error: { code: 'documentation_unavailable', message: 'Documentation could not be synchronized. Retry the same selected documents.' } }, { status: 503 })
    }
  },
})
