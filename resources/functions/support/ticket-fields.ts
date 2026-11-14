export interface TicketField { key: string, label: string, type: 'string' | 'email' | 'number' | 'integer' | 'boolean' | 'date' | 'enum', required: boolean, visibility: 'customer' | 'internal', options?: string[], default?: unknown }
export interface TicketState { key: string, label: string, category: 'open' | 'pending' | 'resolved' }
export interface TicketForm { fields: TicketField[], states: TicketState[] }
export interface TicketType { id: string | number, name: string, kind: string, sla_policy_id: string | number, fields: TicketField[], states: TicketState[] }
export const ticketStates: TicketState[] = [{ key: 'open', label: 'Open', category: 'open' }, { key: 'pending', label: 'Pending', category: 'pending' }, { key: 'resolved', label: 'Resolved', category: 'resolved' }]
export function stored<T>(value: unknown, fallback: T): T { try { return typeof value === 'string' ? JSON.parse(value) as T : value && typeof value === 'object' ? value as T : fallback } catch { return fallback } }
export function normalizeType(row: TicketType): TicketType { return { ...row, fields: stored(row.fields, []), states: stored(row.states, ticketStates) } }
export function fieldText(value: unknown) { return value === undefined || value === null ? '' : String(value) }
export function fieldInputs(fields: TicketField[], values: Record<string, unknown> = {}) { return Object.fromEntries(fields.map(field => [field.key, fieldText(values[field.key] === undefined ? field.default : values[field.key])])) }
export function typedFields(fields: TicketField[], values: Record<string, string>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = values[field.key] ?? ''
    if (raw === '') { if (field.required) throw new Error(`${field.label} is required.`); output[field.key] = null; continue }
    if (field.type === 'number' || field.type === 'integer') {
      const value = Number(raw)
      if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) throw new Error(`${field.label} needs a valid ${field.type}.`)
      output[field.key] = value
    }
    else if (field.type === 'boolean') { if (!['true', 'false'].includes(raw)) throw new Error(`${field.label} needs a yes or no answer.`); output[field.key] = raw === 'true' }
    else output[field.key] = raw
  }
  return output
}
export function inputType(field: TicketField) { return ['integer', 'number'].includes(field.type) ? 'number' : ['email', 'date'].includes(field.type) ? field.type : 'text' }
