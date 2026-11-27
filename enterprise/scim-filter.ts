// SPDX-License-Identifier: LicenseRef-HQ-Support-Enterprise
import { fail } from '../app/Support/errors'

const columns = {
  Users: new Map([['username', 'm.email'], ['externalid', 'i.external_id']]),
  Groups: new Map([['displayname', 'display_name'], ['externalid', 'external_id']]),
}

export function scimEqualityFilter(resource: keyof typeof columns, filters: string[]) {
  const [filter, repeated] = filters
  if (filter === undefined)
    return null

  const allowed = resource === 'Users' ? 'userName or externalId' : 'displayName or externalId'
  const message = `Use one eq filter on ${allowed} with a quoted JSON string.`
  if (repeated !== undefined)
    fail(400, 'invalidFilter', message)
  const match = /^([a-z]+)[ \t]+eq[ \t]+(".*")$/is.exec(filter.trim())
  if (!match)
    fail(400, 'invalidFilter', message)

  const field = match[1]!.toLowerCase()
  const column = columns[resource].get(field)
  if (!column)
    fail(400, 'invalidFilter', message)

  let value: string
  try {
    value = JSON.parse(match[2]!)
  }
  catch {
    fail(400, 'invalidFilter', message)
  }
  if (value.includes('\0') || !value.isWellFormed())
    fail(400, 'invalidFilter', 'Use a valid Unicode filter value without null characters.')

  return { column, value: field === 'username' ? value.toLowerCase() : value }
}
