# HQ.support

Customer support built with Bun, TypeScript, Stacks, stx and ts-css. HQ.support is being built as a shared inbox, embeddable messenger, ticketing, knowledge, AI and managed communications platform.

This repository is under development. The full launch matrix has not passed. See [implementation status](docs/implementation-status.md) for retained evidence and remaining work, and [deployment](docs/deployment.md) for the release gate. Production DNS and provider cutover wait for that gate.

## Local development

Use Bun 1.4.4. SQLite development requires SQLite 3.47.2 or newer. Start from the committed lockfile:

```sh
bun install --frozen-lockfile
cp .env.example .env
./buddy key:generate
./buddy migrate
bun scripts/build-support-elements.ts
./buddy dev
```

Keep `.env` and `.env.keys` private. The example environment has no usable provider credentials. Configure providers explicitly to enable their capabilities; missing configuration does not simulate delivery or payment.

For uncapped core self-hosting, set the operator-only `SUPPORT_DEPLOYMENT_MODE=selfhost` before creating workspaces. Existing workspace plans remain explicit. [Self-hosting](docs/self-hosting.md) describes enterprise licensing and the current managed-wallet requirements for paid providers.

## Verification

Build the widget before running tests that verify its emitted artifacts:

```sh
bun scripts/build-support-elements.ts
./buddy lint
./buddy typecheck
./buddy test
./buddy build:views
```

The HTTP suites use native authentication, model-generated migrations, SQL transactions and disposable databases. External provider boundaries use deterministic fixtures. Set `STACKS_TEST_POSTGRES_URL` to a test administrator connection to run the PostgreSQL cases; the harness creates and removes its own random databases. Without it, PostgreSQL cases are explicitly skipped. The test server needs the pgvector extension available; CI uses the pinned pgvector/PostgreSQL 17 image. Never point tests at a production database.

Live provider qualification, accessibility, load, restore and rollback acceptance are separate from deterministic tests. Neither a green fixture suite nor a successful build grants public launch readiness.

## Native Stacks integration

Connected Stacks applications use the opt-in `@stacksjs/support` server/browser facades and Buddy's `hq:connect supporthq`, `support:install`, `support:doctor`, `support:sync-docs` and `support:import intercom` commands. Customer identity comes from authenticated server context. Integration keys are server-only. Installing Stacks does not send customer information automatically.

Verified Stacks installations qualify for one permanent Free workspace per owning account: two agents, 100 monthly conversations with a 20% admission grace, ten hosted text AI conversations, and 300 MB of attachments. Managed paid channels require a funded wallet. [Free eligibility](docs/free-verification.md) and [billing](docs/billing.md) describe the exact rules.

## Project layout

| Path | Responsibility |
| --- | --- |
| `app/Models/`, `database/migrations/` | Native model schema and generated SQLite/PostgreSQL migrations |
| `app/Actions/Support/`, `app/Support/` | Authorized HTTP actions and support domain behavior |
| `app/Jobs/`, `app/Scheduler.ts` | Durable delivery, indexing, workflow and recovery work |
| `resources/views/`, `resources/functions/support/` | Native stx agent workspace |
| `resources/components/support/` | Five stx-authored customer web components |
| `enterprise/` | Commercial identity and governance modules |
| `tests/feature/`, `tests/fixtures/` | Actual HTTP/database and provider-shaped qualification |
| `docs/` | Contracts, installation, operational limits and implementation evidence |

The agent application is native stx. `buddy build:web-components` compiles the customer elements; `scripts/build-support-elements.ts` adds immutable, content-addressed browser publication and a lazy loader. Ordinary websites can use these elements without Stacks globals.

## License

The core is [MIT licensed](LICENSE). The `enterprise/` directory has its [separate commercial license](enterprise/LICENSE.txt). A core self-hosted installation has no hosted seat or conversation caps. Provider usage and infrastructure remain the operator's responsibility.
