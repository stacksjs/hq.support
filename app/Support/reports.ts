import type { Row } from './database'
import { ensureDatabaseConfigLoaded, resolvedDatabaseConfig } from '@stacksjs/database/runtime'
import { channelProviders } from './channels'
import { query } from './database'

export interface ReportDuration { samples: number, averageMs: number | null }
type TimingMetric = 'firstReply' | 'followUpReply' | 'resolution'
export interface ReportTimings { firstReply: ReportDuration, followUpReply: ReportDuration, resolution: ReportDuration }
export interface ChannelReportTimings extends ReportTimings { channel: string }

async function responseTimings(scope: unknown[], through: number) {
  const since = through - 30 * 86_400_000
  const postgres = resolvedDatabaseConfig().driver === 'postgres'
  const epochMs = (column: string) => postgres ? `ROUND(EXTRACT(EPOCH FROM ${column}) * 1000)` : `ROUND(unixepoch(${column}, 'subsec') * 1000)`
  const channels = ['widget', ...channelProviders.filter(provider => provider !== 'twilio')]
  const rows = await query(`
    WITH cohort AS (
      SELECT id, workspace_id, project_id, channel, status, resolved_at FROM support_conversations c
      WHERE c.workspace_id = ? AND c.project_id = ? AND c.channel IN (${channels.map(() => '?').join(', ')})
        AND ${epochMs('c.created_at')} BETWEEN ? AND ?
        AND c.id NOT IN (
          SELECT conversation_id FROM support_phone_calls
          WHERE workspace_id = ? AND project_id = ? AND conversation_id IS NOT NULL
        )
    ), source_messages AS (
      SELECT c.channel, m.id, m.conversation_id, m.project_id, m.workspace_id, m.author_type, m.delivery_status,
        ${epochMs('m.created_at')} AS stored_at
      FROM cohort c JOIN support_messages m
        ON m.conversation_id = c.id AND m.workspace_id = c.workspace_id AND m.project_id = c.project_id
      WHERE m.visibility = 'public'
        AND (m.author_type = 'customer' OR (m.author_type = 'agent' AND m.author_id > 0))
    ), acknowledgements AS (
      SELECT m.id AS message_id, m.conversation_id, MIN(NULLIF(d.accepted_at, 0)) AS accepted_at
      FROM source_messages m JOIN support_channel_deliveries d
        ON d.message_id = m.id AND d.workspace_id = m.workspace_id AND d.project_id = m.project_id
      JOIN support_channels ch ON ch.id = d.channel_id AND ch.workspace_id = m.workspace_id AND ch.project_id = m.project_id
      WHERE m.channel <> 'widget' AND m.author_type = 'agent' AND ch.provider = m.channel AND d.provider_message_id <> ''
      GROUP BY m.id, m.conversation_id
    ), incomplete AS (
      SELECT DISTINCT conversation_id FROM acknowledgements WHERE accepted_at IS NULL
    ), timeline AS (
      SELECT m.channel, m.id, m.conversation_id, m.author_type, COALESCE(a.accepted_at, m.stored_at) AS at_ms
      FROM source_messages m LEFT JOIN acknowledgements a ON a.message_id = m.id
      WHERE (m.delivery_status = 'stored' AND (m.author_type = 'customer' OR m.channel = 'widget'))
        OR a.accepted_at > 0
    ), ordered AS (
      SELECT *, MIN(CASE WHEN author_type = 'customer' THEN at_ms END) OVER (PARTITION BY conversation_id) AS started_at,
        LAG(author_type) OVER thread AS previous_author, LAG(at_ms) OVER thread AS previous_at
      FROM timeline WHERE at_ms <= ?
      WINDOW thread AS (PARTITION BY conversation_id ORDER BY at_ms, id)
    ), replies AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY at_ms, id) AS reply_number
      FROM ordered WHERE author_type = 'agent' AND previous_author = 'customer'
        AND conversation_id NOT IN (SELECT conversation_id FROM incomplete)
    ), samples AS (
      SELECT channel, 'firstReply' AS metric, at_ms - started_at AS duration_ms FROM replies WHERE reply_number = 1
      UNION ALL
      SELECT channel, 'followUpReply', at_ms - previous_at FROM replies WHERE reply_number > 1
      UNION ALL
      SELECT c.channel, 'resolution', c.resolved_at - MIN(o.started_at)
      FROM cohort c JOIN ordered o ON o.conversation_id = c.id AND o.author_type = 'customer'
      WHERE c.status = 'closed' AND c.resolved_at > 0 AND c.resolved_at <= ?
      GROUP BY c.channel, c.id, c.resolved_at HAVING c.resolved_at >= MIN(o.started_at)
    )
    SELECT channel, metric, COUNT(*) AS samples, AVG(duration_ms) AS average_ms FROM samples GROUP BY channel, metric
  `, [...scope, ...channels, since, through, ...scope, through, through])
  function duration(channel: string, metric: TimingMetric): ReportDuration {
    const row = rows.find(row => row.channel === channel && row.metric === metric)
    return row ? { samples: Number(row.samples), averageMs: Math.round(Number(row.average_ms)) } : { samples: 0, averageMs: null }
  }
  function timings(channel: string): ReportTimings {
    return { firstReply: duration(channel, 'firstReply'), followUpReply: duration(channel, 'followUpReply'), resolution: duration(channel, 'resolution') }
  }
  const channelTimings: ChannelReportTimings[] = channels.filter(channel => channel !== 'widget' && rows.some(row => row.channel === channel)).map(channel => ({ channel, ...timings(channel) }))
  return { messengerTimings: { since, through, ...timings('widget') }, channelTimings }
}

export async function projectReports(project: Row, through: number) {
  await ensureDatabaseConfigLoaded()
  const scope = [project.workspace_id, project.id]
  return {
    conversations: await query('SELECT status, COUNT(*) AS total FROM support_conversations WHERE workspace_id = ? AND project_id = ? GROUP BY status', scope),
    messages: await query('SELECT author_type, COUNT(*) AS total FROM support_messages WHERE workspace_id = ? AND project_id = ? GROUP BY author_type', scope),
    tickets: await query('SELECT status, COUNT(*) AS total FROM support_tickets WHERE workspace_id = ? AND project_id = ? GROUP BY status', scope),
    ...await responseTimings(scope, through),
  }
}
