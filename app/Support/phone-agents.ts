import type { Call, VoiceWebhook } from '@stacksjs/telephony'
import type { Row, WorkspaceTransaction } from './database'
import type { PhoneDependencies } from './phone-config'
import { storeJob } from '@stacksjs/queue/utils'
import { insert, one, query, requireWorkspaceTransaction, workspaceTransaction } from './database'
import { fail } from './errors'
import { phoneContext, publicPhoneCall, terminalCall } from './phone'
import { phoneProvider } from './phone-config'
import { SqlPhoneJournal } from './phone-journal'
import { digest, member } from './service'

const jobName = 'EndRevokedPhoneLegs'
const retryMs = 30_000
const leaseMs = 60_000
const maxLegsPerRun = 4

export function phoneAgentIdentity(call: Row, agentId: number) {
  return `w${call.workspace_id}.p${call.project_id}.u${agentId}`
}

function dispatchAfterCommit(tx: WorkspaceTransaction, dialId: unknown) {
  tx.afterCommit(async () => {
    // The scheduler can recover the persisted dial even when dispatch is unavailable.
    await storeJob(jobName, { queue: 'support-workflows', payload: { dialId: Number(dialId) }, maxTries: 3, timeout: 60 }).catch(() => undefined)
  })
}

export async function authorizePhoneAgentDial(reference: string, workspaceId: number) {
  return await workspaceTransaction(workspaceId, async () => {
    const call = await publicPhoneCall(reference)
    const agentId = Number(call.assigned_agent_id)
    if (!agentId) fail(409, 'agent_not_assigned', 'No authenticated agent is assigned.')
    await member(agentId, workspaceId)
    const dial = await one('SELECT * FROM support_phone_agent_dials WHERE call_id = ? AND workspace_id = ? AND agent_id = ?', [call.id, workspaceId, agentId])
    if (Number(dial?.revoked_at) > 0) fail(403, 'forbidden', 'Phone access for this agent has been revoked.')
    if (!terminalCall(call.status) && Number(call.deadline_at) > Date.now() && !dial)
      await insert('support_phone_agent_dials', { workspace_id: workspaceId, call_id: call.id, agent_id: agentId })
    return { call, agentId }
  })
}

export async function revokePhoneAgentDials(workspaceId: number, agentId: number) {
  const tx = requireWorkspaceTransaction(workspaceId)
  const now = Date.now()
  const timestamp = new Date(now).toISOString()
  // A pre-upgrade call can still have a previous agent's leg after reassignment.
  // Check untracked parents against the exact provider child identity.
  await query(`INSERT INTO support_phone_agent_dials (workspace_id, call_id, agent_id, created_at, updated_at)
    SELECT parent.workspace_id, parent.id, ?, ?, ? FROM support_phone_calls AS parent
    WHERE parent.workspace_id = ? AND parent.transfer_at > 0 AND (parent.ended_at = 0 OR parent.deadline_at > ?)
    AND (parent.assigned_agent_id = ? OR parent.tracks_agent_dials = ?)
    ON CONFLICT (call_id, agent_id) DO NOTHING`, [agentId, timestamp, timestamp, workspaceId, now, agentId, false])
  const revoked = await query(`UPDATE support_phone_agent_dials SET revoked_at = ?, available_at = ?, updated_at = ?
    WHERE workspace_id = ? AND agent_id = ? AND revoked_at = 0
    AND call_id IN (SELECT id FROM support_phone_calls WHERE workspace_id = ? AND (ended_at = 0 OR deadline_at > ?))
    RETURNING id`, [now, now, timestamp, workspaceId, agentId, workspaceId, now])
  for (const dial of revoked) dispatchAfterCommit(tx, dial.id)
}

async function phoneEvent(call: Row, key: string, status: string, payload: Row) {
  requireWorkspaceTransaction(Number(call.workspace_id))
  const fingerprint = digest(key)
  if (await one('SELECT id FROM support_phone_events WHERE call_id = ? AND digest = ?', [call.id, fingerprint])) return false
  await insert('support_phone_events', { workspace_id: call.workspace_id, call_id: call.id, digest: fingerprint, sequence: -1, status, payload: JSON.stringify(payload) })
  return true
}

export async function rememberPhoneChild(call: Row, childSid: string) {
  if (!await phoneEvent(call, `dial:${childSid}`, 'dial-complete', { childSid })) return false
  await query('UPDATE support_phone_calls SET child_sid = ? WHERE id = ? AND workspace_id = ?', [childSid, call.id, call.workspace_id])
  return true
}

export async function recordPhoneAgentProgress(call: Row, form: URLSearchParams, callback: VoiceWebhook) {
  const agentId = Number(/^client:w\d+\.p\d+\.u([1-9]\d*)$/.exec(callback.to)?.[1])
  const parents = form.getAll('ParentCallSid')
  if (!Number.isSafeInteger(agentId) || callback.to !== 'client:' + phoneAgentIdentity(call, agentId)
    || parents.length !== 1 || parents[0] !== call.provider_sid || callback.callSid === call.provider_sid)
    fail(403, 'phone_call_mismatch', 'Provider callback does not match this agent leg.')
  await workspaceTransaction(Number(call.workspace_id), async (tx) => {
    const dial = await one('SELECT * FROM support_phone_agent_dials WHERE workspace_id = ? AND call_id = ? AND agent_id = ?', [call.workspace_id, call.id, agentId])
    if (!dial) fail(403, 'phone_call_mismatch', 'Provider callback does not match an authorized agent dial.')
    const observed = await phoneEvent(call, `agent-leg:${callback.callSid}`, 'agent-leg', { childSid: callback.callSid, agentId })
    const ended = terminalCall(callback.status) && await rememberPhoneChild(call, callback.callSid)
    if (Number(dial.revoked_at) > 0 && (observed || ended)) {
      await query('UPDATE support_phone_agent_dials SET available_at = ?, finished_at = 0, progress_revision = progress_revision + 1 WHERE id = ? AND workspace_id = ?', [Date.now(), dial.id, call.workspace_id])
      dispatchAfterCommit(tx, dial.id)
    }
  })
}

async function claimRevokedDial(dialId: number, now: number) {
  const dial = await one('SELECT workspace_id FROM support_phone_agent_dials WHERE id = ?', [dialId])
  if (!dial) return
  return await workspaceTransaction(Number(dial.workspace_id), async () => (await query(`UPDATE support_phone_agent_dials SET lease_until = ?
    WHERE id = ? AND workspace_id = ? AND revoked_at > 0 AND finished_at = 0 AND available_at <= ? AND lease_until <= ?
    RETURNING *`, [now + leaseMs, dialId, dial.workspace_id, now, now]))[0])
}

async function terminateChild(call: Row, child: Call, context: Awaited<ReturnType<typeof phoneContext>>, provider: Awaited<ReturnType<typeof phoneProvider>>) {
  const { channel, credentials } = context
  const operation = `revoke-agent:${call.public_id}:${child.sid}`
  const key = (status: string) => `twilio:${credentials.accountSid}:${operation}:${status}`
  const journal = new SqlPhoneJournal(Number(call.workspace_id), Number(channel.id))
  const target = child.status === 'in-progress' ? 'completed' : 'canceled'
  let result = child
  if (!terminalCall(child.status)) {
    const prior = await one('SELECT state FROM support_phone_operations WHERE workspace_id = ? AND channel_id = ? AND key = ?', [call.workspace_id, channel.id, key(target === 'completed' ? 'canceled' : 'completed')])
    if (prior && prior.state !== 'rejected') return false
    result = await provider.endCall(child.sid, target, { operationKey: `${operation}:${target}` })
    if (result.sid !== child.sid || result.parentSid !== child.parentSid || result.to !== child.to) return false
  }
  if (!terminalCall(result.status)) return false
  await journal.resolveConfirmed(key('canceled'), result)
  await journal.resolveConfirmed(key('completed'), result)
  await workspaceTransaction(Number(call.workspace_id), () => rememberPhoneChild(call, child.sid))
  return true
}

export async function processPhoneRevocation(dialId: number, dependencies: PhoneDependencies = {}) {
  const dial = await claimRevokedDial(dialId, Date.now())
  if (!dial) return
  let finished = false, lastError = ''
  try {
    const call = await one('SELECT * FROM support_phone_calls WHERE id = ? AND workspace_id = ?', [dial.call_id, dial.workspace_id])
    if (!call?.provider_sid) throw new Error('Missing parent call')
    const context = await phoneContext(call)
    const provider = await phoneProvider(context.channel, context.credentials, dependencies)
    const identity = 'client:' + phoneAgentIdentity(call, Number(dial.agent_id))
    const parentSid = String(call.provider_sid)
    const listed = await provider.listCalls({ parentSid })
    const children = new Map(listed.map(child => [child.sid, child]))
    const receipts = await query("SELECT payload FROM support_phone_events WHERE workspace_id = ? AND call_id = ? AND status = 'agent-leg' ORDER BY id DESC LIMIT 50", [call.workspace_id, call.id])
    const finishedReceipts = await query("SELECT payload FROM support_phone_events WHERE workspace_id = ? AND call_id = ? AND status = 'dial-complete'", [call.workspace_id, call.id])
    const finishedChildren = new Set(finishedReceipts.map(({ payload }) => JSON.parse(String(payload)).childSid))
    const operationPrefix = `twilio:${context.credentials.accountSid}:revoke-agent:${call.public_id}:`
    const unresolved = await query("SELECT key FROM support_phone_operations WHERE workspace_id = ? AND channel_id = ? AND key LIKE ? AND state IN ('pending', 'uncertain')", [call.workspace_id, context.channel.id, operationPrefix + '%'])
    const awaitingConfirmation = new Set(unresolved.map(row => String(row.key).slice(operationPrefix.length).split(':')[0]))
    const missing = receipts.map(({ payload }) => JSON.parse(String(payload)) as { agentId: number, childSid: string })
      .filter(leg => leg.agentId === Number(dial.agent_id) && !children.has(leg.childSid)
        && (!finishedChildren.has(leg.childSid) || awaitingConfirmation.has(leg.childSid)))
    const recoveredChildren = await Promise.all(missing.slice(0, maxLegsPerRun).map(leg => provider.getCall(leg.childSid)))
    for (const child of recoveredChildren) children.set(child.sid, child)
    if (missing.length > maxLegsPerRun) lastError = 'provider_reconciliation_pending'
    const scoped = [...children.values()].filter(child => child.sid !== parentSid && child.parentSid === parentSid && child.to === identity)
    const selected = scoped.filter(child => !terminalCall(child.status)).slice(0, maxLegsPerRun)
    const outcomes = await Promise.allSettled(selected.map(child => terminateChild(call, child, context, provider)))
    if (outcomes.some(result => result.status !== 'fulfilled' || !result.value)) lastError = 'provider_end_pending'
    for (const child of scoped.filter(child => terminalCall(child.status))) await terminateChild(call, child, context, provider)
    if (!lastError && listed.length < 50 && scoped.every(child => terminalCall(child.status))) {
      const parent = await provider.getCall(parentSid)
      finished = parent.sid === parentSid && parent.from === call.from_number && parent.to === call.to_number && terminalCall(parent.status)
    }
  }
  catch { lastError = 'provider_reconciliation_pending' }
  const now = Date.now()
  await workspaceTransaction(Number(dial.workspace_id), async (tx) => {
    const [released] = await query(`UPDATE support_phone_agent_dials
      SET finished_at = CASE WHEN progress_revision = ? THEN ? ELSE 0 END,
          available_at = CASE WHEN progress_revision = ? THEN ? ELSE available_at END,
          lease_until = 0, last_error = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND lease_until = ? RETURNING progress_revision`,
    [dial.progress_revision, finished ? now : 0, dial.progress_revision, now + retryMs, lastError, new Date(now).toISOString(), dial.id, dial.workspace_id, dial.lease_until])
    if (released && Number(released.progress_revision) !== Number(dial.progress_revision)) dispatchAfterCommit(tx, dial.id)
  })
}

export async function recoverPhoneRevocations(dependencies: PhoneDependencies = {}) {
  const now = Date.now()
  const rows = await query(`SELECT id FROM support_phone_agent_dials
    WHERE revoked_at > 0 AND finished_at = 0 AND available_at <= ? AND lease_until <= ? ORDER BY available_at, id LIMIT 5`, [now, now])
  await Promise.all(rows.map(dial => processPhoneRevocation(Number(dial.id), dependencies)))
}
