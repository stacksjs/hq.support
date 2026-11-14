# Durable support workflows

Workflows execute from immutable published versions. Saving a draft changes the next publication, while active runs continue on their original version. Owner/admin membership is required to create, edit, publish or pause a workflow. Pausing stops new admissions; it does not discard existing runs.

Use the authenticated `/api/support/projects/{project}/automations` API to list/create drafts. `POST /automations/{id}/draft` saves `{definition,name?,event?}`. `POST /automations/{id}/publish` validates and freezes the next version. `POST /automations/{id}/pause` stops admissions. `/automation-runs` and `/automation-runs/{id}` expose scoped status and persisted step results. The legacy `/workflows` list/create API uses the same engine.

A definition is `{start,nodes}`. Each node has an `id`, `type`, and optional `next`. Supported steps:

- `condition`: `field`, `operator`, `value?`, `yes`, `no`. Fields read `contact`, `event`, or `conversation`; operators are `eq`, `neq`, `contains`, `exists`, `gt`, `lt`.
- `wait`: `seconds`, then `next`. The deadline persists in SQL. Workers can stop and restart during a wait.
- `assign`: a real workspace member's `userId`.
- `tag`: a bounded contact `tag`.
- `reply` or `note`: public or internal `body`. Only known scalar placeholders such as `{{contact.name}}` interpolate; there is no template code execution.
- `ticket`: `title`, optional `description` and `priority`.
- `status`: `open`, `closed`, or `snoozed` on the current contact-owned conversation.
- `tool`: only `contact.set_attribute` or `contact.remove_attribute`, with a bounded custom `key` and optional JSON `value`. Arbitrary code, shell commands, remote URLs and provider calls are not internal tools.
- `start_conversation`: proactive `subject` and `body`. It uses the same exact hosted allowance admission as the SDK and saves the new conversation in the run context.
- `end`: finishes a branch.

Custom events accepted by the server SDK trigger matching published workflows. Native `conversation.created` and `ticket.created` outbox events also admit runs. A source delivery UUID and the workflow/event identity prevent duplicate admission. A trigger can run up to 20 published workflows, checked when publishing. Definitions are acyclic, have at most 50 nodes, and every node must be reachable. Runs have a 100-step bound, waits are at most 30 days, and automatic event chains stop admitting more runs at depth four. These are operational bounds, not purchasable SaaS overages.

Each step effect, cursor transition, unique execution marker, and follow-up native queue intent commits together through the native Stacks database transaction context. Replies and proactive openers also carry deterministic idempotency keys. Effects that need an external channel remain durable outbox work until a configured adapter returns a real receipt. An internal workflow dispatch receipt records internal scheduling only; it does not claim a customer email or SMS was delivered.

A hosted quota refusal leaves the run `blocked`, preserves the event and rolls back its effect. Once capacity returns, the recovery sweep retries it. Invalid permanent context produces a visible failed run. Infrastructure errors leave work retryable. Expired run ownership leases can be recovered by another worker.

## Running workers

The application uses the native persistent database queue by default. Run `./buddy queue:work --queue support-workflows` for continuations and `./buddy schedule` for the native scheduled recovery job. The `RunSupportWorkflows` job sweeps once per minute. `./buddy support:work --limit 50` runs one recovery batch for an operator or a supervisor timer. Configure and supervise these processes before enabling production workflows. Redis queues remain available through native Stacks configuration.

`tests/feature/workflows-http.test.ts` uses actual HTTP, native auth, disposable SQLite/PostgreSQL databases and the real native database queue processor in fresh Bun processes. It verifies version freezing, both condition branches, assignment/tagging, private notes and public replies, single ticket creation, persisted waits, early restart refusal, concurrent retries, expired lease recovery, exact proactive quotas, blocked overflow recovery, and the allowlisted contact tool. No external delivery success is mocked into production code.
