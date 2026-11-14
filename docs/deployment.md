# Deployment

HQ.support targets the shared Stacks Hetzner host through Buddy and rpx, with
its own PostgreSQL owner/database and Redis namespaces. The web and API processes
listen on loopback ports 3340 and 3348. Local development uses the same port block.

Buddy's explicit staging target has its own `hq-support-staging` release and state
directories, `hq_support_staging` database/role, Redis namespaces, ports 3350/3358,
and `staging.hq.support` / `api.staging.hq.support` hostnames. Development deploys
use a third namespace and ports 3360/3368. `APP_DOMAIN` remains the registered
base zone, `hq.support`, in every environment. The target selected by Buddy
determines these values; changing `APP_ENV` in a browser request cannot select a
deployment. `tests/deployment-config.test.ts` checks the three blueprints in
separate processes, matching actual Buddy invocations.

The shared owner currently has no staging server. Native `attachTo: 'stacks'`
requires a server labelled for that exact owner and environment; it does not fall
back to the production host. Provision and qualify the isolated staging target
before a real staging deploy. PostgreSQL must have pgvector available, and an
operator must enable it in the app-owned database before the app role runs the
generated migrations. The observed shared production PostgreSQL does not yet
have that extension available. A local pgvector test server does not qualify
the production host.

The application is under development. The production workflow requires successful
CI for the exact main commit and, for a real deploy, a complete matching
`deployment/qualification.json`. `scripts/check-launch.ts` names every required
qualification. Do not replace failed or missing evidence with claimed completion.

## Runtime namespace evidence

Each selected blueprint injects `CACHE_DRIVER=redis` and `QUEUE_DRIVER=database`
into both web and API processes. `config/cache.ts` reads `CACHE_DRIVER` and
`CACHE_PREFIX`; the configured native cache no longer stays on memory when the
blueprint selects Redis. Production keeps `hq-support:cache` / `hq-support:queue`,
staging uses `hq-support-staging:cache` / `hq-support-staging:queue`, and development
uses `hq-support-development:cache` / `hq-support-development:queue`. The replay
hint bus receives the corresponding `SUPPORT_REALTIME_NAMESPACE`, ending in
`:replay-v1`. PostgreSQL database and owner selection remains per deployment;
Redis prefixes do not isolate SQL rows.

Without deployment overrides, the configuration projects memory cache and a
database queue, with `hq-support-development:*` local prefixes. Native development
`Job.dispatch()` reads `QUEUE_DRIVER` directly and defaults to inline execution
when it is absent, even after configuration readiness. `.env.example` explicitly
selects inline queues; set `QUEUE_DRIVER=database` and run a worker for durable
local dispatch. Deployed blueprints explicitly select the database driver. Native
boot validation rejects an unknown cache driver and unsupported queue drivers; it must finish before the cache is used. No fallback
to memory or inline production jobs is an accepted deployment configuration.

Installed `@stacksjs/queue` 0.75.585 honors `connections.redis.prefix` in the
native `RedisQueue` adapter. Its separate `batch.ts` Redis store hardcodes
`stacks:batch:*` and `stacks:batches`, ignores `batching.prefix`, and chooses the
store from `QUEUE_DRIVER` rather than `batching.driver`. Database workers write
`failed_jobs` in the app database; Redis failures live under the main queue
prefix, not `failed.prefix`. The failed and batch prefixes are configured for
each environment, but that is not evidence that those native consumers honor
them. HQ deployments retain database queues and batches. Enabling native Redis
batches on shared Redis requires an upstream fix and new provider evidence;
this app does not patch installed packages or add a parallel batch store.

`tests/feature/runtime-isolation.test.ts` starts fresh processes for both sites in
all three selected environments and reads the public native configuration. A harmless public job also proves the
unconfigured local inline dispatch behavior. It also checks native boot refusals and, with `SUPPORT_TEST_REDIS_URL`, uses the
configured public cache and native Redis queue adapter across processes on the
same server. The same logical cache key and random queue name remain independent
in each environment. Cleanup deletes only those owned entries and jobs, never
flushes a database. This is Redis namespace evidence, not PostgreSQL queue-worker
or Redis-batch qualification. The full CI suite requires the real Redis service;
a local run filtered to configuration checks cannot replace that proof.

## Environment

Keep `APP_KEY`, database and Redis credentials, private storage credentials,
channel provider credentials, Stripe keys and webhook secrets encrypted using
the native environment tooling. Keep private decryption keys in GitHub environment
secrets. Never copy another application's full environment or database.

The verified Porkbun credentials can manage hq.support. Reuse them through encrypted
configuration. Snapshot the full DNS zone before cutover. The existing apex ALIAS
and wildcard CNAME require explicit reconciliation: additive DNS synchronization
does not replace existing records. Preserve unrelated NS, MX and TXT records.

## Qualification and cutover

Run the application against PostgreSQL, Redis and isolated provider test accounts.
Qualify each channel's receive, reply, retry, revocation, and delivery receipt path.
Test hosted widget assets from an ordinary third-party website. Rehearse Intercom
import, restore, rollback and load before switching provider callback URLs or DNS.

Deploy only the tested artifact. Use additive migrations, drain old workers, and
preserve the previous release. A separate supervised media process and qualified
voice worker are required before phone/voice launch. They are not provisioned by
the initial web/API-only cloud configuration.

Required final hostnames are hq.support, api.hq.support, cdn.hq.support,
help.hq.support, mail.hq.support and status.hq.support. The initial cloud config
contains only the web/API/www routes; add qualified asset, help, mail and StatusHQ
routes alongside the corresponding runtime implementation.

Backups must meet the 15-minute RPO and demonstrated four-hour RTO. A failed
shared-host voice load rehearsal requires isolated compute before launch.
