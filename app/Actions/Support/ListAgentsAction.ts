import { Action } from '@stacksjs/actions/runtime'
import { query } from '../../Support/database'
import { agentProject } from '../../Support/service'
import { SupportError } from '../../Support/errors'

export default new Action({
  name: 'List project workspace agents', method: 'GET',
  async handle(request) {
    try {
      const project = await agentProject(Number((await request.user())?.id), request.getParam('project'))
      const rows = await query("SELECT u.id, u.name, u.email, m.role FROM support_memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.status = 'active' ORDER BY u.name, u.id LIMIT 1000", [project.workspace_id])
      return Response.json({ agents: rows.map(row => ({ id: String(row.id), name: String(row.name), email: String(row.email), role: String(row.role) })) }, { headers: { 'Cache-Control': 'no-store' } })
    }
    catch (error) {
      if (error instanceof SupportError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
      throw error
    }
  },
})
