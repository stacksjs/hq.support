# Conversation search

Authenticated workspace agents can pass `q` to `GET /api/support/projects/{project}/inbox`. Text queries contain 2 to 200 characters and search the persisted subject and message bodies, including internal notes available to the agent. A positive integer also matches its conversation ID. Prefix the number with `#` for an exact ID lookup. Encode that prefix as `%23` in an API URL. Results use the ordinary conversation summary and compose with `status`, `inboxId`, `limit` (1 to 100), and the returned `cursor`. Ordering remains descending conversation ID. Incoming conversations do not shift an existing keyset page. The inbox route permits 120 requests per minute under native rate limiting.

Authorization resolves current native membership on every request. The outer conversation, matching messages and unread projections bind workspace and project together. Sibling projects are separate search scopes, even for the same owner. Anonymous visitors, customer sessions and server summary read keys cannot use transcript search. Client-supplied workspace, author or visibility values do not widen the search. Repeated query parameters, oversized input and malformed cursors are refused. All query values travel as SQL parameters.

PostgreSQL uses its native `simple` full-text parser and `plainto_tsquery` against subjects and bodies. SQLite uses case-insensitive literal substring matching. The response's `search.mode` is `fulltext` or `lexical`, respectively, and `id` for an explicit conversation ID lookup. Search invokes no AI provider and consumes no hosted AI allowance.

The retained HTTP test runs against disposable SQLite and PostgreSQL databases. It covers historical body matches, private notes, summary-only output, same-workspace sibling and cross-workspace isolation, removed membership, malformed input, SQL punctuation, pagination during incoming traffic, and status/inbox composition. A deliberately inconsistent message tenant ID cannot create a match. The existing core and SDK suites cover the unchanged unsearched list contract.

Production search load and index qualification remain launch gates. This slice evaluates native text predicates over the tenant-scoped persisted records; it does not claim a precomputed full-text index or measured large-history latency. The agent inbox now sends bounded server search requests and preserves message-body matches instead of filtering only loaded subjects.

## Inbox search interface

The inbox searches its selected project after 300 ms without another edit.
Paste the ID as shown in the inbox, such as `#123`, to open a result for that
conversation. A positive number also works in ordinary search. A
one-character text query or oversized input shows validation and sends no
list request. Empty or whitespace-only input omits `q` and restores the list
with the current status and team-inbox filters. The help text describes the
server's current search mode.

Every edit invalidates the old list generation immediately, before debounce.
The controller aborts its prior list request and clears its cursor. Responses
can update or append a page only while their project and generation remain
current. Load-more requests carry the same query, status and inbox with the
server cursor; a newer incoming conversation cannot shift that continuation.
Refresh starts again from the newest matching page. Project changes cancel the
pending query and clear the prior project's query, inbox and cursor scope.

The selected conversation and its in-memory reply/private-note draft stay
available during search, empty results, validation errors and pagination.
Changing projects retains drafts under their original project/conversation
identity. Native authentication failure clears private results, selected
messages, drafts and routing metadata. Component destruction cancels the native
debounce and active list request and clears private state. Drafts and queries
are not written to browser storage.

The native SSG/Chromium qualifier (`scripts/qualify-team-browser.ts`) now includes
real authenticated search against the generated SQLite schema. It creates a
body-only historical target beyond the default 50-row page, composes query,
status and inbox filters, continues a 55-result page while a newer match arrives,
and verifies empty/short/long inputs. Transport-boundary delays retain actual
native API responses to exercise stale edits before debounce and project
switches. A real native logout proves private-state cleanup; no browser
identity globals or response-record replacements are used. The qualification
also retains the team drawer, narrow-screen and draft cases.

The installed 0.75.581 packages with stx 0.2.872 pass all 46 functional browser
checks. The strict zero-runtime-error assertion remains enabled and fails on
the known classic-script `import.meta` compiler error. This is not a passed
release qualification; rerun with the published native compiler fix before
claiming that gate complete. Backend HTTP tests independently cover both
SQLite lexical and PostgreSQL full-text behavior.
