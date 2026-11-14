# Typed ticket browser qualification

The public `hq-support-ticket-form` is emitted by the native web-component compiler. It fetches only the origin/session-scoped public `ticket-types` endpoint, retains drafts when forms refresh, and accepts only customer-visible field definitions. Tokens are properties, never reflected attributes. The agent console separately uses authenticated `ticket-configuration` metadata.

Verified in Chrome against the real native HTTP router, native password session and disposable SQLite database on 2026-11-14 UTC. `SUPPORT_NATIVE_UI=1 tests/widget-preview.ts` served the SSG console on port 4407 and a cross-origin plain HTML customer host on 4409. Unpublished native backend features used the documented enterprise fixture source aliases; this is source qualification, not proof that the pending native release is available from npm.

- Invalid IANA timezone returned the actual 422 message and retained all calendar drafts. A corrected America/New_York calendar and working-minute policy persisted.
- A type missing the policy pause-state key returned the actual 422 message and retained fields. Adding that state saved a customer type with a required public integer and a required private string default.
- The emitted public form exposed neither the private field/default nor an incident type. Required validation retained subject/details; refreshing definitions retained integer and text drafts.
- Customer submission persisted a typed ticket. A second seven-control form persisted string, email, number `12.5`, integer `4`, boolean `false`, date and enum as their native JSON types. The SQL rows were inspected read-only.
- The agent editor displayed the immutable form snapshot, private default and server-calculated deadlines. Refresh preserved unsaved field/state drafts. Saving the pause state cleared active deadlines; resuming restored server business-time deadlines.
- Agent-only incident creation and a parent relation persisted. A reciprocal parent relation returned the real cycle error.

Screenshots: `/tmp/hq-support-ticket-sla.png`, `/tmp/hq-support-ticket-public-form.png` (machine-local).

Definitions are append-only. There is no edit/delete/migration API for saved types, policies or calendars, and no relation-removal API. The local countdown never asserts an unpersisted breach. Paused clocks have no invented remaining-time estimate. SLA escalation is internal durable work, not proof of external notification delivery.
