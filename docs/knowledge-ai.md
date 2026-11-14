# Knowledge and text AI

Knowledge articles, immutable revisions, source permissions, index generations and chunks persist in the application SQL database. Public access requires both `published` status and `public` visibility, plus a permitted source that has not been removed. Agents need active workspace membership. Only owners and admins may create, import, edit, reindex, remove, or change source permissions. Edits require the current revision number. Imports accept supplied HTML or Markdown and store plain text; they do not fetch URLs, run scripts, or render imported markup.

## Durable retrieval

Article changes and index invalidation share the workspace database transaction. Publication immediately creates a complete persisted lexical generation. PostgreSQL uses native `to_tsvector` / `plainto_tsquery` full text and ranking. SQLite uses an explicitly limited substring fallback over up to twelve query terms. Neither fallback is an in-memory index.

PostgreSQL vector generations use the native `@stacksjs/ai/durable-retrieval` adapter and pgvector cosine distance. Embeddings are JSON text in model-defined SQL columns; the adapter casts only the already permitted rows to vector. The embedding-owning model declares `databaseExtensions: ['vector']`, so native migration generation writes the PostgreSQL extension prerequisite. The server pgvector extension package must exist before migration, and the migration role must be allowed to enable it. SQLite receives no PostgreSQL extension DDL.

`IndexSupportKnowledge` is a native queued scheduled job. It batches supplied source chunks through the configured OpenAI or Ollama embedding provider outside database transactions. A complete generation activates only if the source revision, content fingerprint, permission state and durable owner lease still match. An edit, withdrawal or permission revocation deletes stale chunks synchronously; a late worker cannot activate an obsolete generation or replace a successor. Removing an article archives its authoritative content and removes its searchable chunks. Revision history remains available to authorized agents under workspace retention policy.

Every retrieval intersects live workspace/project ownership, audience, language, publication, current revision, deletion and explicit source access before ranking. PostgreSQL materializes that permitted relation before any vector expression. This prevents malformed or private vectors outside the authorized source set from being evaluated. The adapter currently accepts at most 10,000 authorized sources per query. Vector ranking is exact cosine search, with an application maximum distance of 0.5, rather than an approximate nearest-neighbor index. Large-corpus performance and recall require separate qualification.

PostgreSQL uses vectors once a matching embedding-model generation is ready. Native full text remains available while a vector generation is pending or no embedding provider is configured. Capability metadata and each AI response name the actual retrieval mode: `pgvector`, `fulltext`, or `lexical`. The native memory-only `VectorIndex` is not used by this application.

## Grounded answers

AI uses `createAIClient(config.ai)` from native `@stacksjs/ai/client`; provider secrets stay on the server. The app's default OpenAI provider requires `OPENAI_API_KEY`. Missing chat configuration returns `503 ai_unavailable`. Provider failures return an explicit error and release their reservations. A query with no relevant evidence returns a human handoff without calling a chat model.

The prompt contains the question and at most four published source excerpts, bounded to approximately 4,000 UTF-8 bytes. It treats questions and sources as untrusted data and requests structured JSON citing supplied article ids. The server rejects unknown source ids, missing citations on answers, malformed output and invalid token accounting. Immediately before publishing, it rechecks the source's current article revision, visibility, permission state and removal state. This limits the evidence supplied to the model; it does not prove every generated statement follows semantically from an excerpt. An agent should review copilot suggestions.

Customer answers persist once as public messages with source links, and enqueue a durable delivery event in the same transaction as finalization. Copilot returns a suggestion without sending it. Public citations open `/help/article?project=...&slug=...&locale=...`; that page reads the scoped public help API.

## Separate allowances

Customer AI admits exactly ten handled conversation units per UTC month on the free plan. A customer conversation unit allows at most twenty reply turns and 20,000 tokens. Admission conservatively reserves prompt UTF-8 bytes, framing allowance and the provider's 1,024-output-token cap; finalization replaces that with reported provider usage. A request near the ceiling can be refused conservatively before calling the provider. Failures and human handoffs release the unit, turn and token reservation because no customer AI reply was delivered.

Copilot uses separate monthly request and token budgets from the canonical typed plan catalog:

| Plan | Requests | Tokens |
| --- | ---: | ---: |
| Free and trial | 100 | 100,000 |
| Starter | 1,000 | 1,000,000 |
| Growth | 5,000 | 5,000,000 |
| Enterprise | 25,000 | 25,000,000 |
| Self-hosted | No SaaS monthly cap | No SaaS monthly cap |

Every copilot request has a 20,000-token ceiling. Pending requests reserve one request and a conservative token budget. Success reconciles actual tokens; provider failures and handoffs release the reservation. Copilot never increments customer AI conversation, turn or token counters. Exhaustion returns `402 copilot_limit`, independently of the customer AI allowance.

Background indexing has its own `indexing_tokens` budget in the same typed catalog: 100,000 monthly input tokens on free/trial, 1,000,000 on Starter, 5,000,000 on Growth, 25,000,000 on Enterprise, and no SaaS monthly cap on self-hosted installations. A generation reserves conservative input bytes plus framing before embedding HTTP. Complete provider token usage replaces that reservation; missing usage retains the conservative amount. Failures, superseded attempts and expired leases release only their own reservation. Indexing never consumes customer conversation units or copilot budgets. `402 indexing_limit` is returned before calling the embedding provider. Capability metadata reports this budget separately.

Pending chat attempts have a durable 90-second owner lease and a 60-second provider timeout. Completed idempotent retries replay their persisted response, changed input is rejected, failed attempts may retry the same key, and active attempts return `409 ai_busy`. Expired attempts release their reservations on a later workspace AI request or through `recoverExpiredAiRuns`. No provider network call holds a database transaction.

## APIs and qualification

- Public help: `GET /api/help/projects/{project}/articles` and `GET /api/help/projects/{project}/articles/{slug}?locale=en`.
- Agent knowledge: `GET/POST /api/support/projects/{project}/knowledge`, `PATCH/DELETE /knowledge/{id}`, `GET /knowledge/{id}/revisions`, and `POST /knowledge/import`.
- Index status/build: `GET/POST /api/support/projects/{project}/knowledge/{id}/index`.
- Source permission: `PATCH /api/support/projects/{project}/knowledge/{id}/permissions` with `{ permissionGranted }`.
- Capability and separate allowance metadata: `GET /api/support/projects/{project}/ai/capabilities`.
- Customer AI: `POST /api/widget/projects/{project}/conversations/{id}/ai`.
- Agent copilot: `POST /api/support/projects/{project}/conversations/{id}/copilot`.

Both AI endpoints accept `{ question, idempotencyKey, locale? }` and return `{ answer, handoff, sources, retrievalMode, messageId? }`. Widget APIs require an unexpired project-scoped customer bearer token and an exact configured browser origin. Customer AI also verifies conversation ownership. Copilot uses native Stacks authentication and can retrieve permitted published internal sources.

Acceptance uses native generated migrations, real HTTP routes/actions, native registration/login, disposable SQLite/PostgreSQL databases, provider-shaped local embedding/chat HTTP servers, and a separate process restart. The PostgreSQL fixture needs a local server with pgvector, set through `STACKS_TEST_POSTGRES_URL`; tests create and drop only owned databases. Production credentials, live model quality, multilingual recall and large-corpus performance remain separate launch checks.
