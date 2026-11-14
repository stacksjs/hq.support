# HQ.support

HQ.support is a support platform built on Stacks. The public core is MIT. Optional enterprise features live under `enterprise/` under their separate commercial terms.

A workspace is the billing and tenant boundary. A project is an application or brand within that workspace. Human agents are native Stacks users admitted through active workspace memberships. Pending invitations reserve human seats. Contacts are customers, identified by the server's external identity within one project. A customer session is an opaque, expiring credential scoped to that contact and project. A server API key can establish customer identity; a public project identifier cannot.

A conversation contains public messages and internal notes. Customers only read public messages belonging to their own conversations. A new conversation consumes one unit in the UTC month in which it is created. Replies to existing conversations stay available after the new conversation allowance is exhausted. An AI-handled conversation is a separate exact unit, bounded by 20 turns and 20,000 reserved tokens. AI provider orchestration remains separately qualified before it can be advertised.

A ticket is a support work item belonging to a contact and optionally a conversation. A knowledge article has a revision, publication state and public/internal visibility. A workflow is a persisted definition; storing one does not imply that an executor is running. An outbox entry is durable pending work, not proof that an external service accepted a delivery. Provider ingress must persist before processing, including at an allowance boundary.

The hosted free Stacks plan requires both a Buddy connection and verified ownership of the deployed application. A Buddy key grant alone does not establish deployment ownership. Other hosted customers start a 14-day trial. The trial currently uses Free allowances. Self-hosted core carries no hosted allowance limits. Plan values are authored once in `app/Support/limits.ts`.

Production targets PostgreSQL and Redis. Local development uses SQLite. Schema migrations are generated from `app/Models`; both SQLite and PostgreSQL corpora are committed. Accounts, sessions and token issuance use native Stacks auth actions and middleware. No upstream application secrets or runtime databases are copied into this repository.

A support team groups active native workspace members without granting workspace access. A team inbox routes one project to one support team. Explicit agent availability is a persisted preference, not presence. Routing capacity counts open assignments across the entire workspace; snoozed and closed conversations release capacity. Round robin persists its cursor per inbox, and unassigned overflow is retained for explicit retry. Assignment decisions record the native actor or durable workflow run with before/after context.

Customer satisfaction (CSAT) is an explicitly enabled project survey presented after a customer's own conversation is resolved. One immutable response belongs to that conversation and customer; it preserves the question and setting revision that were offered. Configuration changes do not rewrite historical responses. CSAT is support feedback, not consent for marketing or a new billable conversation. A stored response is not an outbound survey delivery.
