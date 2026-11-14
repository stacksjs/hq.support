import { isCalendarDate } from '@stacksjs/datetime'
import { schema } from '@stacksjs/validation/runtime'
import { validateRule } from '@stacksjs/validation/messages'
import type { Row } from './database'
import { fail, text } from './errors'
import { object } from './service'

export interface TicketField { key: string, label: string, type: string, required: boolean, visibility: 'customer' | 'internal', options?: string[], default?: unknown }
export interface TicketState { key: string, label: string, category: 'open' | 'pending' | 'resolved' }
export interface TicketForm { fields: TicketField[], states: TicketState[] }
const builtins: TicketState[] = [{ key: 'open', label: 'Open', category: 'open' }, { key: 'pending', label: 'Pending', category: 'pending' }, { key: 'resolved', label: 'Resolved', category: 'resolved' }]
function validField(field: TicketField, value: unknown): boolean {
  if (field.type === 'date') return isCalendarDate(value)
  const rule = field.type === 'integer' ? schema.number().integer() : field.type === 'number' ? schema.number() : field.type === 'boolean' ? schema.boolean() : field.type === 'email' ? schema.string().email() : field.type === 'enum' ? schema.enum(field.options!) : schema.string().max(4000)
  return validateRule(rule, value).valid
}
export function parseTicketForm(input: Row, kind: string): TicketForm {
  const definitions = input.fields ?? [], states = input.states ?? []
  if (!Array.isArray(definitions) || definitions.length > 40 || !Array.isArray(states) || states.length > 30) fail(422, 'invalid_form', 'Supply at most 40 fields and 30 additional states.')
  const seen = new Set<string>()
  const fields = definitions.map(raw => {
    const value = object(raw), key = String(value.key || ''), type = String(value.type || ''), visibility = value.visibility === 'internal' ? 'internal' : 'customer'
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(key) || seen.has(key) || !['string', 'email', 'number', 'integer', 'boolean', 'date', 'enum'].includes(type)) fail(422, 'invalid_form', 'Field keys must be unique and use a supported type.')
    seen.add(key)
    const field: TicketField = { key, label: text(value.label, 'label', 100), type, required: value.required === true, visibility }
    if (type === 'enum') {
      if (!Array.isArray(value.options) || !value.options.length || value.options.length > 50 || value.options.some(option => typeof option !== 'string' || !option.length || option.length > 100)) fail(422, 'invalid_form', 'Enum fields need 1 to 50 text options.')
      field.options = [...new Set(value.options as string[])]
    }
    if (value.default !== undefined) { if (!validField(field, value.default)) fail(422, 'invalid_form', 'Field default must match its type.'); field.default = value.default }
    if (kind === 'customer' && visibility === 'internal' && field.required && field.default === undefined) fail(422, 'invalid_form', 'Required internal fields on customer forms need a default.')
    return field
  })
  const keys = new Set(builtins.map(state => state.key))
  const additional = states.map(raw => {
    const value = object(raw), key = String(value.key || ''), category = String(value.category || '')
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(key) || keys.has(key) || !['open', 'pending', 'resolved'].includes(category)) fail(422, 'invalid_form', 'State keys must be unique and use an open, pending or resolved category.')
    keys.add(key)
    return { key, label: text(value.label, 'label', 100), category } as TicketState
  })
  return { fields, states: [...builtins, ...additional] }
}
export function customFieldValues(form: TicketForm, input: unknown, customer = false, previous: Row = {}): Row {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) fail(422, 'invalid_fields', 'customFields must be an object.')
  const values = object(input), result: Row = { ...previous }, known = new Map(form.fields.map(field => [field.key, field]))
  for (const [key, value] of Object.entries(values)) {
    const field = known.get(key)
    if (!field || (customer && field.visibility === 'internal')) fail(422, 'invalid_fields', `Field ${key} is not available on this form.`)
    result[key] = value
  }
  for (const field of form.fields) {
    if (result[field.key] === undefined && field.default !== undefined) result[field.key] = field.default
    const value = result[field.key]
    if ((value === undefined || value === null || value === '') && !field.required) { delete result[field.key]; continue }
    if (value === undefined || value === null || value === '' || !validField(field, value)) fail(422, 'invalid_fields', `Field ${field.key} must contain a valid ${field.type}.`)
  }
  return result
}
export function storedJson<T>(value: unknown, fallback: T): T { try { return typeof value === 'string' ? JSON.parse(value) as T : fallback } catch { return fallback } }
export function ticketForm(row: Row): TicketForm {
  const form = storedJson<Partial<TicketForm>>(row.type_snapshot, {})
  return { fields: Array.isArray(form.fields) ? form.fields : [], states: Array.isArray(form.states) && form.states.length ? form.states : builtins }
}
export function publicForm(form: TicketForm): TicketForm { return { fields: form.fields.filter(field => field.visibility !== 'internal'), states: form.states } }
