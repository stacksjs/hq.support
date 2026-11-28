# Tickets and SLA clocks

Ticket types, forms, calendars, policies, relations and SLA clocks use native model-generated SQL schema. Existing ticket create/list/update and customer ticket APIs remain compatible. `status` still reports `open`, `pending` or `resolved`; `state` supports additional form-specific keys. A migrated legacy ticket retains its existing status when updated.

## Configuration and forms

Owner/admin configuration endpoints under `/api/support/projects/{project}`:

- `GET /ticket-configuration` lists project-scoped types, calendars and policies.
- `POST /ticket-calendars` accepts `name`, `timeZone`, `windows: [{weekdays: [0..6], start: '09:00', end: '17:00'}]` and optional `holidays: ['YYYY-MM-DD']`. Sunday is 0. `24:00` is supported only as an end. Split overnight windows into two weekday windows.
- `POST /ticket-sla-policies` accepts `name`, optional `calendarId`, `firstResponseMinutes`, `resolutionMinutes`, optional `pauseStates` and `escalationAssigneeId`. Zero disables a metric; at least one metric must be positive. Targets are whole minutes, at most 525600. A missing calendar means always open.
- `POST /ticket-types` accepts `name`, `kind: 'customer' | 'internal' | 'incident'`, optional `slaPolicyId`, `fields` and additional `states`. Customer types can set `opensConversation: true`.

Field definitions contain a unique `key`, `label`, `type`, optional `required`, `visibility: 'customer' | 'internal'`, and optional typed `default`. Supported types are `string` (up to 4000 characters), `email`, `number`, `integer`, `boolean`, `date` (canonical YYYY-MM-DD), and `enum` (requires explicit `options`). Values are validated by native validation rules; numeric strings do not satisfy number fields. Customer forms cannot require an internal field without a default. Unknown fields are refused. Tickets accept `typeId` and `customFields`; their form definitions are copied into an immutable ticket snapshot. Subsequent field updates are validated against that snapshot.

Additional states contain `key`, `label`, and legacy `category: 'open' | 'pending' | 'resolved'`. Built-in `open`, `pending` and `resolved` states are always available. Policy pause states must explicitly exist on the form. Configuration is append-only through these APIs: create a new calendar, policy or type to change future ticket behavior. Existing tickets keep their snapshots. Configuration edit/delete and type migration flows are not implemented.

Authenticated customer sessions can `GET /api/widget/projects/{project}/ticket-types` from an allowed origin. Only customer types and customer fields are returned. Customer ticket creation accepts the same form fields, preserves idempotency, refuses private field writes and internal/incident types, and hides private definitions/values from ticket responses. Internal tickets remain inaccessible even when they share the customer's contact record. Agent-only relation metadata is never included in customer projections.

Customers can list their own tickets through `GET /api/widget/projects/{project}/tickets`
using the same approved origin and bearer session as ticket detail. The response
contains `tickets` and a nullable `nextCursor`. It returns 20 tickets per page by
default and accepts `limit` from 1 to 100 and the previous page's `cursor`. Each
summary contains the customer-facing state and an accessible conversation ID
when linked. The `hq-support-ticket-status` element offers this history when its
`ticketId` property is empty.

When a customer submits an opted-in type without a conversation, HQ.support opens a linked conversation for the same contact, consumes one conversation allowance, and uses the project's usual default inbox routing. The ticket and conversation commit together and an unchanged retry returns the same pair. The ticket response includes `conversation_id`. Use that ID with the existing customer conversation endpoint and the same session to read replies. The opening message uses the submitted description or title. Typed form answers stay on the ticket.

## Clocks and business time

A typed ticket starts independent first-response and resolution targets from the server acceptance instant. Unspecified types retain the legacy behavior without an SLA. Each clock snapshots its policy and calendar. Targets consume actual elapsed working milliseconds. Overlapping windows count once; configured local holidays contribute no working time. Calendar conversion uses native Stacks datetime helpers with IANA time zones, including 23/25-hour DST days. Repeated wall times use the earlier instant; nonexistent wall times shift forward according to native zone conversion. A window normalized to an empty span across a DST gap contributes no time. Calculations are bounded to ten calendar years and reject unschedulable targets.

Entering an explicit pause state consumes business time through that instant, clears active deadlines and preserves remaining budgets. Resuming recalculates deadlines from the remaining budget. An agent's first accepted public response satisfies the first-response clock; customer messages, internal notes, automated workflow replies, and merely queued or uncertain provider sends do not. Managed-channel acceptance/reconciliation calls the same trusted response hook after confirmed provider acceptance. An accepted response while paused satisfies first response without consuming paused time.

A response, pause or resolution at the exact deadline is late: the due breach is persisted first. Resolution stops the cycle. Reopening creates a new cycle with new targets and the then-current type policy, preserving prior clock/escalation history. First response is measured again in the new cycle. SLA projections expose due, completion and breach timestamps, not internal policy metadata. A worker may observe a breach later; `deadlineAt` remains the exact deadline, while `processedAt` records processing time.

## Relations and escalation

Agent members can `GET/POST /tickets/{id}/relations`. Creation accepts `relatedTicketId` and `kind: 'parent' | 'incident' | 'internal' | 'customer'`. Both records must belong to the same project/workspace. Nonparent relation kinds require a matching target ticket kind. A ticket has at most one parent; self-links, cycles and ancestry deeper than 100 records are refused under the workspace transaction lock. Repeating the same relation returns the original row. Relation removal is not implemented.

The native `RunTicketSla` Job runs each minute on the `support-sla` database queue. A breach transaction persists a unique `(clock_id, metric)` escalation, optionally assigns a still-active configured workspace member, writes a `ticket.sla.breached` internal event, and writes the standard `event.created` outbox intent referencing that event. Existing durable workflow dispatch can process that intent. This is exactly-once internal escalation admission, with normal at-least-once outbox processing. It does not claim an email, SMS or other external notification was delivered. Concurrent workers, repeated jobs and new processes cannot create duplicate escalation work. A later worker batch continues after the 1000-clock batch limit.

Deployment requires the explicit scheduler registration and a database worker consuming `support-sla`. `rate` metadata alone is not proof that a worker is running. Keep the database queue even when Redis is used for cache and presence.

## Verification and limits

`tests/feature/tickets.test.ts` runs the native HTTP router, native account authentication and generated schema against disposable SQLite and PostgreSQL. Fixtures cover two-workspace isolation, typed fields, customer privacy/origins/idempotency, relation cycles, legacy ticket compatibility, UTC and New York business hours, holidays/weekends, both DST transitions, pause/resume, exact deadline ordering, accepted public response hooks, native database queue restart and duplicate escalation prevention. No live notification providers are called.

Ticket form/relations/SLA management UI, business-time reporting, multi-policy selection by priority, retrospective recalculation, comprehensive PII retention/erasure of custom fields, and external escalation notification configuration still require separate qualification. The existing enterprise text retention policy does not erase typed custom fields or historical SLA/event/outbox snapshots. Apply a reviewed data retention policy before placing sensitive customer information in those fields.
