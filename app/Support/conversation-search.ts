import { resolvedDatabaseConfig } from '@stacksjs/database/runtime'
import { fail, identifier } from './errors'

/** Only the authenticated agent inbox opts in; callers bind every returned value. */
export function conversationSearch(value: unknown) {
  if (value === undefined) return undefined
  const query = typeof value === 'string' ? value.trim() : ''
  const numeric = /^\d+$/.test(query) ? Number(query) : 0
  const includeId = numeric > 0 && Number.isSafeInteger(numeric)
  if (typeof value !== 'string' || value.length > 200 || (query.length < 2 && !includeId)) fail(422, 'invalid_search', 'Text search must contain 2 to 200 characters.')

  const idPredicate = 'support_conversations.id = ?'
  const exact = /^#(\d+)$/.exec(query)
  if (exact)
    return { predicate: idPredicate, values: [identifier(exact[1])], mode: 'id' }

  const postgres = resolvedDatabaseConfig().driver === 'postgres'
  const matches = (column: string) => postgres
    ? `to_tsvector('simple', ${column}) @@ plainto_tsquery('simple', ?)`
    : `instr(lower(${column}), lower(?)) > 0`
  // The correlated subquery cannot turn a malformed message's tenant IDs into a grant.
  const messageMatches = `EXISTS (
    SELECT 1 FROM support_messages search_message
    WHERE search_message.workspace_id = support_conversations.workspace_id
      AND search_message.project_id = support_conversations.project_id
      AND search_message.conversation_id = support_conversations.id
      AND ${matches('search_message.body')}
  )`
  const predicates = [...(includeId ? [idPredicate] : []), matches('support_conversations.subject'), messageMatches]
  return {
    predicate: `(${predicates.join(' OR ')})`,
    values: [...(includeId ? [numeric] : []), query, query],
    mode: postgres ? 'fulltext' : 'lexical',
  }
}
