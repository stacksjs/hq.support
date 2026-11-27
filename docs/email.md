# Support email adapter

This app slice connects native SES MIME sending and signed SNS/S3 receiving to the existing workspace channel journal, private attachments, wallet reservations and native database queues. It has deterministic HTTP/SQL/MIME/signature fixture evidence. Live AWS delivery, DNS, receipt rules, subscription confirmation and invoice reconciliation are not qualified by those fixtures. No test sends real email or provisions infrastructure.

## Operator configuration

`SUPPORT_EMAIL_POLICIES` is server-owned JSON keyed by workspace numeric ID. Each policy requires:

```json
{
  "1": {
    "region": "us-east-1",
    "accountId": "123456789012",
    "topicArn": "arn:aws:sns:us-east-1:123456789012:hq-support-email",
    "bucket": "private-support-email",
    "prefix": "incoming/",
    "fromAddresses": ["support@owned.example.com"],
    "inboundAddresses": ["inbox@owned.example.com"],
    "replyDomain": "reply.example.com",
    "maxMicrosPerMessage": 1000,
    "rateVersion": "operator-qualified-ceiling-v1"
  }
}
```

The monetary example is a fixture-style placeholder, not an SES price quote. Configure an operator-reviewed maximum USD microdollar reserve and immutable rate version. Each exact From and inbound address belongs to one workspace; overlapping policy addresses are refused. Global SES domain verification alone grants no workspace permission. Shared `hq.support` addresses also require explicit workspace allocation through these lists. Tenant channel configuration contains only selected `fromAddress` and `inboundAddress`, stored with the existing encrypted Channel configuration. It cannot select AWS credentials, topic, bucket or rate.

Set explicit server credentials `SUPPORT_EMAIL_AWS_ACCESS_KEY_ID`, `SUPPORT_EMAIL_AWS_SECRET_ACCESS_KEY` and optional `SUPPORT_EMAIL_AWS_SESSION_TOKEN`. There is no ambient profile/instance-credential fallback. The probe reads STS caller identity and requires the exact operator account, a successful DKIM-enabled SES domain identity and all four S3 public-access-block flags. Sender ownership and server policy are checked again before delivery. Store the archive on a private disk using `SUPPORT_EMAIL_ARCHIVE_DISK` (otherwise the existing private support/default disk). Archive disks must be private local storage or canonical AWS S3. Local archives are written inside a verified private directory and the completed file is made private. S3 archives require all four public-access blocks before writing; object visibility is checked afterward without depending on legacy S3 ACL writes. Public disks and unqualified adapters are refused.

`SUPPORT_EMAIL_REPLY_KEY` must contain at least 32 secret characters. Reply addresses expire after 30 days. Rotation invalidates older reply capabilities; this version has no key-ring overlap. DNS, receipt rules and wildcard recipient routing for the reply domain require operator setup. Use server-side S3 encryption and least-privilege IAM; SES client-side encrypted S3 message decryption is not implemented. Configure source bucket immutability/versioning and lifecycle explicitly.

Default missing configuration returns 503 on email feature use and leaves the core API available. Existing generic channel save/verify/disable APIs apply. Probe readiness means account/sender/storage checks passed. It is not evidence of live mailbox delivery or inbound receipt-rule/DNS correctness.

## Receipt intake and private MIME

`POST /api/email/channels/{channelPublicId}/incoming` accepts the original JSON SNS envelope, including SNS's normal `text/plain` HTTP content type. Native signature verification supports SNS signature versions 1 and 2. Before fetching a certificate, the adapter requires the exact operator topic ARN/account/region and a canonical HTTPS certificate URL on that region's SNS host with the expected PEM path, no credentials, port, query, fragment or redirects. Production certificate fetch uses native public-address/DNS-pinned HTTPS with a 32 KiB limit. Subscription confirmation is an explicit operator step; the app never follows arbitrary `SubscribeURL` links automatically. AWS describes the signed fields and certificate checks in its [SNS verification guide](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html).

Only signed SES `Received` notifications from the configured S3 action are accepted. Bucket, topic and exact `prefix + SES messageId` key must match. Routing uses signed `mail.destination`, never MIME To/CC headers. The signed notification and encrypted channel snapshot are committed with a native `RunSupportEmail` job before returning 202. `(channel_id, ses_message_id)` deduplicates replay, and changed content under the same identity is refused. A database or queue failure is not acknowledged as accepted.

The `support-email` database worker reads the private S3 object through native signed AWS requests, streams at most 8 MiB, and archives raw bytes with SHA-256 and exact byte count before parsing or inbox admission. Retries verify the retained archive. Native `parseInboundEmail` supplies bounded MIME parsing, binary attachments and sanitized names. This slice accepts up to ten attachments, a 200-character subject and 20000-character plain-text body. HTML is retained in raw MIME but never rendered. HTML-only messages without a supported plain-text body or attachments are quarantined. Oversize sources retain their signed receipt/source pointer but are not copied beyond the size limit.

Virus, spam, SPF, DKIM and DMARC verdicts must all be `PASS`; missing, unverified or failed verdicts quarantine the raw archive. The parsed MIME From must match SNS-signed `mail.commonHeaders.from`. The SMTP envelope source can legitimately be a different bounce address and is retained as provenance rather than used for thread identity. [AWS documents these SES receipt and mail fields](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html).

A new email to a configured inbox gets a new opaque contact and thread even if the address has appeared before. Addresses, MIME Message-ID, References and In-Reply-To are never used to merge identity/history. A reply route contains an HMAC binding workspace, project, channel, existing thread, expected From and expiry. Only that route and exact authenticated From can append to existing history. Invalid/expired/stolen routes quarantine the source instead of falling back to another thread. Private attachments are rederived from the checksum-verified raw MIME and checked against opaque source descriptors before scoped native upload. No source URLs come from customer input.

Owner/admin `GET /api/support/projects/{project}/email-receipts` returns bounded receipt status metadata. It excludes notification payload, raw keys, MIME and credentials. Quarantine review/release and raw-source export UI/API are not implemented. Signed receipts, raw MIME and quarantine records are retained; the existing conversation text retention policy does not erase them. Apply a separate reviewed lifecycle/legal-hold/erasure policy before production retention claims.

## Outbound acceptance, cost and uncertainty

Replies use the existing durable ChannelDelivery journal and SQL wallet reservation before any provider call. Native `buildMimeMessage` creates the RFC wire message with a single recipient, scoped From, plain text and signed Reply-To. SES receives one native `AWSClient.request` with `maxRetries: 0`, per-request `retries: 0` and a 15-second deadline. It uses `SendRawEmail` directly because the higher-level client's default retries can repeat an ambiguous POST. Only an actual `SendRawEmailResult.MessageId` is acceptance evidence. AWS acceptance is not recipient delivery; see the [SendRawEmail API](https://docs.aws.amazon.com/ses/latest/APIReference/API_SendRawEmail.html).

A timeout, 5xx or malformed acknowledgement becomes durable `unknown`. Workers and same-key request replays do not resend it. Confirmed 4xx rejection releases the reservation. Known acceptance records the provider message ID and remains `cost_pending`: SES does not return a per-message actual charge. No estimated price is relabeled as an actual provider cost, and no wallet hold is released without cost evidence. Invoice allocation/qualified exact settlement integration and operator resolution of uncertain sends remain unimplemented. An explicitly new operation key is a new user intent; operators must not use fresh keys to retry an uncertain message.

The app reuses the native `EmailSuppression` schema and `isSuppressed` lookup, with no generated unscoped CRUD endpoints. Missing suppression storage fails closed for managed email. Suppressed recipients are refused before send. Bounce/complaint feedback ingestion, suppression administration, outbound attachments, delivery tracking and sending-authorization delegation still need separate qualification. This adapter supports transactional agent replies, not broadcast campaigns.

`RunSupportEmail` runs each minute on `support-email`; `RunChannelDelivery` handles admitted inbox work and outbound operations on `support-channels`. Explicit scheduler registration and database workers are required even when Redis is used for cache/presence. Native receipt leases, unique inbox admission and attachment idempotency allow process restart without duplicate messages.

## Verification

`tests/feature/email.test.ts` uses the native router and authentication, generated migrations, real SQLite/PostgreSQL, real RSA-signed SNS envelopes and real MIME parsing. Only the external AWS/certificate gateway is deterministic. It covers ownership/private-bucket refusal, signature/SSRF/topic checks, SNS text/plain intake, durable acceptance/replay, unique new-email identities, signed reply sender binding, quarantine, binary/private attachments, native queue restart, single paid send, uncertain acknowledgement and honest unknown-cost holds. Published-package, DNS, AWS IAM/receipt-rule behavior and real recipient delivery need explicit separate verification.

An isolated AWS rehearsal used a DKIM-verified `ses-qa.hq.support` identity, exact receive and reply DNS records, signed SNS notifications, and a private S3 source bucket with one-day expiration. Disposable PostgreSQL verified inbound admission, exact attachment bytes, signed receipt replay, suppression, actual outbound delivery to the isolated recipient, and a signed follow-up in the original conversation. The outbound receipt kept its `cost_pending` status. See [provider qualification](https://github.com/stacksjs/hq.support/issues/8) and [SES wallet reconciliation](https://github.com/stacksjs/hq.support/issues/20).
