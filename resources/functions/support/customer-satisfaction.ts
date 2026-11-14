import { derived, state } from '@stacksjs/stx'
import { createSupportConsole } from './console'

interface CsatSettings { enabled: boolean, question: string, revision: number }
interface CsatReport { period: string, responses: number, averageScore: number | null, satisfiedPercent: number | null, distribution: { score: number, count: number }[] }
export function createCustomerSatisfaction() {
  const workspace = createSupportConsole()
  const settings = state<CsatSettings | null>(null), base = state<CsatSettings | null>(null), report = state<CsatReport | null>(null)
  const enabled = state(false), question = state(''), period = state(new Date().toISOString().slice(0, 7))
  const settingsError = state(''), reportError = state('')
  const dirty = derived(() => !!base() && (enabled() !== base()!.enabled || question() !== base()!.question))
  const conflict = derived(() => !!base() && !!settings() && base()!.revision !== settings()!.revision)
  let selectedProject = '', generation = 0, disposed = false
  function adoptSettings(keepDraft = false) {
    const current = settings()
    if (!current || !workspace.canManage()) return
    base.set({ ...current })
    if (!keepDraft) { enabled.set(current.enabled); question.set(current.question) }
    settingsError.set(''); workspace.notice.set(keepDraft ? 'Your draft now uses the current saved revision. Review it before saving.' : 'Current saved settings loaded into the editor.')
  }
  async function load() {
    if (!workspace.project() || workspace.pending()) return
    const version = ++generation, project = workspace.project(), month = period()
    if (selectedProject !== project) { selectedProject = project; settings.set(null); base.set(null); report.set(null); enabled.set(false); question.set(''); settingsError.set(''); reportError.set('') }
    const validPeriod = /^[12]\d{3}-(0[1-9]|1[0-2])$/.test(month)
    workspace.loading.set(true); reportError.set(validPeriod ? '' : 'Choose a UTC reporting month between 1000-01 and 2999-12.'); settingsError.set('')
    const results = await Promise.allSettled([validPeriod ? workspace.request(workspace.projectPath('/csat-report?period=' + encodeURIComponent(month))) : Promise.resolve(undefined), workspace.canManage() ? workspace.request(workspace.projectPath('/csat-settings')) : Promise.resolve(undefined)])
    if (disposed || version !== generation || project !== workspace.project()) return
    const summary = results[0], configuration = results[1]
    if (summary?.status === 'fulfilled' && summary.value) report.set(summary.value)
    else if (summary?.status === 'rejected') reportError.set(summary?.reason instanceof Error ? summary.reason.message : 'Satisfaction totals could not be loaded.')
    if (configuration?.status === 'fulfilled' && configuration.value) {
      const latest = configuration.value.settings as CsatSettings
      settings.set(latest)
      if (!base() || !dirty()) { base.set({ ...latest }); enabled.set(latest.enabled); question.set(latest.question) }
    }
    else if (configuration?.status === 'rejected') settingsError.set(configuration.reason instanceof Error ? configuration.reason.message : 'Survey settings could not be loaded.')
    if (!workspace.canManage()) { settings.set(null); base.set(null); enabled.set(false); question.set('') }
    workspace.loading.set(false)
  }
  async function boot() { await workspace.boot(); if (workspace.ready()) await load() }
  async function save() {
    if (!workspace.ready() || !workspace.canManage() || workspace.pending() || !base() || conflict()) return
    if (!question().trim() || question().length > 160) { settingsError.set('The question must contain 1 to 160 characters.'); return }
    const version = generation, project = workspace.project()
    workspace.pending.set(true); settingsError.set(''); workspace.notice.set('')
    try {
      const result = await workspace.request(workspace.projectPath('/csat-settings'), { method: 'PATCH', body: JSON.stringify({ enabled: enabled(), question: question(), expectedRevision: base()!.revision }) })
      if (disposed || version !== generation || project !== workspace.project()) return
      if (!result.settings || !Number.isSafeInteger(result.settings.revision)) throw new Error('Settings could not be confirmed. Your draft is unchanged.')
      const latest = result.settings as CsatSettings
      settings.set(latest); base.set({ ...latest }); enabled.set(latest.enabled); question.set(latest.question); workspace.notice.set('Satisfaction settings saved for this project.')
    }
    catch (failure) {
      if (disposed || version !== generation || project !== workspace.project()) return
      settingsError.set(failure instanceof Error ? failure.message : 'Settings could not be confirmed. Your draft is unchanged.')
      try { const current = await workspace.request(workspace.projectPath('/csat-settings')); if (!disposed && version === generation && project === workspace.project()) settings.set(current.settings) }
      catch { /* The original failure stays visible and the draft/revision remain intact. */ }
    }
    finally { if (!disposed && version === generation) workspace.pending.set(false) }
  }
  function average() { return report()?.averageScore === null || !report() ? '—' : Number(report()!.averageScore).toFixed(2) }
  function percent() { return report()?.satisfiedPercent === null || !report() ? '—' : `${Number(report()!.satisfiedPercent).toLocaleString()}%` }
  function destroy() { disposed = true; generation++; settings.set(null); base.set(null); report.set(null); enabled.set(false); question.set(''); workspace.destroy() }
  return { workspace, settings, base, report, enabled, question, period, settingsError, reportError, dirty, conflict, adoptSettings, load, boot, save, average, percent, destroy }
}
