# Implementation status

The [launch tracker](https://github.com/stacksjs/hq.support/issues/10) records the public release gates. Production deployment requires evidence for every check in `scripts/check-launch.ts` on the exact release commit.

| Stage | Verified evidence | Remaining launch work |
| --- | --- | --- |
| 0. Foundation | The package-based Stacks app uses native authentication, models, SQL migrations, and Buddy deployment. The shared Hetzner host passed worker and Redis isolation, load, off-host backup and restore, and release rollback. [Host qualification](https://github.com/stacksjs/hq.support/issues/11) | Public HTTPS cutover and smoke checks. [Deployment](https://github.com/stacksjs/hq.support/issues/7) |
| 1. Compiler and SDK | The stx web components build as versioned hosted assets and a portable npm package. They pass the native consumer, strict CSP, theme, and keyboard checks. npm serves `0.1.0-alpha.1` on the `alpha` tag. [SDK package](https://www.npmjs.com/package/@stacksjs/support-elements) | Publish and verify the reviewed `0.1.0-alpha.3` archive. [Publication](https://github.com/stacksjs/hq.support/issues/30) |
| 2. Tenancy and entitlements | Native membership gates protect workspaces, customer sessions, and project keys. Both databases pass scoped credential lifecycle, serialized admission limits, and wallet tests. Live Stripe sandbox checkout, subscription, invoice, refund, and callback replay passed. [Credential lifecycle](credential-lifecycle.md) · [Provider qualification](https://github.com/stacksjs/hq.support/issues/8) | Production wallet and entitlement smoke checks are part of the public release. [Launch tracker](https://github.com/stacksjs/hq.support/issues/10) |
| 3. Inbox and Messenger | Private uploads, search, round-robin assignment, overflow draining, shared agent presence, reply collision handling, and customer-visible typing operate through the native app. Staging keyboard, screen reader, localized, and RTL journeys passed. [Agent collaboration](https://github.com/stacksjs/hq.support/issues/21) · [Typing](https://github.com/stacksjs/hq.support/issues/23) · [Accessibility](https://github.com/stacksjs/hq.support/issues/32) | Public first-party Messenger and the intended HQ.training and hosted Mail configurations. [Deployment](https://github.com/stacksjs/hq.support/issues/7) · [HQ.training](https://github.com/stacksjs/hq.support/issues/14) · [Hosted Mail](https://github.com/stacksjs/hq.support/issues/16) |
| 4. Email and tickets | Scoped tickets, working-hour SLA clocks, escalation, and private MIME storage pass native HTTP, SQL, and queue tests. Live SES/SNS qualified threading, attachments, replay, and suppression. Hetzner mailboxes passed external delivery in both directions and IMAP. [Email runbook](email.md) · [Mailbox verification](https://github.com/stacksjs/hq.support/issues/22) | Run wallet settlement against a finalized AWS billing export for the dedicated managed send cohort. [SES settlement](https://github.com/stacksjs/hq.support/issues/20) |
| 5. Knowledge and AI | Native pgvector and PostgreSQL full-text search preserve project scope, publication rules, and permission updates. A live Anthropic answer used retrieved sources, recorded provider token usage, recovered a rejected reservation, and handed an unrelated question to a human. [Live AI evidence](https://github.com/stacksjs/hq.support/issues/8#issuecomment-7206407882) | The launch matrix tracks each AI path, including live voice. [Launch tracker](https://github.com/stacksjs/hq.support/issues/10) |
| 6. Workflows and proactive | Published workflows have restart-tested queue checkpoints, persisted waits, idempotent actions, and scoped tool execution. Customer satisfaction settings and the Messenger feedback interface passed native browser checks. [Workflows](workflows.md) · [Customer satisfaction](customer-satisfaction.md) | External workflow delivery depends on each provider’s live qualification. [Provider qualification](https://github.com/stacksjs/hq.support/issues/8) |
| 7. Managed channels | Twilio, Slack, Meta, and Discord have HTTP, queue, receipt, replay, and storage fixtures. A private Discord channel verified actual outbound text and live attachment bytes saved to private storage. [Managed channels](managed-channels.md) · [Discord attachment evidence](https://github.com/stacksjs/hq.support/issues/8#issuecomment-7086455942) | Complete live inbound and outbound delivery, failure and revocation checks for each provider. [Provider qualification](https://github.com/stacksjs/hq.support/issues/8) |
| 8. Phone | Native voice routes, consent, transfer instructions, provider budgets, and the Realtime bridge have controlled HTTP and WebSocket evidence. The host test ran 32 simultaneous streams and verified resource limits. [Phone runbook](phone.md) · [Host qualification](https://github.com/stacksjs/hq.support/issues/11) | Live US and Canada PSTN, browser device, transfer, and OpenAI Realtime verification. [Provider qualification](https://github.com/stacksjs/hq.support/issues/8) |
| 9. Enterprise and reporting | Live Keycloak verified native OIDC and SAML sign-in, and isolated SCIM verified provisioning and deprovisioning. SQLite and PostgreSQL reconcile reply, resolution, SLA, and provider timing samples. [Enterprise runbook](enterprise.md) · [Reporting checks](https://github.com/stacksjs/hq.support/issues/5) | Release and stage the approved Cognito split-origin configuration. [Provider qualification](https://github.com/stacksjs/hq.support/issues/8) |
| 10. Native integration | Native connect grants, exact HTTPS deployment challenges, and the one-Free-workspace owner ledger pass real authentication and database tests. Buddy previews the production target, and the staging deployment uses registry-installed native packages. [Free workspace verification](free-verification.md) · [Deployment](https://github.com/stacksjs/hq.support/issues/7) | Verify the public Buddy and SDK journeys on the qualified release. [Launch tracker](https://github.com/stacksjs/hq.support/issues/10) |
| 11. Migration and release | Private Intercom bundles preserve source provenance, complete paginated transcripts, verified attachment bytes, article drafts, and restartable import checkpoints. Both databases pass native replay and incomplete source rejection. [Intercom import](intercom-import.md) · [Attachment import](https://github.com/stacksjs/hq.support/issues/15) | Rehearse an actual Intercom export with transcripts, attachment hashes, and a source-ID review inventory. [Migration qualification](https://github.com/stacksjs/hq.support/issues/5) |

## Homepage and operator dashboard

The native stx homepage opens the hosted-format Messenger from one fixed chat
bubble. The browser qualification uses compiled assets, native Stacks HTTP,
and disposable SQLite for a first-party customer message, an authenticated
agent reply, keyboard focus, and same-tab reload. It also checks help
fallback, reduced motion, and narrow viewports. The reviewed
`0.1.0-alpha.0` npm archive already passed
[public readback](https://github.com/stacksjs/hq.support/actions/runs/43630101975).
The reviewed `0.1.0-alpha.3` archive includes inline themes, typing and the
accessibility updates. Its standalone publication dry run passed.
[Publication qualification](https://github.com/stacksjs/hq.support/issues/30)

The local operator dashboard discovers the failed-job model directly from
`app/Models`. Its native model API omits payloads and exceptions and refuses
generic access to tenant conversations, contacts, workspaces, customer
sessions, and API keys. The workspace inbox remains the operator path for
scoped support records. The
[launch tracker](https://github.com/stacksjs/hq.support/issues/10) links the
remaining qualification and deployment issues.

## Retained backend evidence

The project Reports page uses a rolling 30-day cohort for Messenger and managed text
conversations.
It shows elapsed-time averages and sample counts for the first human reply,
follow-up replies, and resolution. The first reply is measured from the first
customer message. A follow-up is measured from the latest customer message to
the next human reply, once per customer turn. Resolution uses the current close
timestamp, so reopening removes the sample until the conversation closes again.
Only public messages from customers and signed-in agents enter the timing
calculation. Managed replies use the recorded provider acceptance time. It comes
from the first acknowledged submission or the matching provider receipt.
A conversation with an older acknowledged reply and no recorded acceptance time
is omitted from reply timing to keep later replies from becoming false first
replies. Resolution still uses its stored close and customer message timestamps.
All-time activity totals include every channel. The ticket SLA report shows
average working time for responses and resolutions recorded in the past 30 days.
It uses each cycle's saved policy, counting open hours without paused intervals.
Older cycles and out-of-order events with incomplete working-time records do not
contribute samples. Reopening keeps completed cycles and starts a new clock.

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
authenticated SSG browser functional evidence. The scheduled overflow worker
assigns cases waiting for an eligible agent as capacity opens. Hosted staging
also verified agent presence and reply collisions. The [team inbox
runbook](team-inboxes.md) documents the HTTP contract and routing rules.
[Staging collaboration evidence](https://github.com/stacksjs/hq.support/issues/21)

The initial integrated application passed 65 Bun tests across 27 files on
native 0.75.581, including disposable SQLite and PostgreSQL. TypeScript,
Pickier, and repeated model migration generation also passed.

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
The later combined release also passed the native application and widget suites.
[Combined CI evidence](https://github.com/stacksjs/hq.support/actions/runs/45949322392)

## Installed compiler and live channel qualification

Registry-installed stx 0.2.880 passes authored template checking across 28 files,
42 script blocks and 1,386 expressions without errors. The native application
browser runners pass 46 team/search, eight credential, 36 customer satisfaction
and 18 continuation assertions, including their strict runtime-error gates.
These initial local journeys used registry-installed native 0.75.584. The
later staging release verifies the actual hosted assets against the exact CI
manifest. [Hosted verification](https://github.com/stacksjs/hq.support/issues/7#issuecomment-7211731460)

Discord text support passed 39 live assertions in an isolated private test
channel using actual native authentication, HTTP actions, generated SQLite,
encrypted tenant credentials and the database queue worker. The single queued
reply received a real provider ID and `accepted` state, and appeared in the
native Discord client. Same-key retry, repeat polling, bot echo suppression and
internal-note privacy passed. This is an isolated live text-path qualification,
not a production deployment, recipient read receipt, or qualification of all
Discord thread/media capabilities or other providers.
