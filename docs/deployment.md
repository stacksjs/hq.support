# Deployment

HQ.support targets the shared Stacks Hetzner host through Buddy and rpx, with
its own PostgreSQL owner/database and Redis namespaces. The web and API processes
listen on loopback ports 3340 and 3348. Local development uses the same port block.

The application is under development. The production workflow requires successful
CI for the exact main commit and, for a real deploy, a complete matching
`deployment/qualification.json`. `scripts/check-launch.ts` names every required
qualification. Do not replace failed or missing evidence with claimed completion.

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
