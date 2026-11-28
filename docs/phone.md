# Phone and voice AI

Status: a source-implemented Twilio voice path qualified against deterministic
provider HTTP/socket boundaries and real SQLite/PostgreSQL. No real number has
been purchased, no real call has been placed, and no live provider qualification
or deployment is implied. Published-package consumption and browser UI checks
must also pass before release acceptance.

## Implemented path

The voice channel uses the same encrypted `support_channels` connection model
as other providers. Its private configuration contains `accountSid`, `authToken`,
`fromNumber`, `phoneNumberSid`, `country` (`US` or `CA`), and optional browser
`apiKeySid`/`apiKeySecret` and `recordingNotice`. Prefer a separate provider
subaccount for each workspace. Credentials never appear in capability/channel
responses. A saved connection remains pending until the real provider account
returns the exact owned number/SID and accepts the canonical inbound routing URL.
Verification refuses an application/SIP-trunk override that would ignore that
URL. Credential changes during a probe invalidate its evidence.

Both inbound and outbound AI calls create native support contacts/conversations
and durable SQL call records. Inbound callbacks authenticate before admission;
overflow or missing credit is retained in the native inbound ledger for a human
follow-up. The caller hears a notice and must press 1 before any audio is streamed
to AI. This is consent to AI processing and text transcription, not an assertion
that telephone recording laws have been satisfied in every location. Raw audio
recording is not implemented.

The outbound call is reserved in SQL before provider work. Native
`OperationJournal` claims survive process restarts and serialize across workers.
An accepted key replays the recorded result; pending/uncertain writes are never
expired into another provider attempt. A new key cannot bypass an unresolved
call to the same destination. A signed callback plus an exact, account-scoped
provider lookup can reconcile a lost response, with a durable receipt. An empty
provider list never proves that an uncertain call was not placed.

The provider receives an explicit hard `TimeLimit`. The app refuses paid voice
on a native package without that API, so an older transport cannot silently
ignore the duration bound. The server media listener also enforces the deadline,
media/account/call binding, exact sequence progression, aggregate audio limits,
input/output backpressure and acknowledged playback marks. Overflow closes the
call with a durable error instead of silently dropping audio. Barge-in cancels
AI output, clears Twilio playback and truncates only acknowledged played audio.

Assistant output transcript fragments are persisted. Separate customer speech-to-text
is not enabled in this bridge: it needs its own configured transcription model
and verified usage pricing before adding that paid service. The native transport
can receive customer transcription events, and fixtures exercise that boundary,
but that is not a claim that live caller transcription is configured.

The shared tool executor derives project, contact, conversation and call authority
from SQL. It permits published public knowledge search, a caller-bound ticket,
and a human request. Tool arguments cannot supply workspace/customer IDs or a
telephone destination. Results, refusals and canonical idempotency keys persist;
replayed tool calls cannot create another ticket. The executor is available for
future text-AI integration; the current grounded text answer path does not yet
invoke these tools.

An authenticated native agent can take over a live call. The server generates the
project/user browser identity and bounded `<Dial><Client>` instructions. The
browser's official Twilio Device token permits incoming calls only, expires in
five minutes, and refreshes through native workspace authorization. It cannot
place an unbudgeted outbound call directly. Actual parent and child leg charges
must belong to that parent call and are aggregated before settlement.

## Server configuration

- Canonical HTTPS `APP_URL`, with the public `/api/phone/...` callback routes.
- `SUPPORT_VOICE_MEDIA_URL`, a canonical public `wss://voice.example.com` origin,
  without a path, query, credentials or fragment.
- Run `./buddy voice:serve` behind that TLS endpoint. The listener defaults to
  port 3002; `SUPPORT_VOICE_PORT`/`SUPPORT_VOICE_HOST` control its private binding.
  This dedicated host is required because the native app HTTP router does not
  upgrade arbitrary provider WebSockets. Its `/health` checks the listener, not
  provider account readiness. Proxy WebSocket upgrade headers and the original
  signature, and use the pinned public HTTPS URL when validating signatures.
- `SUPPORT_VOICE_MAX_STREAMS` bounds authenticated media sockets per listener
  process and defaults to 32. Size the configured limit for the host. Each call
  can use one media socket at a time. New calls receive HTTP 503 when capacity
  is full and can connect when an existing session closes. Launch capacity
  still needs a measured rehearsal on the intended voice host.
- Each active call can queue up to 100 events and 128,000 bytes across both
  provider streams. Exceeding either bound closes the media session and records
  which provider encountered backpressure for operator review.
- Server-only `OPENAI_API_KEY` for the native OpenAI Realtime adapter.
- `SUPPORT_PHONE_PRICING`, a JSON object keyed by provider account SID. Every
  policy supplies positive integer `telephonyCeilingCentsPerMinute`,
  `aiCeilingCentsPerMinute`, `dailyCapCents`, `monthlyCapCents`,
  `maxDurationSeconds` (30 to 900), a `realtimeModel`, and `rates` containing
  `inputText`, `inputAudio`, `cachedText`, `cachedAudio`, `outputText`,
  `outputAudio`. Rates are explicitly verified USD microdollars per million
  tokens for that account/model. Missing categories never become zero prices.
  Use conservative maximum per-minute ceilings, including both possible phone
  legs. Provider/model pricing changes require an operator review; these are
  operator data, not a customer-supplied price assertion.
- Configure positive native wallet daily/monthly managed spending ceilings and
  prepaid credit. Both the shared wallet caps and the phone-specific operator
  caps apply. Number rental, recording and other optional services are not
  included in call pricing and are not enabled by this path.

Phone verification updates the provider's inbound Voice URL. Existing Twilio
Voice Application/SIP routing must be removed by its operator before this
connection can be marked ready. SMS routing uses a separate native method and
does not overwrite Voice URL settings.

## Money and settlement

Reservations cover the maximum duration plus the consent interval, two possible
telephony legs, and a separate voice-AI allowance. Overages and automatic top-ups
are not enabled by this feature. Phone-specific UTC daily/monthly ceilings count
conservative reservations; the shared wallet also enforces its configured caps.

Twilio's final USD resource price is parsed into integer microdollars. Provider
price/duration can be absent after completion, so reconciliation stays pending
until they exist. Child legs must carry the exact parent SID and have final USD
prices. All relevant leg prices are summed before adding 15 percent and rounding
once into integer cents. Repeated settlement verifies the same cost basis and
receipt instead of charging twice.

Realtime usage stores the actual provider response ID/counts and the explicit
pricing snapshot. Fractional usage costs are aggregated before microdollar and
cents rounding. A missing final usage event, unmatched token categories or an
unclean audio close retains the AI reservation for reconciliation; it is never
silently treated as free. AI pricing here follows the explicitly configured
account/model tariff, not an automatically fetched invoice. An operator invoice
reconciliation workflow for unresolved AI usage is still required before broad
managed voice rollout.

## API and browser controller

All agent endpoints are under `/api/support/projects/{project}/phone` and use
native authentication, workspace membership and CSRF protection:

| Endpoint | Behavior |
| --- | --- |
| GET `/capabilities` | Safe verified channels, per-channel readiness, concrete supported/unsupported feature flags |
| GET `/calls`, GET `/calls/{id}` | Workspace/project call history and details |
| POST `/channels/{id}/verify` | Owned-number/routing proof before readiness |
| POST `/calls` | AI call intent with `channelId`, `to`, stable `idempotencyKey`, bounded `maxDurationSeconds` |
| POST `/calls/{id}/end` | Journaled provider termination |
| POST `/calls/{id}/reconcile` | Final actual provider/usage settlement, or explicit pending state |
| POST `/calls/{id}/takeover` | Assign current native agent and redirect to their browser identity |
| POST `/token` | Project/user-scoped incoming browser grant for a verified `channelId` |

The controller in `resources/functions/support-phone.ts` uses the official
`@twilio/voice-sdk`. It is initialized only after the user selects Enable. The
native page compiler can download the SDK with the phone page's bundle; no SDK
initialization happens on unrelated console pages. Register, incoming/accept,
mute, reject/disconnect, refresh, microphone failure and destroy are explicit
controller states. Page/project/channel changes must destroy the previous device.

## Agent deprovisioning

SCIM deactivation and deletion persist a phone revocation with the workspace
membership change. The Stacks worker ends only provider children belonging to
that workspace, parent call, and browser identity. It cancels ringing legs and
completes connected ones. A reactivated agent can accept a new call. The old
dial stays revoked.

The signed Client progress callback records the child SID, including delayed
delivery after deactivation. The worker can also look up children under an
active pre-upgrade parent. A lost provider response stays in the journal until
the exact child reaches a verified terminal state. The scheduled worker
recovers persisted revocations after process restarts. Completed child records
feed the original cost settlement. The parent follows its existing Dial
completion instructions when the scoped child disconnects.

## Qualification and remaining work

`tests/feature/phone.test.ts` starts native HTTP auth/routes, generated migrations,
real SQLite/PostgreSQL, a real provider-facing WebSocket server, and native
Realtime transport. Only external Twilio HTTP and OpenAI socket peers are
injected. It tests signed callback/media boundaries, explicit consent, concurrent
single-attempt writes, exact spend ceilings, uncertain result recovery, public
knowledge isolation, ticket replay/audit, playback cancellation, and parent/child
actual cost settlement. The SCIM fixture also verifies scoped leg termination,
a held recovery lease, and recovery in a fresh worker process. The optional localhost browser fixture keeps the same
native HTTP/SQL server alive; the official Device can be substituted only in the
native test compile.

Live caller speech-to-text, US/Canada number purchase, direct outbound human-browser dialing, a full IVR
editor, advanced call queues/hold, voicemail, raw recordings, provider recording
retention, live provider account approval, real microphone/PSTN interoperability,
operator reconciliation for unresolved AI invoices, and live verification of
phone deprovisioning remain unfinished. Provider
callbacks are ordered and deduplicated, but full operational replay/reconciliation
UI and long-term transcript retention need their own acceptance. Enterprise
closed-thread content retention includes completed call transcripts and tool-result
copies under the same conversation legal holds; active phone work is excluded.
Raw recordings and external provider copies remain outside that policy.
These gaps prevent claiming the complete phone/voice launch stage is finished.

Provider contracts were checked against the official
[Call resource](https://www.twilio.com/docs/voice/api/call-resource),
[IncomingPhoneNumber resource](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource)
and [Access Tokens](https://www.twilio.com/docs/iam/access-tokens) documentation.
