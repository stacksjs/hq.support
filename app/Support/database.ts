import { AsyncLocalStorage } from 'node:async_hooks'
import { db, enqueueAfterCommit, ensureDatabaseConfigLoaded, isInTransaction, resolvedDatabaseConfig } from '@stacksjs/database/runtime'

export type Row = Record<string, unknown>

export interface WorkspaceTransaction {
  readonly workspaceId: number
  readonly dialect: 'sqlite' | 'postgres'
  readonly query: (sql: string, values?: unknown[]) => Promise<Row[]>
  readonly afterCommit: (callback: () => void | Promise<void>) => void
}
interface WorkspaceContext { active: boolean, parent?: WorkspaceContext, handle: WorkspaceTransaction }
const workspaceContext = new AsyncLocalStorage<WorkspaceContext>()
function assertActive(context: WorkspaceContext) {
  if (workspaceContext.getStore() !== context) throw new Error('Matching active workspace transaction context required')
  for (let owner: WorkspaceContext | undefined = context; owner; owner = owner.parent) {
    if (!owner.active) throw new Error('An active workspace transaction is required')
  }
  if (!isInTransaction()) throw new Error('An active workspace transaction is required')
}
/** Requires both the matching workspace lock and a live transaction-bound handle. */
export function requireWorkspaceTransaction(workspaceId: number): WorkspaceTransaction {
  const context = workspaceContext.getStore()
  if (!context) throw new Error('An active workspace transaction is required')
  assertActive(context)
  if (context.handle.workspaceId !== workspaceId) throw new Error('Workspace transaction does not match')
  return context.handle
}

/** SQL is authored here by the application; values always travel separately. */
export async function query(sql: string, values: unknown[] = []): Promise<Row[]> {
  await ensureDatabaseConfigLoaded()
  let ordinal = 0
  const statement = resolvedDatabaseConfig().driver === 'postgres'
    ? sql.replace(/\?/g, () => `$${++ordinal}`)
    : sql
  const context = workspaceContext.getStore()
  if (context) {
    assertActive(context)
    return await context.handle.query(statement, values)
  }
  return await db.unsafe(statement, values).execute()
}

export async function one(sql: string, values: unknown[] = []): Promise<Row | undefined> {
  return (await query(sql, values))[0]
}

export async function insert(table: string, data: Row): Promise<Row> {
  if (!/^support_[a-z_]+$/.test(table)) throw new Error('Invalid support table')
  const now = new Date().toISOString()
  const columns = { ...data, created_at: now, updated_at: now }
  const keys = Object.keys(columns)
  return (await query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING *`, Object.values(columns)))[0]!
}

/** Serializes allowance checks and writes across every worker on the workspace row. */
export async function workspaceTransaction<T>(workspaceId: number, action: (tx: WorkspaceTransaction) => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(workspaceId) || workspaceId < 1) throw new TypeError('Invalid workspace identifier')
  const parent = workspaceContext.getStore()
  if (parent) requireWorkspaceTransaction(workspaceId)
  await ensureDatabaseConfigLoaded()
  const dialect = resolvedDatabaseConfig().driver
  if (dialect !== 'sqlite' && dialect !== 'postgres') throw new Error('Support requires SQLite or PostgreSQL')
  return await db.transaction(async (tx) => {
    const context: WorkspaceContext = { active: true, parent, handle: undefined! }
    const handle: WorkspaceTransaction = {
      workspaceId, dialect,
      async query(sql, values = []) {
        assertActive(context)
        let ordinal = 0
        const statement = dialect === 'postgres' ? sql.replace(/\?/g, () => `$${++ordinal}`) : sql
        return await tx.unsafe(statement, values).execute()
      },
      afterCommit(callback) {
        assertActive(context)
        if (!enqueueAfterCommit(callback)) throw new Error('Active transaction callback owner required')
      },
    }
    context.handle = handle
    return await workspaceContext.run(context, async () => {
      try {
        const rows = await handle.query('UPDATE support_workspaces SET id = id WHERE id = ? RETURNING id', [workspaceId])
        if (!rows.length) throw new Error('Workspace transaction requires an existing workspace')
        return await action(handle)
      }
      finally { context.active = false }
    })
  })
}

export { db }
