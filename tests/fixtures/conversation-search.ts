import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration, resolvedDatabaseConfig } from '@stacksjs/database'
import { overridesReady } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { insert, one, query } from '../../app/Support/database'

await overridesReady
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' }), base = `http://127.0.0.1:${server.port}/api`
let cookie = '', csrf = '', checks = 0
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++ }
async function http(path: string, token?: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json() as any }
}
try {
  const seed = await fetch(base + '/csrf-token'); csrf = (await seed.json() as any).token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  async function owner(name: string) {
    const email = name.toLowerCase().replaceAll(' ', '-') + '@search.example.test', password = 'ConversationSearch2026!'
    assert.equal((await http('/register', undefined, 'POST', { name, email, password, password_confirmation: password })).status, 200)
    const login = await http('/login', undefined, 'POST', { email, password })
    const token = login.data.access_token ?? login.data.token
    const workspace = (await http('/support/workspaces', token, 'POST', { name })).data.workspace
    return { token, workspace }
  }
  const first = await owner('First search'), other = await owner('Other search')
  async function project(account: typeof first, name: string) {
    const row = (await http(`/support/workspaces/${account.workspace.id}/projects`, account.token, 'POST', { name })).data.project
    const keys = (await http(`/support/projects/${row.public_id}/keys`, account.token, 'POST', {})).data
    return { ...row, keys }
  }
  const app = await project(first, 'Search app'), sibling = await project(first, 'Sibling app'), foreign = await project(other, 'Foreign app')
  async function create(app: any, subject: string, body: string) {
    const result = await http(`/v1/projects/${app.public_id}/conversations`, app.keys.ingestKey, 'POST', { externalId: 'customer', subject, body, idempotencyKey: crypto.randomUUID() })
    assert.equal(result.status, 201); return result.data.conversation.id as string
  }
  const older = await create(app, 'Billing question', 'The volcano invoice failed.'), middle = await create(app, 'Volcano refund', 'Please help.'), newest = await create(app, 'Volcano renewal', 'Please help.')
  const unrelated = await create(app, 'Unrelated subject', 'No matching words here.')
  const siblingId = await create(sibling, 'Volcano sibling', 'volcano')
  const foreignId = await create(foreign, 'Volcano foreign', 'volcano')
  const prefix = `/support/projects/${app.public_id}`, search = prefix + '/inbox?q=volcano'
  const result = await http(search, first.token)
  check(result.status === 200 && result.data.conversations.map((row: any) => row.id).join(',') === [newest, middle, older].join(','), 'server finds persisted subject and historical message text without sibling or foreign matches')
  check(result.data.search.mode === (resolvedDatabaseConfig().driver === 'postgres' ? 'fulltext' : 'lexical'), 'wire contract declares the actual database search mode')
  check(result.data.conversations.every((row: any) => !('body' in row) && !('snippet' in row)), 'search returns authorized conversation summaries without transcript excerpts')
  const reference = await create(app, 'Follow-up reference', `Please review conversation ${older} for context.`)
  const exact = await http(prefix + '/inbox?q=' + encodeURIComponent('#' + older), first.token)
  check(exact.status === 200 && exact.data.search.mode === 'id' && exact.data.conversations.map((row: any) => row.id).join(',') === older && exact.data.nextCursor === null, 'a displayed conversation ID finds only that conversation')
  const numeric = await http(prefix + '/inbox?q=' + older, first.token)
  check(numeric.status === 200 && numeric.data.conversations.map((row: any) => row.id).join(',') === [reference, older].join(','), 'a pasted numeric ID finds the thread and retains numeric transcript search')
  for (const id of [siblingId, foreignId]) {
    const hidden = await http(prefix + '/inbox?q=' + encodeURIComponent('#' + id), first.token)
    check(hidden.status === 200 && hidden.data.conversations.length === 0, 'exact ID search stays in the selected project and workspace')
  }
  check((await http(prefix + '/inbox?q=%239007199254740992', first.token)).status === 422, 'an out-of-range explicit ID is rejected without rounding')
  const page = await http(search + '&limit=1', first.token)
  check(page.data.conversations.length === 1 && page.data.conversations[0].id === newest && page.data.nextCursor === newest, 'first search page uses the durable conversation cursor')
  await create(app, 'Volcano later', 'new incoming message')
  const next = await http(search + '&limit=1&cursor=' + page.data.nextCursor, first.token)
  check(next.data.conversations.length === 1 && next.data.conversations[0].id === middle, 'new incoming conversations do not duplicate or shift the next keyset page')
  const last = await http(search + '&limit=1&cursor=' + next.data.nextCursor, first.token)
  check(last.data.conversations[0].id === older && last.data.nextCursor === null, 'body-only match remains reachable beyond the first subject page')
  await http(prefix + '/conversations/' + middle, first.token, 'PATCH', { status: 'closed' })
  const closed = await http(search + '&status=closed', first.token)
  check(closed.data.conversations.length === 1 && closed.data.conversations[0].id === middle, 'search composes with persisted conversation status')
  const exactOpen = await http(prefix + '/inbox?q=' + encodeURIComponent('#' + middle) + '&status=open', first.token)
  check(exactOpen.status === 200 && exactOpen.data.conversations.length === 0, 'exact ID search preserves the selected conversation status')
  const team = await insert('support_teams', { workspace_id: first.workspace.id, name: 'Search team' })
  const inbox = await insert('support_team_inboxes', { workspace_id: first.workspace.id, project_id: app.id, team_id: team.id, name: 'Search filter inbox' })
  await query('UPDATE support_conversations SET inbox_id = ? WHERE id = ?', [inbox.id, older])
  const inInbox = await http(search + '&inboxId=' + inbox.id, first.token)
  check(inInbox.status === 200 && inInbox.data.conversations.length === 1 && inInbox.data.conversations[0].id === older, 'search composes with the exact project inbox filter')
  const exactInbox = await http(prefix + '/inbox?q=' + encodeURIComponent('#' + older) + '&inboxId=0', first.token)
  check(exactInbox.status === 200 && exactInbox.data.conversations.length === 0, 'exact ID search preserves the selected team inbox scope')
  check((await http(search + '&inboxId=999999', first.token)).status === 404, 'unknown inbox scope cannot broaden search')
  await http(prefix + '/conversations/' + unrelated + '/messages', first.token, 'POST', { body: 'Confidential obsidian note', visibility: 'internal', idempotencyKey: crypto.randomUUID() })
  const note = await http(prefix + '/inbox?q=obsidian', first.token)
  check(note.status === 200 && note.data.conversations[0]?.id === unrelated, 'authorized agents can find internal support notes')
  check((await http(search, other.token)).status === 403, 'another workspace cannot search a project')
  check((await http(search)).status === 401, 'anonymous visitors cannot search the agent inbox')
  check((await http(`/v1/projects/${app.public_id}/conversations?q=obsidian`, app.keys.readKey)).status === 403, 'summary read keys cannot probe transcript text through search')
  const contact = (await one('SELECT id FROM support_contacts WHERE project_id = ?', [app.id]))!
  await insert('support_messages', { workspace_id: other.workspace.id, project_id: app.id, conversation_id: unrelated, contact_id: contact.id, body: 'forgedtenantneedle', visibility: 'public', author_type: 'customer' })
  check((await http(prefix + '/inbox?q=forgedtenantneedle', first.token)).data.conversations.length === 0, 'message scope requires workspace ownership as well as matching project and conversation')
  await query('UPDATE support_memberships SET status = ? WHERE workspace_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)', ['revoked', first.workspace.id, 'first-search@search.example.test'])
  check((await http(search, first.token)).status === 403, 'membership removal immediately denies subsequent searches')
  await query('UPDATE support_memberships SET status = ? WHERE workspace_id = ?', ['active', first.workspace.id])
  for (const suffix of ['q=a', 'q=' + 'x'.repeat(201), 'q=volcano&q=obsidian', 'q=volcano&cursor=1e0', 'q=volcano&limit=101']) check((await http(prefix + '/inbox?' + suffix, first.token)).status === 422, 'malformed or ambiguous search is rejected')
  const punctuation = await http(prefix + '/inbox?q=' + encodeURIComponent("' OR 1=1 -- % _"), first.token)
  check(punctuation.status === 200 && punctuation.data.conversations.length === 0, 'query punctuation remains bound data rather than SQL or wildcards')
  console.info(`PASS conversation search HTTP (${checks} checks)`)
}
finally { server.stop(true) }
