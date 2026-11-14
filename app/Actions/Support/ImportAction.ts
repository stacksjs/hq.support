import { Action } from '@stacksjs/actions/runtime'
import { agentProject, digest, keyProject } from '../../Support/service'
import { SupportError, fail } from '../../Support/errors'
import { controlImport, importStatus, integrationImportResult, integrationImportStatus, listImports, previewIntercomBundle, uploadIntercomBundle } from '../../Support/imports'
import type { ImportPrincipal } from '../../Support/imports'
import type { Row } from '../../Support/database'

export function importAction(operation: 'list' | 'upload' | 'status' | 'pause' | 'resume', integration = false) {
  return new Action({
    name: `Support migration ${integration ? 'integration' : 'user'} ${operation}`, method: ['list', 'status'].includes(operation) ? 'GET' : 'POST',
    async handle(request) {
      try {
        const key = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')?.[1] || ''
        const userId = integration ? undefined : Number((await request.user())?.id)
        const project = integration ? await keyProject(request.getParam('project'), key, 'write') : await agentProject(userId!, request.getParam('project'), ['owner', 'admin'])
        const principal: ImportPrincipal = integration ? { kind: 'integration', keyDigest: digest(key) } : userId!
        let result: Row, status = 200
        if (operation === 'list') result = await listImports(project, principal)
        else if (operation === 'status') result = integration ? await integrationImportStatus(project, principal, request.getParam('id')) : await importStatus(project, principal, request.getParam('id'))
        else if (operation === 'upload') {
          const file = request.files.file, preview = request.get('dryRun')
          if (!(file instanceof File)) fail(422, 'import_file_required', 'Upload one JSON migration bundle in the file field.')
          if (preview !== undefined && ![true, false, 'true', 'false'].includes(preview)) fail(422, 'invalid_preview_option', 'dryRun must be true or false.')
          const dryRun = preview === true || preview === 'true'
          result = dryRun ? await previewIntercomBundle(project, principal, file) : await uploadIntercomBundle(project, principal, file)
          status = dryRun ? 200 : 202
        }
        else result = await controlImport(project, principal, request.getParam('id'), operation)
        if (integration && !result.dryRun) result = integrationImportResult(result)
        return Response.json(result, { status, headers: { 'Cache-Control': 'no-store' } })
      }
      catch (error) {
        if (error instanceof SupportError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
        console.error('[support-import]', error instanceof Error ? error.name : 'UnknownError')
        if (process.env.APP_ENV === 'test') console.error(error)
        return Response.json({ error: { code: 'import_unavailable', message: 'Migration is unavailable. Retry the same bundle or resume its saved run.' } }, { status: 503 })
      }
    },
  })
}
