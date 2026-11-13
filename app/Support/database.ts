import { db, ensureDatabaseConfigLoaded, resolvedDatabaseConfig } from '@stacksjs/database/runtime'

export type Row = Record<string, unknown>

/** SQL is authored here by the application; values always travel separately. */
export async function query(sql: string, values: unknown[] = []): Promise<Row[]> {
  await ensureDatabaseConfigLoaded()
  let ordinal = 0
  const statement = resolvedDatabaseConfig().driver === 'postgres'
    ? sql.replace(/\?/g, () => `$${++ordinal}`)
    : sql
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
export async function workspaceTransaction<T>(workspaceId: number, action: () => Promise<T>): Promise<T> {
  return await db.transaction(async () => {
    await query('UPDATE support_workspaces SET id = id WHERE id = ?', [workspaceId])
    return await action()
  })
}

export { db }
