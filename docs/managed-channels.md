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
contentVariables? }`. The normal inbox public agent reply route delegates to
this orchestration automatically for channel-backed conversations. Internal
notes stay internal. Responses include the stored message and a durable
`delivery` with its status, opaque ID and any acknowledged provider message ID.
HTTP 201 means queued/stored, not recipient delivery.

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
prepaid balance available. Final settlement uses the exact provider decimal
price in USD microdollars, applies the 15% margin, and rounds cents once. An
absent price stays `cost_pending`; it is never treated as a free send.
Encrypted original credentials permit read-only settlement after rotation.

STOP/START consent is persisted per workspace/project/channel/recipient,
independent of conversation admission. Native keyword/Advanced Opt-Out parsing
is reused. A stale START cannot undo a later STOP. One tenant's consent record
does not reveal or modify another tenant's consent. The provider may separately
enforce its account/sender-level opt-out policy.

Authenticated incoming payloads are durably retained before conversation
allowance checks. Contacts use channel-scoped provider identity, never email
matching or native user creation. Effects and the processed checkpoint commit
together; retries do not duplicate the first message. Overflow remains pending
and resumes when allowance returns. Discord advances its cursor only after a
whole page is retained, ignores its own bot messages, and keeps separate
customer identities.

Run the native database worker for queue `support-channels` and the native
scheduler. RunChannelDelivery dispatches queued operations and periodically
recovers pending ingress, uncertain expired leases, quoted costs and Discord
polls. Unknown sends without a signed receipt stay held for operator review.

## Qualification and remaining work

`tests/feature/channels-http.test.ts` runs native auth, migrations, SQL,
wallet/queue persistence and actual local HTTP provider protocols against both
SQLite and PostgreSQL. It verifies encrypted credentials, stale probes,
rotation, idempotency, lost acknowledgements and callbacks, a fresh-process
crash hold, exact fractional billing, scoped consent, allowance overflow,
WhatsApp approval/windows, signed Slack events and Discord cursor recovery.

Current provider media sends are explicitly refused. Signed inbound media
provenance remains durable/pending; it is not represented as a successfully
stored attachment. Private provider-media ingestion/delivery and live provider
account qualification remain required before advertising full media support.
Slack/Discord bot installation, Twilio/WhatsApp onboarding, Meta app review,
email sender/inbound configuration, and actual live delivery have not been
inferred from fixtures. The framework native SMS/chat additions must be
installed from their published release before installed-package qualification.
