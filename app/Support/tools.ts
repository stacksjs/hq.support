import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, text } from './errors'
import { digest, object } from './service'
import { searchArticles } from './knowledge'

export const supportVoiceTools = [
  { name: 'search_knowledge', description: 'Find published public help articles for this caller project.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'create_ticket', description: 'Create a support ticket for this caller only.', parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' } }, required: ['title', 'description'], additionalProperties: false } },
  { name: 'request_human', description: 'Ask an agent to take over this call. Do not choose a destination.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
]
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Row)[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
/** Authority comes exclusively from the persisted call binding, never tool arguments. */
export async function executeSupportTool(callPublicId: string, toolCallId: string, name: string, args: Row) {
  if (!/^[\w-]{1,128}$/.test(toolCallId)) fail(422, 'invalid_tool', 'Tool invocation ID is invalid.')
  const call = await one('SELECT * FROM support_phone_calls WHERE public_id = ?', [callPublicId])
  if (!call) fail(404, 'not_found', 'Call not found.')
  return await workspaceTransaction(Number(call.workspace_id), async () => {
    const fingerprint = digest(canonical({ name, args }))
    const previous = await one('SELECT * FROM support_phone_tool_results WHERE workspace_id = ? AND call_id = ? AND tool_call_id = ?', [call.workspace_id, call.id, toolCallId])
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail(409, 'tool_conflict', 'This tool invocation already used different arguments.')
      return JSON.parse(String(previous.result)) as Row
    }
    const current = await one("SELECT * FROM support_phone_calls WHERE id = ? AND workspace_id = ? AND mode = 'ai' AND status = 'in-progress' AND stream_state = 'active'", [call.id, call.workspace_id])
    let result: Row
    const project = current ? await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [current.project_id, current.workspace_id]) : undefined
    const contact = current ? await one('SELECT * FROM support_contacts WHERE id = ? AND workspace_id = ? AND project_id = ?', [current.contact_id, current.workspace_id, current.project_id]) : undefined
    if (!current || !project || !contact) result = { error: 'tool_authority_expired' }
    else if (Object.keys(args).some(key => !({ search_knowledge: ['query'], create_ticket: ['title', 'description'], request_human: [] } as Record<string, string[]>)[name]?.includes(key))) result = { error: 'unsupported_tool_arguments' }
    else if (name === 'search_knowledge') {
      const found = await searchArticles(project, text(args.query, 'query', 500), { internal: false })
      result = { articles: found.articles }
    }
    else if (name === 'create_ticket') {
      const ticket = await insert('support_tickets', { workspace_id: current.workspace_id, project_id: current.project_id, contact_id: contact.id, conversation_id: current.conversation_id, title: text(args.title, 'title', 200), description: text(args.description, 'description', 10000) })
      result = { ticket: { id: String(ticket.id), title: ticket.title, status: ticket.status } }
    }
    else if (name === 'request_human') {
      await query("UPDATE support_phone_calls SET mode = 'handoff-requested', updated_at = ? WHERE id = ? AND workspace_id = ?", [new Date().toISOString(), current.id, current.workspace_id])
      result = { requested: true }
    }
    else result = { error: 'unsupported_tool' }
    await insert('support_phone_tool_results', { workspace_id: call.workspace_id, call_id: call.id, tool_call_id: toolCallId, fingerprint, name, result: JSON.stringify(result) })
    if (contact) await insert('support_events', { workspace_id: call.workspace_id, project_id: call.project_id, contact_id: contact.id, event: 'ai.tool.executed', attributes: JSON.stringify({ callId: call.public_id, toolCallId, name, allowed: !object(result).error }) })
    return result
  })
}
