# Durable realtime persistence, first slice

Scope: application-owned replay persistence at the existing `enqueue` mutation seam. No routes, SSE transport, browser subscriptions, or UI changes in this slice. Uses published `@stacksjs/realtime` 0.75.584 SQL durable replay and invalidation contracts.

## Transaction boundary

`workspaceTransaction` supplies an explicit transaction-bound SQL handle and an active, workspace-matched context. Existing `query`/`insert` helpers select that handle while the context is active; escaped async contexts and cross-workspace nesting fail. A native database transaction without this context does not authorize replay writes. Workspace row locks precede channel locks. Savepoints keep separate active contexts and native outer-commit callback ownership.

`enqueue` inserts the existing workflow/delivery outbox row and appends replay entries before returning. Domain writes, allowance reservations, idempotency response, outbox, replay checkpoint and replay events therefore commit or roll back together. Replay operation keys derive from the stable outbox event ID, and replay is never appended by a delayed delivery worker. Hints are best-effort, metadata-only native invalidations buffered until outer commit. They add no outbox kind, do not compete with workflow leases, and are never the durable recovery source.

## Channels and privacy

Server-selected names: one agent channel per project and one customer channel per project/contact. Both carry only event `changed` and JSON `null`; no identifiers, bodies, routing metadata or activity timestamps occur in payloads. The native stored event timestamp is visible only through the authorized replay channel. Customer channel advancement uses an explicit allowlist and scoped persisted public domain records. Private notes, assignments, read cursors and internal attachments never append or hint to the customer channel. Unknown event kinds can invalidate the agent project channel only.

Only enrolled, unexpired channels are appended. Mutations never create a channel merely because an imported contact exists. The later authorized snapshot slice owns enrollment, lease renewal, project/workspace/operator caps, inactive pruning, reincarnation on reenrollment, and explicit snapshot-only capacity fallback. This slice exposes the transaction-bound store adapter but no enrollment endpoint. Default bus bounds must accommodate at least 1000 customer subscriptions plus agents when transport is introduced.

## Test matrix and seams

The agreed service seam uses real migrations and real SQLite/PostgreSQL. It catches mutation/quota/outbox/replay atomicity, nested transaction behavior, explicit transaction ownership, idempotency and customer privacy. It does not cover HTTP authorization or UI rendering, which belong to later slices.

| Proof | Expected behavior |
| --- | --- |
| Public conversation/reply | Existing enrolled project + owning customer channels append once with changed/null |
| Private note/assignment/read/internal attachment | Customer head, last-recorded timestamp, events and hints remain unchanged |
| Rollback after enqueue | Domain/quota/outbox/replay unchanged; no hints |
| Inner savepoint success then outer rollback | No committed replay or hints |
| Failed inner savepoint with outer commit | Only successful outer work survives |
| Wrong workspace, bare native transaction, escaped active context | Replay refuses before writing |
| Idempotent mutation retry | Existing response and head unchanged |
| Not enrolled / expired channel | Domain write succeeds; no channel creation or refresh |
| Independent process restart / delayed outbox queue drain | Replay survives; drain adds no replay and retains generic outbox behavior |
| Concurrent independent SQL workers | Contiguous channel sequences on both dialects |
| Actual Redis subscribers | Wake after commit only; no private customer wakeup; durable replay works without Redis |

Migration models, generated SQLite/PostgreSQL SQL and both snapshots travel together. Generation must be stable on a second pass. Run focused service fixtures, buddy lint/typecheck/test and exact combined CI. Any unrun external-service gate stays explicit.

## Rollout and public classification

Initial public customer allowlist: `conversation.created` and `message.created`, only after resolving the referenced public message and its conversation/contact within the exact workspace/project; `attachment.shared`, only for a persisted stored public attachment. Unknown kinds, notes, assignments, read cursors and internal attachment changes are agent-only. No contact or channel identity is accepted from arbitrary payload fields. Status/ticket/customer-setting events can be added later with an explicit projection contract and privacy tests.

Before authorized snapshot enrollment exists, all mutations keep their current behavior and create no replay channels. The finite replay/snapshot slice must also replace the existing widget conversation summary `updated_at` with public-only activity; private mutations currently update the underlying conversation timestamp. This prerequisite applies to existing widget reads as well as the new replay route. Hint loss never advances a cursor; finite replay/checkpoint reconciliation must recover even when only the producer loses Redis.
