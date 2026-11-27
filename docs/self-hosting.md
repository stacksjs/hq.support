# Self-hosted MIT core

HQ.support defaults to hosted mode. An operator can explicitly select
self-hosted core through the server's validated environment configuration:

```dotenv
SUPPORT_DEPLOYMENT_MODE=selfhost
```

The supported values are `hosted` and `selfhost`. The native declaration is in
`config/env.ts`; the application setting is in `config/support.ts`. Use your
deployment secret/environment manager, or the native Buddy environment command
for the intended environment:

```sh
./buddy env:set SUPPORT_DEPLOYMENT_MODE selfhost
./buddy env:check
```

Restart the API, queue workers and scheduler with the same configuration. Set
this before creating the installation's first workspace. New workspace rows
receive `plan: selfhost` and `trial_ends_at: 0` through normal native onboarding
and HQ provisioning, with no database edit. Browser workspace payloads cannot
select a plan, deployment mode, allowance or prepaid balance. Missing mode
retains the hosted 14-day trial and its hosted limits.

This setting affects new workspace creation. It does not rewrite existing
hosted workspaces, migrate their contents, cancel existing subscriptions or
change installation licenses. Existing data can be migrated into a newly
created self-hosted workspace through the qualified import flows. Manage any
existing external billing agreement separately before rehoming an installation.

## Core limits and reporting

Self-hosted core has no hosted seat, project, new-conversation, monthly AI-unit,
attachment-storage or per-file catalog allowance. Separate monthly indexing
and copilot catalog budgets are also uncapped. These limits are represented as
JSON `null`, not zero or a fabricated large integer. Usage continues to be
recorded and reported through the workspace billing/usage API and native HQ
read-key usage contract. The usage UI displays null counts and bytes as
Unlimited, with a self-hosted installation explanation.

Native protocol, resource and provider boundaries still apply: authentication,
tenant isolation, request sizes, bounded queries, per-request AI token bounds,
twenty-turn/token AI-unit boundaries, workflow safety bounds, provider windows,
consent and actual private-storage availability. Uncapped catalog limits do not
claim infinite hardware capacity or bypass a provider's requirements.

Hosted subscription checkout and the hosted billing portal are disabled in
self-hosted deployment mode, including when Stripe is configured for the local
wallet. The backend rejects direct hosted-checkout attempts before contacting
Stripe; hiding the UI is not the enforcement mechanism. The overview explains
the deployment mode instead of falsely blaming missing payment configuration.

## Providers, money and remaining BYO behavior

Operators provide and operate their own infrastructure and configured provider
accounts. Compute, database/vector storage, file storage, backups, TLS, network
egress, email, AI, telephony and messaging can incur external costs. A native
adapter's presence is not a live delivery qualification. Provider registrations,
verified sender identities, permissions, credentials and operational workers
remain necessary. Native AI uses the explicitly configured provider; this flag
does not manufacture an API key or a successful response.

**Current paid messaging/voice orchestration still uses the local managed
wallet, even with operator-supplied provider credentials.** Direct BYO paid
channel dispatch without that wallet is not implemented by this mode. It does
not claim otherwise or add artificial credit to make a channel appear ready.
The existing exact provider-cost accounting/managed markup, signed payment
validation, prepaid reservations and positive UTC daily/monthly spending
ceilings remain enforced. A zero ceiling still pauses new paid work. Preparing
checkout does not fund the wallet; credit requires a verified payment event.
Owners and admins can apply lower paid messaging and voice ceilings to
individual projects in Usage and credit.

If the operator needs a wallet-free direct BYO paid-channel policy, that is a
separate provider/billing integration requiring its own authorization, cost and
recovery design. This implementation deliberately does not relabel the current
managed path as direct BYO.

## Commercial Enterprise

MIT self-hosted core does not grant commercial identity, SCIM, audit or retention
features. The existing signed installation/workspace Enterprise license checks
remain unchanged. A self-hosted workspace has plan `selfhost`, not the paid
hosted `enterprise` plan. Configuring a deployment flag or submitting a browser
plan field cannot create that entitlement.

## Retained evidence

`tests/feature/selfhost-http.test.ts` runs four installed-package cases: default
hosted and explicit selfhost, each on disposable SQLite and PostgreSQL. It
crosses real native auth, HTTP, model-generated migrations, SQL transactions,
Storage and Stripe webhook verification. It verifies:

- Forged browser plan/mode/balance fields are ignored; hosted defaults and trial
  expiry remain enforced.
- New selfhost workspaces admit more than 50 pending seats, more than 120 new
  conversations and an eleventh AI monthly reservation, while preserving real
  usage and null catalog/HQ limits. AI reservation tests prove admission policy,
  not fabricated provider completions.
- A small real private file crosses a seeded 100 GB quota-counter boundary.
  This is accounting/admission evidence, not a 100 GB filesystem/load test.
- Commercial licenses remain missing/refused; configured Stripe cannot enable
  hosted subscriptions in selfhost mode.
- Missing funds, invalid payment signatures, disabled spending ceilings and a
  reached daily limit still refuse paid reservations. Only the external checkout
  creation boundary is a fixture; native signature checks and the wallet ledger
  are real.

Run with published dependencies and an owned vector-capable PostgreSQL server:

```sh
STACKS_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55439/postgres \
  ./buddy test tests/feature/selfhost-http.test.ts
```

No model or migration changes are required for this deployment setting.
