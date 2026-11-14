import { state } from '@stacksjs/stx'
import { createSupportConsole } from './console'
import { normalizeType, stored, ticketStates, typedFields } from './ticket-fields'
import type { TicketField, TicketState, TicketType } from './ticket-fields'

interface Window { weekdays: number[], start: string, end: string }
interface Calendar { id: string | number, name: string, time_zone: string, definition: { timeZone: string, windows: Window[], holidays: string[] } }
interface Policy { id: string | number, name: string, calendar_id: string | number, first_response_minutes: number, resolution_minutes: number, pause_states: string[], escalation_assignee_id: string | number }
export function createTicketConfiguration() {
  const workspace = createSupportConsole()
  const tab = state('types')
  const types = state<TicketType[]>([]), calendars = state<Calendar[]>([]), policies = state<Policy[]>([])
  const agents = state<{ id: string, name: string, role: string }[]>([])
  const name = state(''), kind = state('customer'), policyId = state('')
  const fields = state<TicketField[]>([]), states = state<TicketState[]>([])
  const editingField = state(false), fieldIndex = state(-1), fieldKey = state(''), fieldLabel = state(''), fieldType = state('string'), fieldVisibility = state('customer'), fieldRequired = state(false), fieldOptions = state(''), defaultEnabled = state(false), defaultValue = state('')
  const editingState = state(false), stateIndex = state(-1), stateKey = state(''), stateLabel = state(''), stateCategory = state('open')
  const calendarName = state(''), timeZone = state('UTC'), holidays = state('')
  const windows = state<Window[]>([{ weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }])
  const editingWindow = state(false), weekdays = state<number[]>([1, 2, 3, 4, 5]), start = state('09:00'), end = state('17:00')
  const policyName = state(''), calendarId = state(''), firstMinutes = state('60'), resolutionMinutes = state('480'), pauseStates = state('pending'), escalationAssignee = state('')
  const days = [{ key: 0, name: 'Sun' }, { key: 1, name: 'Mon' }, { key: 2, name: 'Tue' }, { key: 3, name: 'Wed' }, { key: 4, name: 'Thu' }, { key: 5, name: 'Fri' }, { key: 6, name: 'Sat' }]
  let selectedProject = ''
  async function load() {
    if (!workspace.project()) return
    if (selectedProject && selectedProject !== workspace.project()) { fields.set([]); states.set([]); name.set(''); kind.set('customer'); policyId.set(''); editingField.set(false); editingState.set(false); editingWindow.set(false); calendarId.set(''); escalationAssignee.set('') }
    selectedProject = workspace.project()
    const current = selectedProject
    const result = await workspace.run(async () => {
      const results = await Promise.allSettled([workspace.request(workspace.projectPath('/ticket-configuration')), workspace.request(workspace.projectPath('/agents'))])
      const configuration = results[0]
      if (!configuration || configuration.status === 'rejected') throw configuration?.reason || new Error('Ticket configuration could not be loaded.')
      return { ...configuration.value, agents: results[1]?.status === 'fulfilled' ? results[1].value.agents : [] }
    })
    if (!result || current !== workspace.project()) return
    types.set((result.types || []).map(normalizeType))
    calendars.set((result.calendars || []).map((row: Calendar) => ({ ...row, definition: stored(row.definition, { timeZone: row.time_zone, windows: [], holidays: [] }) })))
    policies.set((result.policies || []).map((row: Policy) => ({ ...row, pause_states: stored(row.pause_states, []) })))
    agents.set(result.agents || [])
  }
  async function boot() { await workspace.boot(); await load() }
  function fail(message: string) { workspace.notice.set(''); workspace.error.set(message) }
  async function create(path: string, input: unknown, message: string) {
    if (!workspace.canManage() || workspace.pending()) return false
    workspace.notice.set('')
    const result = await workspace.run(() => workspace.request(workspace.projectPath(path), { method: 'POST', body: JSON.stringify(input) }), workspace.pending)
    if (!result) return false
    await load()
    workspace.notice.set(message)
    return true
  }
  function editField(index = -1) {
    const field = fields()[index]
    fieldIndex.set(index); fieldKey.set(field?.key || ''); fieldLabel.set(field?.label || ''); fieldType.set(field?.type || 'string'); fieldVisibility.set(field?.visibility || 'customer'); fieldRequired.set(field?.required || false); fieldOptions.set(field?.options?.join('\n') || ''); defaultEnabled.set(field?.default !== undefined); defaultValue.set(field?.default === undefined ? '' : String(field.default)); editingField.set(true)
  }
  function applyField() {
    const key = fieldKey().trim(), label = fieldLabel().trim()
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(key) || !label) { fail('Use a field label and a key starting with a lowercase letter, followed by lowercase letters, numbers or underscores.'); return }
    if (fields().some((field, index) => field.key === key && index !== fieldIndex())) { fail('Field keys must be unique within this type.'); return }
    const field: TicketField = { key, label, type: fieldType() as TicketField['type'], visibility: fieldVisibility() as TicketField['visibility'], required: fieldRequired() }
    if (field.type === 'enum') field.options = fieldOptions().split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    if (defaultEnabled()) {
      try { field.default = defaultValue() === '' && field.type === 'string' ? '' : typedFields([{ ...field, required: true }], { [key]: defaultValue() })[key] }
      catch (error) { fail(error instanceof Error ? error.message : 'Default value does not match the field type.'); return }
    }
    if (field.type === 'enum' && (!field.options?.length || (field.default !== undefined && !field.options.includes(String(field.default))))) { fail('Add explicit enum options. A default must be one of those options.'); return }
    if (kind() === 'customer' && field.visibility === 'internal' && field.required && field.default === undefined) { fail('A required internal field on a customer form needs a typed default.'); return }
    fields.set(fieldIndex() < 0 ? [...fields(), field] : fields().map((row, index) => index === fieldIndex() ? field : row)); editingField.set(false); workspace.error.set('')
  }
  function removeField(index: number) { fields.set(fields().filter((field, position) => position !== index)); editingField.set(false) }
  function editState(index = -1) { const value = states()[index]; stateIndex.set(index); stateKey.set(value?.key || ''); stateLabel.set(value?.label || ''); stateCategory.set(value?.category || 'open'); editingState.set(true) }
  function applyState() {
    const key = stateKey().trim(), label = stateLabel().trim()
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(key) || !label || ticketStates.some(value => value.key === key) || states().some((value, index) => value.key === key && index !== stateIndex())) { fail('Use a unique additional state key and label. Built-in open, pending and resolved states cannot be replaced.'); return }
    const value: TicketState = { key, label, category: stateCategory() as TicketState['category'] }
    states.set(stateIndex() < 0 ? [...states(), value] : states().map((row, index) => index === stateIndex() ? value : row)); editingState.set(false); workspace.error.set('')
  }
  function removeState(index: number) { states.set(states().filter((value, position) => position !== index)); editingState.set(false) }
  async function createType() {
    if (editingField() || editingState()) { fail('Apply or cancel the field and state editors before creating this type.'); return }
    if (await create('/ticket-types', { name: name(), kind: kind(), slaPolicyId: policyId() || undefined, fields: fields(), states: states() }, 'Ticket type created. New tickets use this definition; existing snapshots are preserved.')) name.set('')
  }
  function copyType(type: TicketType) { name.set(`${type.name} copy`); kind.set(type.kind); policyId.set(Number(type.sla_policy_id) ? String(type.sla_policy_id) : ''); fields.set(structuredClone(type.fields)); states.set(structuredClone(type.states.filter(value => !ticketStates.some(builtin => builtin.key === value.key)))); editingField.set(false); editingState.set(false); tab.set('types') }
  function toggleDay(day: number) { weekdays.set(weekdays().includes(day) ? weekdays().filter(value => value !== day) : [...weekdays(), day].sort()) }
  function applyWindow() { if (!weekdays().length || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start()) || !/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(end()) || start() >= end()) { fail('Choose weekdays and an end time after the start. Split overnight hours into separate windows.'); return }; windows.set([...windows(), { weekdays: [...weekdays()], start: start(), end: end() }]); editingWindow.set(false); workspace.error.set('') }
  function removeWindow(index: number) { windows.set(windows().filter((value, position) => position !== index)) }
  async function createCalendar() { if (editingWindow()) { fail('Apply or cancel the current hours window first.'); return }; if (await create('/ticket-calendars', { name: calendarName(), timeZone: timeZone(), windows: windows(), holidays: holidays().split(/\r?\n/).map(value => value.trim()).filter(Boolean) }, 'Business calendar created. Existing SLA clock snapshots are unchanged.')) calendarName.set('') }
  function copyCalendar(calendar: Calendar) { calendarName.set(`${calendar.name} copy`); timeZone.set(calendar.definition.timeZone); windows.set(structuredClone(calendar.definition.windows)); holidays.set(calendar.definition.holidays.join('\n')); editingWindow.set(false); tab.set('calendars') }
  async function createPolicy() { if (await create('/ticket-sla-policies', { name: policyName(), calendarId: calendarId() || undefined, firstResponseMinutes: Number(firstMinutes()), resolutionMinutes: Number(resolutionMinutes()), pauseStates: pauseStates().split(',').map(value => value.trim()).filter(Boolean), escalationAssigneeId: escalationAssignee() || undefined }, 'SLA policy created. Attach it to a new ticket type to use it.')) policyName.set('') }
  function copyPolicy(policy: Policy) { policyName.set(`${policy.name} copy`); calendarId.set(Number(policy.calendar_id) ? String(policy.calendar_id) : ''); firstMinutes.set(String(policy.first_response_minutes)); resolutionMinutes.set(String(policy.resolution_minutes)); pauseStates.set(policy.pause_states.join(', ')); escalationAssignee.set(Number(policy.escalation_assignee_id) ? String(policy.escalation_assignee_id) : ''); tab.set('policies') }
  function calendarLabel(id: string | number) { return calendars().find(value => String(value.id) === String(id))?.name || 'Always open' }
  function policyLabel(id: string | number) { return policies().find(value => String(value.id) === String(id))?.name || 'No SLA policy' }
  function stateLabels(type: TicketType) { return type.states.map(item => item.label).join(', ') }
  function windowLabel(window: Window) { return `${window.weekdays.map(day => days.find(value => value.key === day)?.name).join(', ')} ${window.start}–${window.end}` }
  return { workspace, tab, types, calendars, policies, agents, name, kind, policyId, fields, states, editingField, fieldKey, fieldLabel, fieldType, fieldVisibility, fieldRequired, fieldOptions, defaultEnabled, defaultValue, editField, applyField, removeField, editingState, stateKey, stateLabel, stateCategory, editState, applyState, removeState, createType, copyType, calendarName, timeZone, holidays, windows, editingWindow, weekdays, start, end, days, toggleDay, applyWindow, removeWindow, createCalendar, copyCalendar, policyName, calendarId, firstMinutes, resolutionMinutes, pauseStates, escalationAssignee, createPolicy, copyPolicy, calendarLabel, policyLabel, stateLabels, windowLabel, boot, load }
}
