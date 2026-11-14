import { Action } from '@stacksjs/actions/runtime'
import { digest, keyProject } from '../../Support/service'
import { one, query, workspaceTransaction } from '../../Support/database'
import { fail, SupportError, text } from '../../Support/errors'

export function installationAction(configure: boolean) {
  return new Action({ name: 'Check native support installation', method: configure ? 'POST' : 'GET', apiResponse: false,
    async handle(request) {
      try {
        const key = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')?.[1] || ''
        const project = await keyProject(request.getParam('project'), key, 'write')
        if (!Number(project.buddy_connected_at)) fail(403, 'buddy_approval_required', 'Approve a Buddy connection before enabling a native installation.')
        if (!configure) return Response.json({ service: 'supporthq', protocol: 1, project: project.public_id, buddyConnected: true, allowedOrigins: JSON.parse(String(project.allowed_origins)), anonymousEnabled: Boolean(project.anonymous_enabled) }, { headers: { 'Cache-Control': 'no-store' } })
        const input = request.all()
        const origin = new URL(text(input.origin, 'origin', 2048))
        if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) fail(422, 'invalid_origin', 'Use the public HTTPS app origin or a local development origin.')
        const version = text(input.frameworkVersion, 'frameworkVersion', 50)
        if (!/^\d+\.\d+\.\d+$/.test(version) || !Bun.semver.satisfies(version, '>=0.75.573')) fail(422, 'unsupported_runtime', 'Upgrade to a supported native Stacks runtime.')
        await workspaceTransaction(Number(project.workspace_id), async () => {
          if (!await one("SELECT id FROM support_api_keys WHERE project_id = ? AND digest = ? AND scope = 'write' AND revoked_at = 0", [project.id, digest(key)])) fail(401, 'unauthorized', 'The integration key has been revoked.')
          const current = (await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [project.id, project.workspace_id]))!
          const origins = JSON.parse(String(current.allowed_origins)) as string[]
          if (!origins.includes(origin.origin)) origins.push(origin.origin)
          if (origins.length > 20) fail(422, 'origin_limit', 'Review the allowed origins before adding another installation.')
          await query('UPDATE support_projects SET allowed_origins = ?, updated_at = ? WHERE id = ?', [JSON.stringify(origins), new Date().toISOString(), project.id])
        })
        return Response.json({ project: project.public_id, origin: origin.origin, allowed: true, frameworkAttestation: 'self_reported' }, { headers: { 'Cache-Control': 'no-store' } })
      }
      catch (error) {
        if (error instanceof SupportError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
        if (error instanceof TypeError) return Response.json({ error: { code: 'invalid_installation', message: 'Use a valid application origin.' } }, { status: 422 })
        return Response.json({ error: { code: 'installation_unavailable', message: 'Installation could not be confirmed.' } }, { status: 503 })
      }
    },
  })
}
