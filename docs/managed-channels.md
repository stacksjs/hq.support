# Managed text channels

Connections use native encrypted credentials and native database models. A saved
connection is `pending`; owner/admin verification probes the actual provider
account and exact configured sender/channel. A successful probe verifies those
specific facts, not live customer delivery, app review, or regulatory approval.
Live accounts and recipient delivery still need launch qualification.

| Provider | Current implemented path | Required account configuration |
| --- | --- | --- |
| SMS | Native Twilio SMS, US/Canada recipients, exact owned number and routing probe | Account SID/token, owned number SID, country, exact POST SMS webhook, no overriding SMS Application SID |
| WhatsApp | Native Twilio Messages API, ONLINE sender probe, session text and approved Content SID templates | Twilio WhatsApp Sender SID, `whatsapp:+…` sender, exact incoming webhook, approved templates outside the customer service window |
| Slack | Native instance-scoped bot driver, team/room membership probe, signed Events API ingress | Bot token, signing secret, team ID, channel ID; enable the provider's Events API subscriptions |
| Discord | Native instance-scoped bot driver and native bot inbox pagination | Bot token and exact text channel; required message-content intent/permissions; user self-bot tokens are not supported |
| Messenger / Instagram | Native scoped Meta text client and signed account-bound ingress | Explicit Graph version, account/token, app secret and verify token; provider app review/subscription and recipient permissions |
| Email | Provider extension point shared with the SES implementation | A qualified native email adapter must register before this channel can verify or send |

WhatsApp initially uses Twilio. The framework's additional Meta Cloud client does
not change that selection. The app enforces a 24-hour free-form reply window
from account-authenticated provider message creation time. A template send
checks current account-bound approval and uses ContentSid/ContentVariables,
without mixing Body/MediaUrl. [Twilio reply windows](https://www.twilio.com/docs/whatsapp/key-concepts),
[template approval API](https://www.twilio.com/docs/content/content-api-resources),
and [compatible content fields](https://www.twilio.com/docs/api/errors/63030).

## Native HTTP surface

All workspace endpoints require native authentication; mutations retain native
CSRF protection. Secrets are write-only and excluded from channel/delivery
responses. Only owner/admin may save, verify, disable or manually reconcile.
Active agents can reply to their project conversations.

- `GET/POST /api/support/projects/{project}/channels`
- `POST /api/support/projects/{project}/channels/{channel}` (replace configuration)
- `POST /api/support/projects/{project}/channels/{channel}/verify`
- `POST /api/support/projects/{project}/channels/{channel}/disable`
- `POST /api/support/projects/{project}/channels/{channel}/poll` (Discord)
- `GET /api/support/projects/{project}/channel-deliveries[/{delivery}]`
- `POST /api/support/projects/{project}/channel-deliveries/{delivery}/reconcile`
- `POST /api/support/projects/{project}/channel-conversations/{conversation}/messages`

Reply input is `{ body, idempotencyKey, visibility?: 'public', contentSid?,
contentVariables?, attachmentIds? }`. A scoped image may have an empty body. The normal inbox public agent reply route delegates to
this orchestration automatically for channel-backed conversations. Internal
notes stay internal. Responses include the stored message and a durable
`delivery` with its status, opaque ID and any acknowledged provider message ID.
HTTP 201 means queued/stored, not recipient delivery.

Agent uploads start private. Customer metadata/downloads include only explicitly
public files or that customer’s own uploads. Internal notes never publish files.
A public inbox reply publishes its selected stored `attachmentIds`; a managed
channel reply publishes them only after provider acceptance. Provider-signed
media capabilities can fetch the selected private image during dispatch without
making other thread files public. Both stored length and SHA-256 are verified
when files are downloaded.

Provider callbacks use:

- `POST /api/channels/{publicId}/incoming`
- `GET /api/channels/{publicId}/incoming` (Meta verification challenge)
- `POST /api/channels/{publicId}/deliveries/{delivery}/status` (Twilio)

Twilio signatures bind the canonical public HTTPS URL, all original form fields
and the configured account. The app fetches the message from that account and
matches sender, destination and body before opening a reply window. Slack uses
its original raw body, signing secret and five-minute timestamp check. Meta
uses raw-body HMAC and exact account/recipient matching. Configure the actual
public HTTPS URL, including `/api`; forwarded client Host headers are not used
to decide what URL was signed. Discord receives messages by authenticated
native REST polling with a persisted cursor, not an invented message webhook.

## Durability, money and recovery

ChannelDelivery owns one idempotent operation, message, encrypted original
credential snapshot and optional wallet reservation. A request fingerprint
rejects changed input under the same key. Dispatch ownership is committed
before HTTP. A crash, timeout, malformed acknowledgement or 5xx response leaves
the operation `unknown`; a worker never blindly sends it again. A signed
callback can bind the lost provider SID to that exact opaque operation.
Definitive provider rejection releases the reservation. Provider acceptance
and recipient delivery remain distinct states.

`SUPPORT_MESSAGING_PRICING` is server-only JSON keyed by Twilio Account SID:
`{ "AC…": { "smsMaxMicrosPerSegment": 20000, "whatsappMaxMicros": 100000 } }`.
These are operator-supplied conservative USD cost ceilings, **not verified
current provider prices or recommended rates**. Missing/zero ceilings disable
paid dispatch. SMS reservations use worst-case UCS-2 segmentation; provider
usage is authoritative. Both native workspace wallet caps must be positive and
prepaid balance available. Owners and admins can set additional UTC daily and
monthly ceilings for each project in Usage and credit. A blank field uses the
workspace ceiling. Zero pauses new paid operations for the selected project.
Project totals include reserved and settled costs. Older wallet entries with
no recorded project count toward a capped project's limit until their UTC
period ends. Final settlement uses the exact provider decimal
price in USD microdollars, applies the 15% margin, and rounds cents once. An
absent price stays `cost_pending`; it is never treated as a free send.
Encrypted original credentials permit read-only settlement after rotation.
Automatic recovery polls due receipts oldest first and defers each attempted
receipt by one minute before contacting the provider. This leaves room for
newer receipts when older prices are still missing. Authorized manual
reconciliation can still check a specific delivery immediately.

STOP/START consent is persisted per workspace/project/channel/recipient,
independent of conversation admission. Native keyword/Advanced Opt-Out parsing
is reused. A stale START cannot undo a later STOP. One tenant's consent record
does not reveal or modify another tenant's consent. The provider may separately
enforce its account/sender-level opt-out policy.

Authenticated incoming payloads are durably retained before conversation
allowance checks. Contacts use channel-scoped provider identity, never email
matching or native user creation. SQL admission is idempotent; media work has a separate durable checkpoint,
and the source is marked processed only after private files finish. Retries
do not duplicate the first message. Overflow remains pending
and resumes when allowance returns. Discord advances its cursor only after a
whole page is retained, ignores its own bot messages, and keeps separate
customer identities.

Run the native database worker for queue `support-channels` and the native
scheduler. RunChannelDelivery dispatches queued operations and periodically
recovers pending ingress, uncertain expired leases, quoted costs and Discord
polls. Discord polls the oldest eligible cursor first in batches of up to 100.
Failed attempts retain their cursor and become eligible after the lease expires.
Unknown sends without a signed receipt stay held for operator review.

A verified Discord connection keeps its room. Rotate the bot token on that
connection and verify it again to retain the inbox cursor. Create a separate
connection for a different room. Queued replies recheck their original room
before submitting to Discord.

## Qualification and remaining work

On 2026-11-14 the Discord text path passed 39 live assertions in an isolated
private operator test channel. The test used registry-installed native
0.75.584, stx 0.2.880, actual authentication/HTTP actions, generated SQLite,
encrypted tenant credentials and the native database queue worker. It admitted
one real user message and sent one queued bot reply. Discord acknowledged a
provider message ID with `accepted` state, and the reply was independently
observed through its API and native client. Same-key retry created no duplicate;
repeat polling and bot echo admitted no additional conversation; the internal
note remained private. Credentials and the detailed report stay in private
operator configuration. No live credentials enter CI.

This qualifies that isolated text path. Production supervision, database
deployment, broader Discord thread/media behavior and the remaining live
providers retain their own acceptance gates. Provider acceptance does not prove
a recipient read the message.

`tests/feature/channels-http.test.ts` runs native auth, migrations, SQL,
wallet/queue persistence and actual local HTTP provider protocols against both
SQLite and PostgreSQL. It verifies encrypted credentials, stale probes,
rotation, idempotency, lost acknowledgements and callbacks, a fresh-process
crash hold, exact fractional billing, scoped consent, allowance overflow,
WhatsApp approval/windows, signed Slack events and Discord cursor recovery.

Outbound SMS/WhatsApp accepts one scoped `attachmentIds` JPEG/PNG image, with
verified stored bytes/checksum and a combined media+text cap below 5 MB. SMS
images require the additional server `mmsMaxMicros` pricing ceiling. The native
provider fetches it through a 15-minute signed storage capability bound to the
exact operation and attachment; unsigned, expired or substituted paths fail.
GET and HEAD serve the verified MIME type and length. Arbitrary public media
URLs and incompatible template/image combinations are refused.

Inbound provider media uses strict provider host/account/message paths and
native pinned public HTTPS with bounded bytes and redirects. Credentials are
removed by the native fetcher on an origin change. Native private Storage and
the existing attachment service enforce actual bytes, per-file and aggregate
quotas. SQL admission has a persisted idempotent result before filesystem work,
so retrying a failed download/upload does not create another message or charge
storage twice. Media-only messages keep an empty original body. Conversation
detail exposes stored private attachment metadata; downloads remain authorized.
Unsupported source URLs/counts, exhausted storage, or incomplete downloads keep
the original source pending. Full provider media types beyond the implemented
JPEG/PNG outbound path and live provider media delivery still need qualification.
See [Twilio media validation and MIME rules](https://www.twilio.com/docs/messaging/guides/accepted-mime-types).
Slack/Discord bot installation, Twilio/WhatsApp onboarding, Meta app review,
email sender/inbound configuration, and actual live delivery have not been
inferred from fixtures. The framework native SMS/chat additions must be
installed from their published release before installed-package qualification.
