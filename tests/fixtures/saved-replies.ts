import assert from 'node:assert/strict'
import { overridesReady } from '@stacksjs/config'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { route } from '@stacksjs/router'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { insert, one, query } from '../../app/Support/database'

await overridesReady
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()

const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${server.port}/api`
let cookie = '', csrf = ''

async function http(path: string, token?: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { accept: 'application/json', cookie, 'x-csrf-token': csrf, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, data: await response.json() as any }
}

async function account(name: string) {
  const email = `${name}@saved-replies.example.test`
  const password = 'SavedRepliesFixture2026!'
  assert.equal((await http('/register', undefined, 'POST', { name, email, password, password_confirmation: password })).status, 200)
  const login = await http('/login', undefined, 'POST', { email, password })
  const token = String(login.data.access_token ?? login.data.token)
  const row = await one('SELECT id FROM users WHERE email = ?', [email])
  assert.ok(row)
  return { token, id: Number(row.id), email }
}

try {
  const bootstrap = await fetch(base + '/csrf-token')
  csrf = (await bootstrap.json() as { token: string }).token
  cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  const owner = await account('owner')
  const agent = await account('agent')
  const admin = await account('admin')
  const outsider = await account('outsider')
  const workspace = (await http('/support/workspaces', owner.token, 'POST', { name: 'Saved replies team' })).data.workspace
  const path = `/support/workspaces/${workspace.id}/projects`
  const project = (await http(path, owner.token, 'POST', { name: 'Main project' })).data.project
  const sibling = (await http(path, owner.token, 'POST', { name: 'Other project' })).data.project
  for (const [user, role] of [[agent, 'agent'], [admin, 'admin']] as const) {
    await insert('support_memberships', { workspace_id: workspace.id, user_id: user.id, email: user.email, role, status: 'active' })
  }

  const replies = `/support/projects/${project.public_id}/saved-replies`
  const siblingReplies = `/support/projects/${sibling.public_id}/saved-replies`
  const template = { name: 'Refund 10%', body: 'Thanks for getting in touch.\nI can help with your refund.', idempotencyKey: 'create-refund-reply' }
  const blank = await http(replies, agent.token)
  assert.equal(blank.status, 200, 'active agents can list shared replies')
  assert.deepEqual(blank.data, { replies: [], nextCursor: null })
  assert.equal((await http(replies)).status, 401)
  assert.equal((await http(replies, outsider.token)).status, 403)
  assert.equal((await http(replies, agent.token, 'POST', template)).status, 403)
  assert.equal((await http(replies, admin.token, 'POST', { ...template, body: ' ' })).status, 422)
  assert.equal((await http(replies, admin.token, 'POST', { ...template, name: 'x'.repeat(121) })).status, 422)
  assert.equal((await http(replies, admin.token, 'POST', { ...template, body: 'x'.repeat(10001) })).status, 422)

  const created = await http(replies, admin.token, 'POST', template)
  assert.equal(created.status, 201)
  assert.deepEqual((await http(replies, admin.token, 'POST', template)).data, created.data)
  assert.equal(created.data.reply.revision, 1)
  const id = created.data.reply.id
  const item = `${replies}/${id}`
  assert.deepEqual((await http(replies + '?q=REFUND%2010%25', agent.token)).data.replies, [created.data.reply])
  assert.deepEqual((await http(replies + '?q=%25_foo', agent.token)).data.replies, [])
  assert.deepEqual((await http(siblingReplies, owner.token)).data.replies, [])
  assert.equal((await http(`${siblingReplies}/${id}`, owner.token, 'PATCH', { ...template, revision: 1 })).status, 404)
  assert.equal((await http(`${siblingReplies}/${id}/archive`, owner.token, 'POST')).status, 404)
  assert.equal((await http(item, agent.token, 'PATCH', { ...template, revision: 1 })).status, 403)
  assert.equal((await http(item + '/archive', agent.token, 'POST')).status, 403)

  const inputs = ['Expected refund', 'Refund confirmation'].map(name => ({ ...template, name, revision: 1, idempotencyKey: 'edit-' + name }))
  const edits = await Promise.all(inputs.map(input => http(item, owner.token, 'PATCH', input)))
  assert.deepEqual(edits.map(edit => edit.status).sort(), [200, 409])
  const winner = edits.findIndex(edit => edit.status === 200)
  const edited = edits[winner]!.data.reply
  assert.equal(edited.id, id)
  assert.equal(edited.revision, 2)
  assert.deepEqual((await http(item, owner.token, 'PATCH', inputs[winner])).data.reply, edited)
  assert.equal(edits[1 - winner]!.data.error.code, 'saved_reply_changed')
  assert.deepEqual((await http(replies, agent.token)).data.replies, [edited])

  const archived = await http(item + '/archive', admin.token, 'POST')
  assert.equal(archived.status, 200)
  assert.equal((await http(item + '/archive', owner.token, 'POST')).status, 200)
  assert.deepEqual((await http(replies, agent.token)).data.replies, [])
  assert.equal((await http(item, owner.token, 'PATCH', { ...template, revision: 2 })).status, 404)
  assert.ok((await one('SELECT archived FROM support_saved_replies WHERE id = ?', [id]))!.archived)

  const international = await http(replies, owner.token, 'POST', { name: 'Übergabe', body: 'Wir helfen Ihnen weiter.', idempotencyKey: 'unicode-title' })
  assert.equal(international.status, 201)
  for (const title of ['Übergabe', 'üBERGABE', 'U\u0308bergabe']) {
    const found = await http(`${replies}?q=${encodeURIComponent(title)}`, agent.token)
    assert.deepEqual(found.data.replies, [international.data.reply], 'normalized Unicode title search finds a saved reply')
  }
  const internationalPath = `${replies}/${international.data.reply.id}`
  const renamed = await http(internationalPath, owner.token, 'PATCH', { name: 'Rückruf', body: international.data.reply.body, revision: 1, idempotencyKey: 'unicode-rename' })
  assert.equal(renamed.status, 200)
  assert.deepEqual((await http(replies + '?q=%C3%9Cbergabe', agent.token)).data.replies, [])
  assert.deepEqual((await http(replies + '?q=RU%CC%88CKRUF', agent.token)).data.replies, [renamed.data.reply])
  assert.equal((await http(internationalPath + '/archive', owner.token, 'POST')).status, 200)

  for (let index = 1; index <= 51; index++) {
    await insert('support_saved_replies', { workspace_id: workspace.id, project_id: project.id, name: `Page reply ${index}`, search_name: `page reply ${index}`, body: 'Reusable text.' })
  }
  const firstPage = (await http(replies, agent.token)).data
  assert.equal(firstPage.replies.length, 50)
  const nextPage = (await http(`${replies}?cursor=${firstPage.nextCursor}`, agent.token)).data
  assert.equal(nextPage.replies.length, 1)
  assert.equal(nextPage.replies[0].name, 'Page reply 1')
  assert.equal(nextPage.nextCursor, null)
  assert.equal((await http(replies + '?cursor=invalid', agent.token)).status, 422)

  await query("UPDATE support_memberships SET status = 'revoked' WHERE workspace_id = ? AND user_id = ?", [workspace.id, agent.id])
  assert.equal((await http(replies, agent.token)).status, 403)
  assert.equal((await http(`/widget/projects/${project.public_id}/saved-replies`)).status, 404)
  console.log('PASS saved replies HTTP')
}
finally {
  await server.stop(true)
}
