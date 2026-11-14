# Implementation status

This is a development repository, not a launch qualification. Deployment remains gated until the broad acceptance requirements have passed. The states below describe retained evidence, not marketing commitments. Update this file when a later slice adds evidence.

| Stage | State | Retained implementation and remaining work |
| --- | --- | --- |
| 0. Foundation | Partial | Native `buddy new --minimal --no-provision` package scaffold, Chris Git identity, MIT core, isolated branch, tenant domain language and canonical plan limits. Production infrastructure qualification remains required. |
| 1. Compiler proof | In progress | Five native stx web components compile into a content-addressed bundle. Published stx 0.2.872 preserves real lifecycle method declarations, verified by a strict installed consumer. The loader plus elements total under 12 KB gzip. A candidate built with registry-installed native 0.75.581 passes strict clean-consumer declarations and six real Chromium import journeys; successful same-SHA main CI retains the exact archive and hosted assets. Actual npm publication still requires a usable credential and public registry readback. Plain-host Chrome checks cover CSP without unsafe-inline/eval, isolated styles, two instances, token properties, account cleanup, failed drafts and disposal. Broad localization, RTL and full accessibility qualification remain. |
| 2. Tenancy and entitlements | Partial | Native model definitions, generated SQLite/Postgres schema, native auth and scoped memberships, project keys hashed at rest, once-shown issuance and scope-preserving rotation, metadata-only idempotency recovery, administrator revocation and exact customer-session expiry (see `docs/credential-lifecycle.md`), exact serialized allowance mutations, pending-seat accounting, trial expiry, free conversation 120 ceiling, exact AI10 and unit bounds. Trial uses the Free allowances. All hosted conversation plans allow 20 percent grace. Confirmed Buddy connection plus hashed public deployment challenges now grant one Free workspace per owning account under an owner-row transaction and a database uniqueness guard, tested concurrently on SQLite and PostgreSQL. Framework metadata is explicitly self-reported. Signed Stripe subscription lifecycle, canonical provider reads, exact catalog pricing and prepaid wallet reservations pass both database suites. Real account credentials are verified, but live checkout/payment qualification, additional seats, optional paid overages and production Redis evidence remain. See `docs/free-verification.md`. There is no public client-supplied plan mutation. |
| 3. Inbox and messenger | Partial | Project/contact-scoped sessions, anonymous sessions only on explicit allowed origins, inbox summaries, public/internal messages, status/assignment, per-agent monotonic read cursors, cursor summaries, idempotency fingerprints and transactional outbox records. Private native disk uploads/downloads, exact byte reservation, per-file limits, idempotent upload recovery and verified deletion release are implemented. Support teams and project inboxes now persist round-robin decisions, capacity across workspace projects, explicit availability and assignment provenance. Authenticated server search covers persisted subjects/messages with tenant scope and keyset pagination (see `docs/team-inboxes.md` and `docs/conversation-search.md`). Realtime transport, configured provider delivery workers, live presence, collision detection, full search UI/index/load qualification and complete production browser journeys remain. |
| 4. Email and tickets | Partial | Native persisted contact-owned tickets with priority/status/assignment, optional conversation linkage and customer-scoped ticket lookup. Durable provider ingress retention/deduplication and retryable overflow processing primitives are implemented. Configurable ticket types/forms, immutable SLA policy snapshots, business calendars, pauses, escalations and scoped relations pass actual HTTP/SQL/queue fixtures on both databases. Signed SNS/SES email intake, private MIME archival, HMAC-bound replies, suppression and restart handling pass both fixture suites. Live mail DNS/SES/SNS configuration, invoice reconciliation and provider qualification remain. See docs/email.md and docs/tickets.md. |
| 5. Knowledge and AI | Partial | Revisioned multilingual article CRUD, published/public lexical retrieval, sanitized text/HTML/Markdown imports, source citations, native-provider grounded answers, copilot, conservative exact AI reservations, twenty-turn/token budgets and stale-source recovery pass both database suites. Explicit native documentation sync preserves human edits and integration attribution. Durable native pgvector and PostgreSQL full-text retrieval now have actual database and restart evidence, with workspace/audience/publication filtering before vector distance, revision activation and permission/deletion propagation. Indexing and copilot budgets are separate from customer AI allowances. Published-package verification, crawler/document extraction, complete evaluation tooling and live AI provider qualification remain. |
| 6. Workflows and proactive | Partial | Immutable published versions, durable source admission, native database queue intents and real restart-tested execution implement both condition branches, persisted waits, assignment, contact tags, public replies/internal notes, tickets, status, allowlisted contact tools and proactive new conversations. Exact quota blocks remain recoverable. Execution markers and lease recovery prevent repeated effects. Production worker supervision, more targeting/segmentation UX and configured external channel delivery remain. See `docs/workflows.md`. |
| 7. Managed channels | Partial | Native encrypted tenant connections, real account/sender/channel probes, durable dispatch/unknown/cost journals, signed Twilio/Slack/Meta ingress, native Discord cursor polling, scoped STOP/START, recoverable allowance overflow and exact fractional provider settlement pass actual HTTP fixtures against SQLite and PostgreSQL. Twilio WhatsApp uses current approved Content SID templates outside the provider reply window. Private source media ingestion and one JPEG/PNG outbound image use actual-byte quotas, durable staging and scoped expiring native signed URLs with GET/HEAD evidence. Unshared/internal agent files are private until explicit public-message publication. Broader outbound media types, installed-release requalification, provider accounts/approvals and every live receive/reply/receipt test remain blocking. See `docs/managed-channels.md`. |
| 8. Phone | In progress | Native Twilio call/number control, externally enforced duration, durable operation journals, cost receipts, public-knowledge authorized tools, explicit consent and a separately supervised media/Realtime bridge have deterministic HTTP/WebSocket evidence. Browser phone workspace uses the official SDK only on that page. Actual browser/device, transfer, number provisioning, live US/Canada call and resource qualification remain blocking. |
| 9. Enterprise and reporting | Partial | Project-scoped conversation/message/ticket counts exist. Signed installation entitlements, strict OIDC/SAML, browser-bound one-use flows, SCIM users/groups, workspace-only deprovisioning, audit and opt-in closed-content retention/legal holds pass real HTTP/database suites. Operational demand/message/ticket counts are persisted. Broader custom roles/policies, complete PII deletion/export, full report reconciliation and live IdP qualification remain. |
| 10. Native integration | Partial | Shared native HQ service contract, persisted encrypted connect grants, confirmation challenge, one-use polling, read-key usage endpoint and bounded summaries exist. Native support SDK and Buddy integration are tracked by the parent framework work. The public HTTPS deployment challenge, native confirmed Buddy marker and one-Free-workspace owner ledger are implemented and tested. Consumer CLI publication flow is maintained by the parent framework work. |
| 11. Migration and release | Partial | Private Intercom full-response bundle imports now have source hashes/provenance, native durable jobs, per-record checkpoints, pause/resume, external-ID mappings and reviewable failures. SQLite/Postgres restart tests include complete histories beyond 500 parts and reject ambiguous/incomplete exports. Remote attachments and unsupported source shapes remain explicit review work. Full accessibility/browser/provider/load/security qualification, production backup/restore and release acceptance remain. Production deployment remains gated until broad launch qualification passes. |

## Retained backend evidence

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

Team settings UI, presence, automatic draining of old overflow, merge/split and
production workload qualification remain outstanding. See `docs/team-inboxes.md`
for the HTTP contract and precise routing rules. These APIs do not qualify the
whole inbox stage or deployment for launch.
