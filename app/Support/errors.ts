export class SupportError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
export function fail(status: number, code: string, message: string): never { throw new SupportError(status, code, message) }
export function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(422, 'invalid_input', `${name} must be 1 to ${max} characters.`)
  return value.trim()
}
export function identifier(value: unknown): number {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) fail(422, 'invalid_identifier', 'A positive integer identifier is required.')
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) fail(422, 'invalid_identifier', 'A positive integer identifier is required.')
  return id
}
