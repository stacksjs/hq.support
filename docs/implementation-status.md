# Implementation status

This is a development repository, not a launch qualification. Deployment remains gated until the broad acceptance requirements have passed. The states below describe retained evidence, not marketing commitments. Update this file when a later slice adds evidence.

| Stage | State | Retained implementation and remaining work |
| --- | --- | --- |
| 0. Foundation | Partial | Native `buddy new --minimal --no-provision` package scaffold, Chris Git identity, MIT core, isolated branch, tenant domain language and canonical plan limits. Production infrastructure qualification remains required. |
| 1. Compiler proof | In progress | Five native stx web components compile into a content-addressed bundle. All six published stx 0.2.880 packages pass archive integrity, exports, strict public consumer and frozen-install checks. The actual app uses one installed compiler version. The strengthened plain-host gate passes 88 Chromium assertions under strict CSP, including focused number/email/date drafts and disabled controls. The element bundle is 13,184 bytes gzip and its loader is 1,436 bytes gzip. Native application browser journeys also pass without runtime errors. A fresh same-SHA main CI candidate, authenticated npm publication and public SDK archive readback remain required; no support-elements SDK version has been published. Broad localization, RTL and full accessibility qualification remain. |
| 2. Tenancy and entitlements | Partial | Native model definitions, generated SQLite/Postgres schema, native auth and scoped memberships, project keys hashed at rest, once-shown issuance and scope-preserving rotation, metadata-only idempotency recovery, administrator revocation and exact customer-session expiry (see `docs/credential-lifecycle.md`), exact serialized allowance mutations, pending-seat accounting, trial expiry, free conversation 120 ceiling, exact AI10 and unit bounds. Trial uses the Free allowances. All hosted conversation plans allow 20 percent grace. Confirmed Buddy connection plus hashed public deployment challenges now grant one Free workspace per owning account under an owner-row transaction and a database uniqueness guard, tested concurrently on SQLite and PostgreSQL. Framework metadata is explicitly self-reported. Signed Stripe subscription lifecycle, canonical provider reads, exact catalog pricing and prepaid wallet reservations pass both database suites. Real account credentials are verified, but live checkout/payment qualification, additional seats, optional paid overages and production Redis evidence remain. See `docs/free-verification.md`. There is no public client-supplied plan mutation. |
| 3. Inbox and messenger | Partial | Project/contact-scoped sessions, anonymous sessions only on explicit allowed origins, inbox summaries, public/internal messages, status/assignment, per-agent monotonic read cursors, cursor summaries, idempotency fingerprints and transactional outbox records. Private native disk uploads/downloads, exact byte reservation, per-file limits, idempotent upload recovery and verified deletion release are implemented. Support teams and project inboxes now persist round-robin decisions, capacity across workspace projects, explicit availability and assignment provenance. Authenticated server search covers persisted subjects/messages with tenant scope and keyset pagination (see `docs/team-inboxes.md` and `docs/conversation-search.md`). Realtime transport, configured provider delivery workers, live presence, collision detection, search index/load qualification and complete production browser journeys remain. The agent UI now sends debounced server queries across message history, preserves filters/cursors/drafts, and clears private state on logout. Team settings, assignment controls and the responsive accessible drawer pass 46 functional native-auth/SQL/browser checks, with the strict local zero-runtime-error gate now passing on installed stx 0.2.880. Combined same-commit CI remains required. |
| 4. Email and tickets | Partial | Native persisted contact-owned tickets with priority/status/assignment, optional conversation linkage and customer-scoped ticket lookup. Durable provider ingress retention/deduplication and retryable overflow processing primitives are implemented. Configurable ticket types/forms, immutable SLA policy snapshots, business calendars, pauses, escalations and scoped relations pass actual HTTP/SQL/queue fixtures on both databases. Signed SNS/SES email intake, private MIME archival, HMAC-bound replies, suppression and restart handling pass both fixture suites. Live mail DNS/SES/SNS configuration, invoice reconciliation and provider qualification remain. See docs/email.md and docs/tickets.md. |
| 5. Knowledge and AI | Partial | Revisioned multilingual article CRUD, published/public lexical retrieval, sanitized text/HTML/Markdown imports, source citations, native-provider grounded answers, copilot, conservative exact AI reservations, twenty-turn/token budgets and stale-source recovery pass both database suites. Explicit native documentation sync preserves human edits and integration attribution. Durable native pgvector and PostgreSQL full-text retrieval now have actual database and restart evidence, with workspace/audience/publication filtering before vector distance, revision activation and permission/deletion propagation. Indexing and copilot budgets are separate from customer AI allowances. Published-package verification, crawler/document extraction, complete evaluation tooling and live AI provider qualification remain. |
| 6. Workflows and proactive | Partial | Immutable published versions, durable source admission, native database queue intents and real restart-tested execution implement both condition branches, persisted waits, assignment, contact tags, public replies/internal notes, tickets, status, allowlisted contact tools and proactive new conversations. Exact quota blocks remain recoverable. Execution markers and lease recovery prevent repeated effects. Opt-in immutable customer satisfaction responses, revisioned questions and aggregate UTC reporting pass real native HTTP/SQL tests on both databases. The agent settings/report page and compiled Messenger feedback pass 36 functional browser checks, including uncertain writes, revision conflicts, customer isolation, stale account continuations, timer cleanup and fixed-panel viewport bounds (see `docs/customer-satisfaction.md`). Their strict local zero-runtime-error qualification passes on installed stx 0.2.880; combined same-commit CI remains required. Production worker supervision, more targeting/segmentation UX and configured external channel delivery remain. See `docs/workflows.md`. |
| 7. Managed channels | Partial | Native encrypted tenant connections, real account/sender/channel probes, durable dispatch/unknown/cost journals, signed Twilio/Slack/Meta ingress, native Discord cursor polling, scoped STOP/START, recoverable allowance overflow and exact fractional provider settlement pass actual HTTP fixtures against SQLite and PostgreSQL. Twilio WhatsApp uses current approved Content SID templates outside the provider reply window. Private source media ingestion and one JPEG/PNG outbound image use actual-byte quotas, durable staging and scoped expiring native signed URLs with GET/HEAD evidence. Unshared/internal agent files are private until explicit public-message publication. Broader outbound media types, installed-release requalification, remaining provider accounts/approvals and live receive/reply/receipt qualification remain blocking. An isolated Discord text path passes 39 live checks. See `docs/managed-channels.md`. |
| 8. Phone | In progress | Native Twilio call/number control, externally enforced duration, durable operation journals, cost receipts, public-knowledge authorized tools, explicit consent and a separately supervised media/Realtime bridge have deterministic HTTP/WebSocket evidence. Browser phone workspace uses the official SDK only on that page. Actual browser/device, transfer, number provisioning, live US/Canada call and resource qualification remain blocking. |
| 9. Enterprise and reporting | Partial | Project-scoped conversation/message/ticket counts exist. Signed installation entitlements, strict OIDC/SAML, browser-bound one-use flows, SCIM users/groups, workspace-only deprovisioning, audit and opt-in closed-content retention/legal holds pass real HTTP/database suites. Operational demand/message/ticket counts are persisted. Broader custom roles/policies, complete PII deletion/export, full report reconciliation and live IdP qualification remain. |
| 10. Native integration | Partial | Shared native HQ service contract, persisted encrypted connect grants, confirmation challenge, one-use polling, read-key usage endpoint and bounded summaries exist. Native support SDK and Buddy integration are tracked by the parent framework work. The public HTTPS deployment challenge, native confirmed Buddy marker and one-Free-workspace owner ledger are implemented and tested. Consumer CLI publication flow is maintained by the parent framework work. |
| 11. Migration and release | Partial | Private Intercom full-response bundle imports now have source hashes/provenance, native durable jobs, per-record checkpoints, pause/resume, external-ID mappings and reviewable failures. SQLite/Postgres restart tests include complete histories beyond 500 parts and reject ambiguous/incomplete exports. Remote attachments and unsupported source shapes remain explicit review work. Full accessibility/browser/provider/load/security qualification, production backup/restore and release acceptance remain. Production deployment remains gated until broad launch qualification passes. |

## Homepage and operator dashboard

The native stx homepage opens the hosted-format Messenger from one fixed chat
bubble. The browser qualification uses compiled assets, native Stacks HTTP,
and disposable SQLite for a first-party customer message, an authenticated
agent reply, keyboard focus, and same-tab reload. It also checks help
fallback, reduced motion, and narrow viewports. The reviewed
`0.1.0-alpha.0` npm archive already passed
[public readback](https://github.com/stacksjs/hq.support/actions/runs/43630101975).
The changed elements are queued for `0.1.0-alpha.1`.

The local operator dashboard discovers the failed-job model directly from
`app/Models`. Its native model API omits payloads and exceptions and refuses
generic access to tenant conversations, contacts, workspaces, customer
sessions, and API keys. The workspace inbox remains the operator path for
scoped support records. The
[launch tracker](https://github.com/stacksjs/hq.support/issues/10) links the
remaining qualification and deployment issues.

## Retained backend evidence

The project Reports page adds a rolling 30-day cohort for Messenger conversations.
It shows elapsed-time averages and sample counts for the first human reply,
follow-up replies, and resolution. The first reply is measured from the first
customer message. A follow-up is measured from the latest customer message to
the next human reply, once per customer turn. Resolution uses the current close
timestamp, so reopening removes the sample until the conversation closes again.
Only public, stored messages from customers and signed-in agents enter the
timing calculation. All-time project totals continue to include every channel.
Business-hour SLA cohorts and provider-receipt timing are tracked in #5.

`./buddy test tests/feature/support-http.test.ts` starts an isolated real HTTP server and real disposable SQLite or PostgreSQL database, applies the committed native model migrations and native auth tables, then verifies registration/login, cross-workspace refusals, write/read key scope, customer session hashing, allowed-origin CORS, customer isolation, internal note confidentiality, exact wire summaries, idempotency replay/conflict, atomic outbox creation, pending invitations within two seats, concurrent 120th/121st free conversation admission, existing-thread replies after the cap, exact tenth/eleventh AI admission, HQ usage and confirmed one-use connect grants. Tests mutate verification flags only inside their owned test database; there is no endpoint that accepts those flags from a customer.

`./buddy typecheck` passes for the initial backend slice. The same retained HTTP harness passes against real disposable SQLite and PostgreSQL databases. It includes explicit transaction rollback, concurrent outbox leasing, retained/recoverable provider overflow, real private filesystem attachment upload/download/delete, exact aggregate storage and maximum file boundary checks. Production provider and Redis acceptance remain separate. Wallet and subscription checkout availability is conditional on explicit provider configuration; no simulated successful payment is exposed to production users.

## Required limits

Integer cents and decimal bytes are canonical. Free: two humans including owner/pending invitations; 100 new conversations per UTC month with 20 percent grace, refusing 121; exact ten AI-handled text conversations; 300,000,000 attachment bytes total and 10,000,000 bytes per file; one project/brand. Starter: $49 monthly, five seats, 1,000 conversations, 100 AI, 5 GB, three projects, 25 MB files. Growth: $199, 15 seats, 5,000 conversations, 500 AI, 25 GB, ten projects, 25 MB files. Enterprise: $999, 50 seats, 25,000 conversations, 2,500 AI, 100 GB, unlimited projects, 50 MB files. Annual price is ten monthly payments. Extras: seat $10, optional 1,000 conversations $10, AI unit $0.39. Overage and automatic wallet topup default off. Managed wallet minimum $20, actual provider cost plus 15 percent; voice AI is separate. Self-hosted core has no SaaS limits; enterprise starts $299 per installation/month.

## Managed channel and media evidence

The channel HTTP fixture passes 52 checks on each real database, using a local
HTTP provider boundary and native authentication, ORM transactions, queue
intents, encrypted credentials, Storage and wallet accounting. It covers exact
provider sender/routing probes, stale-probe rejection, credential rotation,
unknown POST outcomes and signed callback recovery, a fresh-process dispatch
crash, scoped consent, allowance overflow, approved WhatsApp templates, Slack
signatures, Discord cursor recovery and signed private-image GET/HEAD. The
core HTTP fixture passes 63 checks per database, including private attachment
metadata/download refusal, internal-note confidentiality and explicit public
publication. PostgreSQL uses the owned local vector-capable cluster; no shared
server schema was modified. Initial qualification used reviewed native source
aliases. The complete application suite subsequently passed 46 tests using
registry-installed native 0.75.579 packages without aliases or local links.
Native 0.75.580 also passes repeated migration generation without changes,
TypeScript checking, 18 affected artifact/configuration tests and all 78 browser
assertions. Live provider acceptance remains a separate requirement.

## Stage 3: support team inbox routing

The backend now has separate support-team memberships, project team inboxes,
explicit agent availability and workspace-wide open-conversation capacity.
Native workspace membership remains the access authority. Persisted round robin,
manual assignment, default ingress routing, legacy status updates and workflow
assignment share the same native workspace transaction lock and audit engine.
Overflow remains unassigned. Closed and snoozed conversations release capacity;
reopening rechecks admission. Agents cannot claim another agent's assignment or
change capacity. Owners/admins manage team and inbox configuration.

The retained HTTP fixture uses installed NPM Stacks 0.75.579 with real disposable
SQLite and PostgreSQL databases. Three independent native HTTP server processes
race one final capacity slot; exactly one assignment is admitted. A further
fresh server process resumes the persisted cursor. Additional cases cover
cross-project/tenant isolation, inactive membership/inbox refusal, team removal,
admin/agent permissions, exact cross-brand load, idempotent routing retries and
durable workflow provenance. Core auth/allowance, native SDK/widget and workflow
HTTP suites provide regression coverage. No customer/provider traffic is used.

Native team settings and inbox routing controls are now implemented with real
authenticated SSG browser functional evidence. The strict zero-runtime-error
browser gate remains pending the published native compiler fix. Presence,
automatic draining of old overflow, merge/split and production workload
qualification remain outstanding. See `docs/team-inboxes.md`
for the HTTP contract and precise routing rules. These APIs do not qualify the
whole inbox stage or deployment for launch.

The integrated application now passes 65 Bun tests across 27 files using the released native 0.75.581 packages, including disposable SQLite and PostgreSQL. TypeScript, Pickier and repeated model migration generation pass. These checks do not substitute for the pending strict installed-compiler agent UI, live provider, load, backup/restore and release qualification.

## Customer request continuations

The backend continuation slice passed 67 tests across 28 files on both databases
in [its exact source CI](https://github.com/stacksjs/hq.support/actions/runs/43612948887).
Resolution timestamps, trusted receipt time and immutable channel bindings keep
replies within seven days in the original admission and later requests in a
linked, newly metered conversation. Retried old URLs follow the same saved
successor. Historical delivery receipts and SLA clocks keep their original
destination. See `docs/customer-reopening.md`.

The compiled Messenger and agent interface pass 18 native
authentication/SQL/Chromium checks, including uncertain acknowledgements,
402/409/422 draft retention, stale predecessor refreshes, cleared customer
feedback and explicit linked navigation with separate staff drafts. Their
strict zero-runtime-error browser gate passes with installed stx 0.2.880.
The native 0.75.584 dependency upgrade separately passed the full earlier
65-test suite in [registry-installed CI](https://github.com/stacksjs/hq.support/actions/runs/43613360696).
The combined source still needs its final same-commit application CI gates;
these separate results do not qualify a release artifact.

## Installed compiler and live channel qualification

Registry-installed stx 0.2.880 passes authored template checking across 28 files,
42 script blocks and 1,386 expressions without errors. The native application
browser runners pass 46 team/search, eight credential, 36 customer satisfaction
and 18 continuation assertions, including their strict runtime-error gates.
These local journeys used native 0.75.584; the subsequent 0.75.585 upgrade and
combined source require the same-commit CI run. The compiler packages and native
framework packages are installed from registry artifacts without source links.

Discord text support passed 39 live assertions in an isolated private test
channel using actual native authentication, HTTP actions, generated SQLite,
encrypted tenant credentials and the database queue worker. The single queued
reply received a real provider ID and `accepted` state, and appeared in the
native Discord client. Same-key retry, repeat polling, bot echo suppression and
internal-note privacy passed. This is an isolated live text-path qualification,
not a production deployment, recipient read receipt, or qualification of all
Discord thread/media capabilities or other providers.
