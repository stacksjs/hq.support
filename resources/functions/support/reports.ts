import { state } from '@stacksjs/stx'
import { createSupportConsole } from './console'

type Aggregate = { status?: string, author_type?: string, total: number | string }
export function createReports() {
  const workspace = createSupportConsole()
  const report = state<{ conversations: Aggregate[], messages: Aggregate[], tickets: Aggregate[] } | null>(null)
  async function load() {
    report.set(null)
    if (!workspace.project()) return
    const result = await workspace.run(() => workspace.request(workspace.projectPath('/reports')))
    if (result) report.set(result)
  }
  async function boot() { await workspace.boot(); await load() }
  function total(rows?: Aggregate[]) { return (rows || []).reduce((sum, row) => sum + Number(row.total), 0).toLocaleString() }
  return { workspace, report, load, boot, total }
}
