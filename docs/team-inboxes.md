# Support teams and team inboxes

A support team is a group of active workspace members. It does not replace the native `Team` model or grant workspace access. `SupportTeam`, `SupportTeamMember` and `SupportRoutingAgent` use separate `support_*` tables. A team inbox belongs to exactly one project and support team. Each project can have one active default inbox. An inbox's team is immutable; create a new inbox to change it.

Native authenticated owners/admins manage teams, team membership, inboxes and agent capacity. Agents may change their own explicit availability, claim an unassigned conversation, or release their own assignment. They cannot assign another agent, steal another agent's assignment, change capacity, move inbox context or request automatic reassignment. Active workspace membership remains authoritative on every decision. Server integration keys and customer session tokens do not authorize these management routes.

Availability is an explicit persisted setting (`available`, `away`, `offline`), not live presence. A member without routing settings is available with capacity 10, preserving legacy assignment behavior. Capacity is 1–1000 open conversations across **all projects and inboxes in the workspace**, including legacy conversations without an inbox. Closed and snoozed conversations retain historical assignee context but consume no open capacity. Reducing capacity below current open load is rejected. Going away does not discard existing work. Explicit null capacity or availability is invalid; omit a field to preserve its current value.

Round robin orders active support-team membership rows by their persistent ID. The inbox stores its last successfully selected member ID. Each decision takes the native workspace transaction lock before reading membership, availability, open load and the cursor, then commits the assignment, cursor and audit together. The engine skips unavailable, inactive and full agents. If none qualifies, the conversation remains unassigned with `no_eligible_capacity`; it does not overbook or pretend that routing succeeded. Manual inboxes retain unassigned work. Automatic routing only assigns open conversations.

New conversations from the widget, native SDK and managed channel ingress use the project's default inbox inside their existing idempotent transaction. Browser-supplied team/inbox/assignee fields cannot select routing on customer creation. Existing conversations are not silently moved when a default changes. Team removal/disable releases the affected assignments and records who changed them. Reopening a conversation readmits its former agent against availability and capacity; if that admission fails, the conversation reopens unassigned. Closing an existing assignment remains available when that agent is inactive or unavailable.

Both the existing `PATCH /api/support/projects/{project}/conversations/{id}` and workflow `assign`/`status` nodes use the same engine. Workflows retain their immutable durable run and step checkpoints; the assignment audit records the actual run ID. A full/unavailable workflow target fails the step rather than bypassing admission. No provider side effect occurs in this slice.

## Authenticated HTTP contract

All paths below require a native signed-in user and use the existing CSRF protection for cookie authentication. IDs accept positive safe integers or nonempty decimal digit strings; booleans, arrays, objects, null and scientific-notation strings are rejected by the shared identifier validator. User IDs reference native workspace users, not customer contact IDs. Responses use the application's persisted snake-case row fields, except routing decisions and audit snapshots, which use camel case.

| Route | Input / response |
| --- | --- |
| `GET /api/support/workspaces/{workspace}/support-teams` | `{ teams, members }`; membership rows also include `workspace_status` |
| `POST /api/support/workspaces/{workspace}/support-teams` | `{ name, active?: boolean }` → `201 { team }` |
| `POST /api/support/workspaces/{workspace}/support-teams/{id}` | `{ name?, active? }` → `{ team }` |
| `POST /api/support/workspaces/{workspace}/support-teams/{id}/members` | `{ userId, active?: boolean }` → `{ member }`; false removes and releases assignments |
| `GET /api/support/workspaces/{workspace}/routing-agents` | `{ agents }`; each includes `user_id`, `availability`, `capacity`, `open_count` |
| `POST /api/support/workspaces/{workspace}/routing-agents` | `{ userId, availability?, capacity? }` → `{ agent }` |
| `GET /api/support/projects/{project}/team-inboxes` | `{ inboxes }` |
| `POST /api/support/projects/{project}/team-inboxes` | `{ teamId, name, assignmentMode?: 'manual'|'round_robin', isDefault?: boolean, active?: boolean }` → `201 { inbox }` |
| `POST /api/support/projects/{project}/team-inboxes/{id}` | Mutable inbox settings → `{ inbox }`; clear `isDefault` when disabling the default |
| `POST /api/support/projects/{project}/conversations/{id}/routing` | `{ inboxId?, mode?: 'manual'|'auto', assigneeId?, status?, idempotencyKey? }` → `{ conversation, routing: { assigneeId, teamId, inboxId, status }, reason }` |
| `GET /api/support/projects/{project}/conversations/{id}/routing-audit` | `{ assignments }`, newest 100 decisions with source, actor, run ID and before/after snapshots |

Zero unassigns an agent or clears inbox context. `inboxId` must belong to the conversation's project. Manual assignment to a team inbox requires an active member of that support team as well as an active native workspace membership. Owners/admins can retry overflow by requesting `mode: 'auto'`. Supply a fresh `idempotencyKey` for an explicit routing operation and reuse it after an uncertain HTTP response: its replay returns the committed decision without advancing the cursor twice, and a changed payload is rejected. Legacy PATCH calls remain valid without a key.

The agent inbox supports `GET /api/support/projects/{project}/inbox?inboxId={id}&status=open&limit=50&cursor={cursor}`. `inboxId=0` selects conversations without inbox context. IDs, status, pagination bounds and duplicate query parameters are validated. Agent list/detail responses expose `assignee_id`, `team_id`, `inbox_id` and `routing_reason`; customer widget and native server SDK summaries keep their existing customer-facing shape.

## Qualification and remaining work

`tests/feature/team-routing.test.ts` boots actual installed Stacks packages, native authentication and HTTP routes against disposable SQLite and PostgreSQL databases. It exercises tenant/project isolation, successful scoped lists, manual authorization and inboxes, default replacement, immutable inbox teams, malformed-input rollback, round robin, availability, workspace-wide load, concurrent last-slot admission from three independent native HTTP server processes, close/snooze/reopen, member removal, durable workflow assignment and status-based readmission, explicit-operation retries and a fresh server process resuming the saved cursor. The core HTTP fixture also refuses malformed contact IDs on existing ticket creation without adding a ticket or outbox work. Existing core HTTP and workflow suites provide regression coverage.

This slice supplies backend routing APIs. It does not claim a team settings UI, live presence, automatic draining of old overflow, an operator capacity override, merge/split, provider delivery or a production load qualification. Overflow is retried explicitly; making an agent available does not silently redistribute work. PostgreSQL tests require the owned pgvector-capable test cluster because the complete app schema also includes knowledge vectors.
