import { resolvedDatabaseConfig } from '@stacksjs/database/runtime'
import { fail } from './errors'

/** Only the authenticated agent inbox opts in; callers bind every returned value. */
export function conversationSearch(value: unknown) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length < 2 || value.length > 200) fail(422, 'invalid_search', 'Search must contain 2 to 200 characters.')
  const query = value.trim()
  const postgres = resolvedDatabaseConfig().driver === 'postgres'
  const matches = (column: string) => postgres
    ? `to_tsvector('simple', ${column}) @@ plainto_tsquery('simple', ?)`
    : `instr(lower(${column}), lower(?)) > 0`
  // The correlated subquery cannot turn a malformed message's tenant IDs into a grant.
  const predicate = `(${matches('support_conversations.subject')} OR EXISTS (SELECT 1 FROM support_messages search_message WHERE search_message.workspace_id = support_conversations.workspace_id AND search_message.project_id = support_conversations.project_id AND search_message.conversation_id = support_conversations.id AND ${matches('search_message.body')}))`
  return { predicate, values: [query, query], mode: postgres ? 'fulltext' : 'lexical' }
}
