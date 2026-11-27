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

Staging owns its Hetzner host so load and rollback rehearsals are isolated from
the production tenant. Provision the host before publishing staging DNS. Check
that pgvector is available on the running PostgreSQL installation and enable it
only in the app database before starting the generated migrations. On the shared
production host, recheck pgvector whenever the Pantry PostgreSQL version changes.

The read-only GitHub Deploy preview runs Buddy without SSH or provider credentials.
A real production deploy requires successful CI for the exact main commit and a
matching qualification report. Store the reviewed JSON in the production
environment's `SUPPORT_LAUNCH_QUALIFICATION` secret after the commit has been
qualified. Local verification also accepts `deployment/qualification.json`.
`scripts/check-launch.ts` names every required qualification. The report is
maintained outside the commit it names.

The production environment supplies `HCLOUD_TOKEN` for the Hetzner project
that owns the running `stacks` host, `DEPLOY_SSH_KEY` for SSH to that host,
and `DOTENV_PRIVATE_KEY_PRODUCTION` for this repository's encrypted
configuration. The production workflow downloads the reviewed widget assets
from the successful same-commit CI run and verifies their hashes before
building the views.

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

## Mail

`config/email.ts` attaches the production mail tenant to the existing Stacks
Hetzner server. Buddy reconciles the full-address mailboxes, the domain's DKIM
signer, the mail certificate and the mail DNS records during production deploy.
Staging and development skip mail reconciliation.

The Bun lockfile pins the published Stacks 0.75.701 archives from Pantry.
Install with `bun install --frozen-lockfile` before running Buddy.

Use the same native reconcile to set up the mail tenant before launching the
website. Run `APP_ENV=production ./buddy mail:provision --ip <verified-stacks-ip> --dry-run`
to review the target first. The operator provides each `MAIL_PASSWORD_<LOCALPART>`
through the encrypted production environment. Keep plaintext credentials out of Git. Human mailboxes
require the owner to set a new password in HTTPS webmail before signing in or
connecting a mail client. Later deploys preserve the new password. The application
uses a managed credential for `hello@hq.support`. For production submission, configure
`MAIL_MAILER=smtp`, `MAIL_HOST=mail.hq.support`, `MAIL_PORT=587`,
`MAIL_ENCRYPTION=tls`, `MAIL_FROM_ADDRESS=hello@hq.support`,
`MAIL_USERNAME=hello@hq.support` and the corresponding
`MAIL_PASSWORD` through the encrypted production environment.

## Homepage chat

Use a dedicated first-party workspace project and assign the team monitoring the
inbox. Enable anonymous Messenger sessions and allow the exact public origin
`https://hq.support`. Set the project's public UUID as
`SUPPORT_SITE_MESSENGER_PROJECT_ID` in the production environment's Actions
variables or the deployment environment file. The homepage bubble
loads the versioned build served through `/support.js` when a visitor opens it.
The site uses tab-scoped storage to resume the anonymous conversation. The
inbox receives those messages through the standard customer API.

The production deployment workflow verifies the HTTPS homepage, the loader's
bytes and the Messenger project configuration. Complete the public send and
reply journey after cutover using the dedicated project and a clearly marked
test conversation.

### Inline Messenger appearance

Mount the loader with `createSupport({ container, inline: true })` and set
custom properties on the container in the host stylesheet. The properties
inherit across the widget's shadow roots. The same stylesheet can provide
different values in light and dark appearance. Unset properties use the
Messenger defaults.

| Custom properties | Where they apply |
| --- | --- |
| `--hq-support-font-family`, `--hq-support-text`, `--hq-support-muted` | Text family, main text, and secondary text |
| `--hq-support-accent`, `--hq-support-accent-text`, `--hq-support-highlight`, `--hq-support-focus` | Primary action fill and text, secondary accents, and keyboard focus |
| `--hq-support-surface`, `--hq-support-secondary-surface`, `--hq-support-input-surface` | Outer panel, alternate surfaces, and controls |
| `--hq-support-border`, `--hq-support-control-border`, `--hq-support-radius`, `--hq-support-shadow` | Divider and panel borders, control outlines, panel radius, and shadow |
| `--hq-support-control-height`, `--hq-support-heading-margin`, `--hq-support-panel-padding` | Close and Send target size, heading margin, and section padding |
| `--hq-support-inline-width`, `--hq-support-inline-max-height` | Set to `100%` and `none` to size the Messenger to the host and let the page scroll |
| `--hq-support-inline-intro-display`, `--hq-support-inline-history-min-height` | Set to `none` and `0px` for a compact composer. Conversation history appears when messages arrive and can scroll independently. |

Check label, action, and focus contrast in every host theme. The layout properties
with the `inline` prefix apply only to inline mounts.

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

### Production recovery

The Stacks `stacks-project-recovery@hq_support.timer` snapshots PostgreSQL and
the web and API `shared/storage/app` directories every five minutes. AWS and
Hetzner use separate project repositories. Each recovery receipt records when
capture started and when the remote database archive was verified. The
`stacks-project-recovery-check@hq_support.timer` checks both receipts every
minute and alerts if either recovery point is older than 15 minutes.

On the production host, run `stacks-project-recovery check hq_support` to inspect
freshness and `stacks-project-recovery drill hq_support` to restore into disposable
PostgreSQL instances and verify both persistent file trees. The drill uses its
own lock and status file, so the five-minute backup can continue during restore.
The shared daily host backup uses separate snapshots and retention.

Buddy rollback requires recorded service definitions for both releases when a
site has background workers. Keep two successful deployments with the updated
cloud driver before rehearsing rollback. Verify the web, API, each queue worker
and the scheduler are running the intended release at each step of the rehearsal.
