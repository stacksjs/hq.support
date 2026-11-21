import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const requiredQualifications = [
  'workspace-isolation', 'web-inbox', 'customer-messenger', 'web-components',
  'email', 'tickets-sla', 'knowledge', 'text-ai', 'workflows', 'proactive',
  'sms', 'whatsapp', 'facebook', 'instagram', 'slack', 'discord',
  'us-canada-phone', 'voice-ai', 'enterprise-identity', 'reporting',
  'billing-wallet', 'stacks-free-verification', 'buddy-integration',
  'intercom-migration', 'postgres', 'redis-workers', 'load', 'backup-restore', 'rollback',
] as const

export function qualificationErrors(value: unknown, commit: string): string[] {
  if (!value || typeof value !== 'object') return ['Qualification report is missing.']
  const report = value as Record<string, unknown>
  if (!/^[a-f0-9]{40}$/.test(commit) || report.commit !== commit) return ['Qualification must match the exact deployed commit.']
  if (!Array.isArray(report.checks)) return ['Qualification checks are missing.']
  const checks = report.checks as Array<Record<string, unknown>>
  return requiredQualifications.flatMap((id) => {
    const matches = checks.filter(check => check?.id === id)
    if (matches.length !== 1) return [`${id}: require exactly one result.`]
    const check = matches[0]!
    if (check.status !== 'passed' || typeof check.evidence !== 'string' || !check.evidence.trim()) return [`${id}: successful evidence is required.`]
    if (typeof check.completedAt !== 'string' || !Number.isFinite(Date.parse(check.completedAt)) || Date.parse(check.completedAt) > Date.now()) return [`${id}: a valid completion time is required.`]
    return []
  })
}

if (import.meta.main) {
  try {
    const commit = process.env.GITHUB_SHA || (await Bun.$`git rev-parse HEAD`.text()).trim()
    const report = JSON.parse(process.env.SUPPORT_LAUNCH_QUALIFICATION || await readFile(resolve(import.meta.dir, '../deployment/qualification.json'), 'utf8'))
    const errors = qualificationErrors(report, commit)
    if (errors.length) throw new Error(errors.join('\n'))
    console.info('The complete launch qualification matches this release.')
  }
  catch (error) {
    console.error('HQ.support is not qualified for broad public launch.')
    console.error(error instanceof Error ? error.message : 'Invalid qualification report.')
    process.exitCode = 1
  }
}
