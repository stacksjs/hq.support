import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { conversation, customer, enqueue, idempotent, member } from './service'
import { fail, identifier, text } from './errors'
import { periodOf } from './limits'

const defaultQuestion = 'How was your support experience?'
async function setting(project: Row) { return await one('SELECT * FROM support_csat_settings WHERE workspace_id = ? AND project_id = ?', [project.workspace_id, project.id]) }
function settingView(row?: Row) { return { enabled: Boolean(row?.enabled), revision: Number(row?.revision ?? 0), question: String(row?.question ?? defaultQuestion) } }
function responseView(row: Row) { return { id: String(row.id), score: Number(row.score), comment: String(row.comment), question: String(row.question), revision: Number(row.setting_revision), createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at) } }
export async function csatSettings(project: Row, userId: number) { await member(userId, Number(project.workspace_id), ['owner', 'admin']); return { settings: settingView(await setting(project)) } }
export async function configureCsat(project: Row, userId: number, input: Row) {
  if (Object.keys(input).some(key => !['enabled', 'question', 'expectedRevision'].includes(key)) || typeof input.enabled !== 'boolean' || typeof input.expectedRevision !== 'number' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail(422, 'invalid_csat_settings', 'Supply enabled, question and the current expectedRevision.')
  const question = text(input.question, 'question', 160)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    await member(userId, Number(project.workspace_id), ['owner', 'admin'])
    const current = await setting(project)
    if (Number(current?.revision ?? 0) !== input.expectedRevision) fail(409, 'csat_settings_changed', 'Survey settings changed. Refresh before saving.')
    const revision = Number(current?.revision ?? 0) + 1
    if (!Number.isSafeInteger(revision)) fail(409, 'csat_settings_changed', 'Survey revision is outside the supported range.')
    if (current) await query('UPDATE support_csat_settings SET enabled = ?, question = ?, revision = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND project_id = ?', [input.enabled, question, revision, new Date().toISOString(), current.id, project.workspace_id, project.id])
    else await insert('support_csat_settings', { workspace_id: project.workspace_id, project_id: project.id, enabled: input.enabled, question, revision })
    await enqueue(project, 'csat.configured', { actorId: userId, revision, enabled: input.enabled })
    return { settings: settingView(await setting(project)) }
  })
}
async function priorResponse(project: Row, row: Row, person: Row) { return await one('SELECT * FROM support_csat_responses WHERE workspace_id = ? AND project_id = ? AND conversation_id = ? AND contact_id = ?', [project.workspace_id, project.id, row.id, person.id]) }
export async function customerCsat(project: Row, id: unknown, person: Row) {
  const row = await conversation(project, id, person)
  if (Number(row.workspace_id) !== Number(project.workspace_id)) fail(404, 'not_found', 'Conversation not found.')
  const prior = await priorResponse(project, row, person)
  if (prior) return { available: false, reason: 'answered', response: responseView(prior) }
  const current = settingView(await setting(project))
  if (!current.enabled) return { available: false, reason: 'disabled' }
  if (row.status !== 'closed') return { available: false, reason: 'conversation_open' }
  return { available: true, survey: { revision: current.revision, question: current.question, minimumScore: 1, maximumScore: 5 } }
}
export async function submitCsat(project: Row, id: unknown, token: string, input: Row) {
  if (Object.keys(input).some(key => !['score', 'comment', 'revision', 'idempotencyKey'].includes(key))) fail(422, 'invalid_csat_response', 'Supply only score, comment, revision and idempotencyKey.')
  if (typeof input.score !== 'number' || !Number.isSafeInteger(input.score) || input.score < 1 || input.score > 5) fail(422, 'invalid_csat_score', 'Choose a whole-number score from one through five.')
  const revision = identifier(input.revision), key = text(input.idempotencyKey, 'idempotencyKey', 200)
  const comment = input.comment === undefined ? '' : input.comment
  if (typeof comment !== 'string' || comment.length > 2000) fail(422, 'invalid_csat_comment', 'Feedback comments may contain at most 2000 characters.')
  const payload = { score: input.score, comment: comment.trim(), revision }
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    // Recheck current SQL session authority after acquiring the same lock used by revocation.
    const person = await customer(project, token), row = await conversation(project, id, person)
    if (Number(row.workspace_id) !== Number(project.workspace_id)) fail(404, 'not_found', 'Conversation not found.')
    return await idempotent(project, `csat:${person.id}:${row.id}`, key, payload, async () => {
      if (await priorResponse(project, row, person)) fail(409, 'csat_already_answered', 'This conversation already has a satisfaction response.')
      const current = settingView(await setting(project))
      if (!current.enabled || row.status !== 'closed') fail(409, 'csat_unavailable', 'This survey is no longer accepting a response.')
      if (current.revision !== revision) fail(409, 'csat_question_changed', 'The survey question changed. Refresh before responding.')
      const answer = await insert('support_csat_responses', { workspace_id: project.workspace_id, project_id: project.id, conversation_id: row.id, contact_id: person.id, setting_revision: revision, question: current.question, score: payload.score, comment: payload.comment })
      await enqueue(project, 'csat.submitted', { responseId: String(answer.id), conversationId: String(row.id), revision, score: payload.score })
      return { response: responseView(answer) }
    })
  })
}
export async function csatReport(project: Row, userId: number, period = periodOf()) {
  await member(userId, Number(project.workspace_id))
  if (!/^[12]\d{3}-(0[1-9]|1[0-2])$/.test(period)) fail(422, 'invalid_period', 'Use a UTC calendar month in YYYY-MM form.')
  const [year, month] = period.split('-').map(Number), start = `${period}-01T00:00:00.000Z`, end = new Date(Date.UTC(year!, month!, 1)).toISOString()
  const rows = await query('SELECT score, COUNT(*) AS total FROM support_csat_responses WHERE workspace_id = ? AND project_id = ? AND created_at >= ? AND created_at < ? GROUP BY score', [project.workspace_id, project.id, start, end])
  const distribution = [1, 2, 3, 4, 5].map(score => ({ score, count: Number(rows.find(row => Number(row.score) === score)?.total ?? 0) }))
  const responses = distribution.reduce((sum, row) => sum + row.count, 0), totalScore = distribution.reduce((sum, row) => sum + row.score * row.count, 0), satisfied = distribution.filter(row => row.score >= 4).reduce((sum, row) => sum + row.count, 0)
  return { period, responses, averageScore: responses ? Math.round(totalScore / responses * 100) / 100 : null, satisfiedPercent: responses ? Math.round(satisfied / responses * 10000) / 100 : null, distribution }
}
