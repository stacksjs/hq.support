import type { HqServiceAdapter } from '@stacksjs/hq/service'
import { confirmationMatches, createHqService, sqlConnectCodeStore } from '@stacksjs/hq/service'
import { ensureDatabaseConfigLoaded, resolvedDatabaseConfig } from '@stacksjs/database/runtime'
import { one, query, workspaceTransaction } from './database'
import { createProject, createWorkspace, issueKeys, member, readPrincipal, usage, workspace } from './service'
import { limitsFor } from './limits'
import type { Plan } from './limits'
import { fail } from './errors'

export type HqUser = { id: number, email: string, workspaceId?: number }
const base = () => (process.env.APP_URL || 'https://hq.support').replace(/\/$/, '')

export async function adapter(): Promise<HqServiceAdapter<HqUser>> {
  await ensureDatabaseConfigLoaded()
  const driver = resolvedDatabaseConfig().driver
  return {
    service: 'supporthq',
    approveUrl: code => `${base()}/connect?code=${encodeURIComponent(code)}`,
    upgradeUrl: `${base()}/pricing`,
    codes: sqlConnectCodeStore({ unsafe: (sql, values) => query(sql, values) }, { dialect: driver === 'postgres' ? 'postgres' : 'sqlite' }),
    async provision(user, request) {
      if (user.workspaceId) await member(user.id, user.workspaceId, ['owner', 'admin'])
      let owner = user.workspaceId ? await workspace(user.workspaceId) : await one('SELECT * FROM support_workspaces WHERE owner_id = ? ORDER BY id ASC LIMIT 1', [user.id])
      if (!owner) owner = await createWorkspace(user, request.app)
      return await workspaceTransaction(Number(owner.id), async () => {
        let project = await one('SELECT * FROM support_projects WHERE workspace_id = ? AND name = ? ORDER BY id LIMIT 1', [owner.id, request.app])
        if (!project) project = await createProject(Number(owner.id), request.app)
        await query('UPDATE support_projects SET buddy_connected_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [Date.now(), new Date().toISOString(), project.id, owner.id])
        const keys = await issueKeys(project)
        return { project: { id: String(project.public_id), name: String(project.name) }, ...keys, dashboardUrl: `${base()}/inbox?project=${project.public_id}` }
      })
    },
    authenticateReadKey: readPrincipal,
    async usage(principal) {
      const owner = await one('SELECT * FROM support_workspaces WHERE id = ?', [Number(principal.owner)])
      if (!owner) return []
      const limits = limitsFor(owner.plan as Plan)
      return [
        { meter: 'conversations', used: await usage(Number(owner.id), 'conversations'), limit: limits.conversations, policy: 'hard-send' },
        { meter: 'ai', used: await usage(Number(owner.id), 'ai'), limit: limits.ai, policy: { kind: 'hard-send', gracePercent: 0, warnPercent: 80, keepEvery: 1 } },
        { meter: 'storage', used: Number(owner.storage_bytes), limit: limits.storageBytes, policy: { kind: 'hard-send', gracePercent: 0, warnPercent: 80, keepEvery: 1 } },
      ]
    },
  }
}
export async function hq() { return createHqService(await adapter()) }

export async function approve(code: string, typed: string, user: HqUser) {
  // Native route throttle limits guesses by the signed-in identity before this call.
  if (!await confirmationMatches(code, typed)) fail(422, 'confirmation_mismatch', 'Enter the confirmation code printed by Buddy.')
  return await (await hq()).approveConnect(code, user)
}
