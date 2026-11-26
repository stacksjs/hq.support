import type { Row } from './database'
import { ensureDatabaseConfigLoaded, resolvedDatabaseConfig } from '@stacksjs/database/runtime'
import { query } from './database'

export interface ReportDuration { samples: number, averageMs: number | null }
type TimingMetric = 'firstReply' | 'followUpReply' | 'resolution'

async function messengerTimings(scope: unknown[], through: number) {
  const since = through - 30 * 86_400_000
  const postgres = resolvedDatabaseConfig().driver === 'postgres'
  const epochMs = (column: string) => postgres ? `ROUND(EXTRACT(EPOCH FROM ${column}) * 1000)` : `ROUND(unixepoch(${column}, 'subsec') * 1000)`
  const rows = await query(`
    WITH cohort AS (
      SELECT id, status, resolved_at FROM support_conversations c
      WHERE c.workspace_id = ? AND c.project_id = ? AND c.channel = 'widget'
        AND ${epochMs('c.created_at')} BETWEEN ? AND ?
        AND c.id NOT IN (
          SELECT conversation_id FROM support_phone_calls
          WHERE workspace_id = ? AND project_id = ? AND conversation_id IS NOT NULL
        )
    ), timeline AS (
      SELECT m.id, m.conversation_id, m.author_type, ${epochMs('m.created_at')} AS at_ms
      FROM cohort c JOIN support_messages m ON m.conversation_id = c.id
      WHERE m.workspace_id = ? AND m.project_id = ? AND m.visibility = 'public' AND m.delivery_status = 'stored'
        AND (m.author_type = 'customer' OR (m.author_type = 'agent' AND m.author_id > 0))
    ), ordered AS (
      SELECT *, MIN(CASE WHEN author_type = 'customer' THEN at_ms END) OVER (PARTITION BY conversation_id) AS started_at,
        LAG(author_type) OVER thread AS previous_author, LAG(at_ms) OVER thread AS previous_at
      FROM timeline WHERE at_ms <= ?
      WINDOW thread AS (PARTITION BY conversation_id ORDER BY at_ms, id)
    ), replies AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY at_ms, id) AS reply_number
      FROM ordered WHERE author_type = 'agent' AND previous_author = 'customer'
    ), samples AS (
      SELECT 'firstReply' AS metric, at_ms - started_at AS duration_ms FROM replies WHERE reply_number = 1
      UNION ALL
      SELECT 'followUpReply', at_ms - previous_at FROM replies WHERE reply_number > 1
      UNION ALL
      SELECT 'resolution', c.resolved_at - MIN(o.started_at)
      FROM cohort c JOIN ordered o ON o.conversation_id = c.id AND o.author_type = 'customer'
      WHERE c.status = 'closed' AND c.resolved_at > 0 AND c.resolved_at <= ?
      GROUP BY c.id, c.resolved_at HAVING c.resolved_at >= MIN(o.started_at)
    )
    SELECT metric, COUNT(*) AS samples, AVG(duration_ms) AS average_ms FROM samples GROUP BY metric
  `, [...scope, since, through, ...scope, ...scope, through, through])
  function duration(metric: TimingMetric): ReportDuration {
    const row = rows.find(row => row.metric === metric)
    return row ? { samples: Number(row.samples), averageMs: Math.round(Number(row.average_ms)) } : { samples: 0, averageMs: null }
  }
  return { since, through, firstReply: duration('firstReply'), followUpReply: duration('followUpReply'), resolution: duration('resolution') }
}

export async function projectReports(project: Row, through: number) {
  await ensureDatabaseConfigLoaded()
  const scope = [project.workspace_id, project.id]
  return {
    conversations: await query('SELECT status, COUNT(*) AS total FROM support_conversations WHERE workspace_id = ? AND project_id = ? GROUP BY status', scope),
    messages: await query('SELECT author_type, COUNT(*) AS total FROM support_messages WHERE workspace_id = ? AND project_id = ? GROUP BY author_type', scope),
    tickets: await query('SELECT status, COUNT(*) AS total FROM support_tickets WHERE workspace_id = ? AND project_id = ? GROUP BY status', scope),
    messengerTimings: await messengerTimings(scope, through),
  }
}
