import type { ChannelReportTimings, ReportTimings, SlaReportTimings } from '../../../app/Support/reports'
import { state } from '@stacksjs/stx'
import { createSupportConsole } from './console'

type Aggregate = { status?: string, author_type?: string, total: number | string }
interface ProjectReport {
  conversations: Aggregate[]
  messages: Aggregate[]
  tickets: Aggregate[]
  messengerTimings: ReportTimings
  channelTimings?: ChannelReportTimings[]
  slaTimings?: SlaReportTimings
}

const channelLabels: Record<string, string> = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp', messenger: 'Facebook Messenger', instagram: 'Instagram', slack: 'Slack', discord: 'Discord' }

export function createReports() {
  const workspace = createSupportConsole()
  const report = state<ProjectReport | null>(null)
  async function load() {
    report.set(null)
    if (!workspace.project()) return
    const result = await workspace.run(() => workspace.request(workspace.projectPath('/reports')))
    if (result) report.set(result)
  }
  async function boot() { await workspace.boot(); await load() }
  function total(rows?: Aggregate[]) { return (rows || []).reduce((sum, row) => sum + Number(row.total), 0).toLocaleString() }
  function duration(ms: number | null) {
    if (ms === null) return 'No data'
    if (ms < 1_000) return new Intl.NumberFormat(undefined, { style: 'unit', unit: 'millisecond' }).format(ms)
    const [unit, scale] = ms < 60_000 ? ['second', 1_000] as const : ms < 3_600_000 ? ['minute', 60_000] as const : ['hour', 3_600_000] as const
    return new Intl.NumberFormat(undefined, { style: 'unit', unit, maximumFractionDigits: 1 }).format(ms / scale)
  }
  function timings() {
    const value = report()?.messengerTimings
    if (!value) return []
    return [
      { label: 'First human reply', detail: 'From the first customer message to the first public reply by an agent.', ...value.firstReply },
      { label: 'Follow-up reply', detail: 'From the latest customer message to the next public reply by an agent.', ...value.followUpReply },
      { label: 'Time to resolution', detail: 'From the first customer message to the latest close of a closed conversation.', ...value.resolution },
    ]
  }
  function channels() {
    return (report()?.channelTimings || []).map(row => ({ ...row, label: channelLabels[row.channel] ?? row.channel }))
  }
  function slaTimings() {
    const value = report()?.slaTimings
    return value ? [
      { label: 'SLA first response', ...value.firstResponse },
      { label: 'SLA resolution', ...value.resolution },
    ] : []
  }
  return { workspace, report, load, boot, total, duration, timings, channels, slaTimings }
}
