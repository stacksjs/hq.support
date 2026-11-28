import { fail } from './errors'

export const intercomBundleLimits = {
  bytes: 10_000_000,
  records: 5000,
  attachmentFiles: 100,
  maximumConversationParts: 500,
  maximumPaginatedParts: 5000,
} as const

export function intercomNextPage(value: unknown): number | null {
  if (value === null) return null
  if (Number.isSafeInteger(value) && Number(value) > 0) return Number(value)
  if (value && typeof value === 'object' && 'page' in value && Number.isSafeInteger(value.page) && Number(value.page) > 0)
    return Number(value.page)
  const cursor = typeof value === 'string' ? URL.parse(value) : null
  if (cursor) {
    const partFilters = ['include_part_types', 'exclude_part_types', 'parts_created_after', 'parts_created_before']
    if (partFilters.some(name => cursor.searchParams.has(name)))
      fail(422, 'incomplete_source_history', 'A source page cursor filters conversation parts. Retrieve every unfiltered page.')
    const pages = cursor.searchParams.getAll('page')
    const page = Number(pages[0])
    if (pages.length === 1 && Number.isSafeInteger(page) && page > 0) return page
  }
  fail(422, 'incomplete_source_history', 'Conversation page continuation must identify the next numbered page.')
}
