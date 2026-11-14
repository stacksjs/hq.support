# Enterprise identity and licensing

Status: source implementation with automated HTTP/database verification. This is
not broad-launch acceptance. Automatic IdP account creation,
organization-wide SSO enforcement, directory role mapping, comprehensive PII retention,
external audit sinks and a signed-license issuance/renewal service are not shipped.

## License boundary

The application core is MIT. Files under `enterprise/` have the separate
source-visible commercial license in `enterprise/LICENSE.txt`. Production Enterprise
use needs a commercial agreement. An operator supplies:

- `SUPPORT_DEPLOYMENT_MODE=selfhost` for a self-hosted installation.
- A stable `SUPPORT_INSTALLATION_ID` bound to the purchased installation.
- `SUPPORT_ENTERPRISE_LICENSE_PUBLIC_KEY`, a trusted Ed25519 SPKI public PEM.
- `SUPPORT_ENTERPRISE_LICENSE`, a two-part `base64url(payload).base64url(signature)`
  entitlement. Ed25519 signs the exact ASCII base64url payload, not decoded JSON.

The payload has `version: 1`, `licenseId`, `installation`, `workspace` (the
workspace public UUID), `issuedAt` and `expiresAt` (Unix milliseconds), and
`features` from `oidc`, `saml`, `scim`, `audit`, `retention`. Private signing keys never belong in the
application. Persist the entitlement and installation identifier through the
operator's secret/configuration service. The application does not issue licenses
or call a license server. Rotate the trusted public key as an operator change.
A copied token for another workspace/installation, a future-issued token, an
expired token and a token signed by another key do not grant capabilities.
Hosted Enterprise entitlement instead follows the verified server-owned billing
plan when `SUPPORT_DEPLOYMENT_MODE=hosted`.

Expiry blocks provider configuration, account linking, new provisioning tokens,
new directory invitations and directory reactivation. It preserves native
password/passkey login, previously linked OIDC sign-in, existing core data access,
audit export, directory deactivation and token revocation. License expiry never
runs an account or data deletion and never enforces SSO-only sign-in.

## OIDC setup

An owner/admin configures one immutable issuer and client ID for their workspace
with `POST /api/support/workspaces/{workspace}/enterprise/provider`. Its body is
`{ "protocol": "oidc", "issuer": "https://idp.example.com", "clientId": "..." }`.
The response includes the provider public UUID. An operator then configures:

- `SUPPORT_ENTERPRISE_OIDC_ISSUERS` as a JSON array of exact approved issuer URLs.
  Tenant administrators cannot approve an issuer for outbound requests.
- `SUPPORT_ENTERPRISE_OIDC_CLIENTS` as a JSON object mapping provider public UUID
  to the client secret. Never place these secrets in browser configuration.
- Canonical HTTPS `APP_URL`. Register the exact redirect URI
  `{APP_URL}/api/enterprise/providers/{provider}/callback` at the provider.

Issuer approval is an operator trust decision. Use public provider addresses and
an egress policy that blocks private, loopback, link-local and metadata networks,
including DNS rebinding. The allowlist is checked before discovery, token or JWKS
requests. Runtime requests disable redirects, require HTTPS, time out after ten
seconds and require discovery endpoints to share the issuer origin. This strict
same-origin rule excludes providers such as Google's multi-origin OIDC metadata.
Only RS256-signed OIDC ID tokens are supported in this release. SAML has the
separate strict adapter described below. Missing provider configuration answers
503; malformed or unsigned assertions answer 401.

OIDC authorization uses code flow, S256 PKCE, a nonce, and native persistent
browser-bound, one-use OAuth flow state with a five-minute lifetime. The native
`@stacksjs/auth/enterprise-oidc` verifier delegates protocol and signature handling
to `oauth4webapi`, validates issuer, audience, nonce, expiry and the JWKS signature,
and refuses unsigned assertions. It returns identity only; provider role claims
are ignored. Provider issuer/client changes are refused because they must not
reinterpret existing immutable subject links.

Users register/sign in through native auth, verify their local email, accept a
workspace invitation, then POST to `/api/enterprise/providers/{provider}/link`
with their native authenticated session and normal CSRF protection. The provider
must verify the same email. The link stores provider ID plus immutable subject;
later email drift never reassigns it. A public login never silently links an IdP
email onto an existing global account. Previously linked users can visit
`/api/enterprise/providers/{provider}/login`; success creates the same native
HttpOnly database browser session used by the app. Bearers and provider tokens
never appear in redirect URLs. Configure required MFA at the identity provider;
there is no workspace SSO enforcement or enterprise-specific MFA assurance policy
in this release. Native local login remains available for recovery.

## SAML setup

SAML uses the same native account linking, immutable provider subject mapping,
workspace authorization and database browser sessions as OIDC. Configure the
provider with `protocol: "saml"`, IdP entity ID as `issuer`, and SP entity ID as
`clientId`. The license must include `saml`. Approve exact IdP entity IDs in
`SUPPORT_ENTERPRISE_SAML_ISSUERS` (JSON array). Supply
`SUPPORT_ENTERPRISE_SAML_PROVIDERS` as a JSON object keyed by provider public UUID,
with `entryPoint` (HTTPS IdP SSO URL), `idpCert` (pinned signing PEM), `privateKey`
(SP signing PEM, secret) and `publicCert` (SP certificate PEM). Store private keys
in the operator secret service; API responses do not return them. There is no
remote XML metadata ingestion or automatic certificate trust.

Register `{APP_URL}/api/enterprise/providers/{provider}/saml/acs` as the exact
HTTP-POST ACS URL. Native-authenticated users POST to the sibling `/saml/link`;
linked users visit `/saml/login`. AuthnRequests are RSA-SHA256 signed and use
persistent NameIDs. The IdP must sign both the Response and its single Assertion
with RSA-SHA256/SHA256. Issuer, audience, Destination, bearer Recipient,
InResponseTo, assertion lifetime and request correlation are strict. Unsigned,
modified, duplicate assertions, entity declarations and unsupported algorithms
fail closed. This intentionally strict profile may require IdP configuration.

The adapter uses maintained `@node-saml/node-saml` signature verification and
reads verified signed XML for recipient/destination enforcement, which the
underlying library otherwise warns about. A native persistent one-use flow
binds RelayState to the initiating browser with Secure, HttpOnly, SameSite=None
cookies. Cross-worker concurrent replay has only one session winner. Existing
linked SAML login remains usable after entitlement expiry. Unsolicited IdP login,
SAML logout, encrypted assertions and transient NameIDs are unsupported. Real
third-party IdP interoperability and external security review remain launch gates.

## SCIM Users

Owners/admins issue a 90-day token with
`POST /api/support/workspaces/{workspace}/enterprise/scim-tokens`. The plaintext
is returned once; SQL stores only its SHA-256 digest. Each token binds one
workspace and provider. Revoke with DELETE to the same path plus `/{id}`.

The SCIM base URL is `/api/scim/v2/{workspace}` using the numeric workspace ID.
Send `Authorization: Bearer scim_...`. Supported endpoints are
`ServiceProviderConfig` and `Users` (GET list/detail, POST, PUT, PATCH and DELETE).
Listing supports `userName eq "address@example.com"`, `startIndex` and `count`
with a 100-item maximum. PATCH accepts one replacement of boolean `active`.
PUT preserves immutable `userName`/`externalId` and updates `active`. DELETE
deactivates and tombstones the resource so subsequent GET/list cannot return it.
Other Users patch paths, filters, bulk, password changes, sorting and ETags are
unsupported. Re-provisioning an address with a tombstoned membership currently
requires an operator-reviewed restoration; automatic restoration is not shipped.

Provisioning creates an agent invitation, not a new global auth account. Native
registration and invitation acceptance are required before linking SSO. Directory
role claims cannot create owners/admins, and directory writes refuse owner
memberships. Manually promoted administrators can still be deactivated. This deliberately requires a native onboarding step; automatic JIT
account creation and third-party directory compatibility certification remain work.

Deactivation revokes the workspace membership and its identity in one
transaction. Every affected workspace API reauthorizes the native account against
its active membership, so existing browser sessions and bearers immediately lose
that workspace's authority. Native credentials belong to the human account and
remain usable in other workspaces. Provisioning does not run an account-wide
credential sweep. Subsequent OIDC login through the deactivated identity is
refused. Token revocation and provisioning serialize on the workspace row. The
application does not delete customer contacts, conversations or exports when a
human agent is deactivated.

## SCIM Groups

`Groups` supports GET list/detail, POST, PUT, PATCH and DELETE under the same
workspace/provider-bound SCIM base URL. List pagination uses `startIndex`/`count`
and supports `displayName eq "Support Team"`. POST/PUT accept `displayName`,
optional immutable `externalId`, and up to 100 `members: [{ "value": "user-id" }]`.
Every member must be an undeleted SCIM User resource of the same provider and
workspace. PATCH replaces `displayName` or adds/removes/replaces `members`,
including `members[value eq "123"]` removal. Unsupported paths fail explicitly.
Deleting a group makes subsequent reads return 404 and remains possible after
license expiry. Deleted user tombstones do not appear in group responses.

Directory groups are synchronized records for directory visibility. Group names,
IdP role claims and membership changes never assign native owner/admin roles or
change workspace access. Automatic routing-team/RBAC mapping is not included.

## Basic closed-conversation content retention

Owners/admins configure `PUT .../enterprise/retention` with
`{ "days": 30, "enabled": true }`. The window is 30 to 3650 days, disabled until
explicitly enabled, and enabling/applying requires the `retention` entitlement.
GET on that path reads the policy. GET `/retention/preview` returns at most 100
eligible IDs without deleting anything; POST `/retention/run` processes up to 25
threads. PUT `/retention/holds/{conversationId}` with `{ "active": true,
"reason": "..." }` protects a conversation. Hold placement and disabling the
policy stay available after entitlement expiry; expired licenses stop deletion.

A thread must be closed and inactive for the complete window. Open/recent
threads, legal holds, active AI work, and unfinished attachment writes are
excluded. Each run redacts message body, conversation subject, associated ticket
text, AI answer cache and matching conversation/reply idempotency response copies.
It preserves records and billing/delivery identifiers. Native storage deletion
verifies attachment objects are gone before releasing their exact byte charge.
The job can retry without charging twice or resurrecting an old idempotent reply.
Workspace row locking serializes policy/hold/provisioning changes and attachment
accounting. Per-thread row locking protects a concurrent reopen.

`ApplyEnterpriseRetention` is an auto-discovered native Job with hourly rate,
five attempts and a `support-retention` queue. Production should explicitly
schedule it through `.onQueue('support-retention').withoutOverlapping().onOneServer()`
and run a native worker for that queue. Rate-only auto-discovery executes in the
scheduler process. The sweep visits at most 20 policies and 25 eligible threads
per workspace per run; monitor backlog and worker failures before raising limits.

This is a basic content policy, not a complete personal-data deletion service.
Contact identity/attributes, raw provider inbound payloads, event properties,
workflow contexts, voice recordings/transcripts, attachment metadata, external
provider copies and backups are outside this policy and require separate
retention/deletion controls before claiming comprehensive PII erasure. Legal holds
here govern only the content classes managed by this policy. S3 lifecycle and
backup retention remain operator infrastructure responsibilities.

## Audit and verification

Enterprise provider configuration, identity linking/sign-in, provisioning token
issue/revoke and directory user changes append to a workspace-owned audit table.
Owners/admins export `GET /api/support/workspaces/{workspace}/enterprise/audit`
with an optional numeric `cursor`; pages hold at most 100 events. This is an
Enterprise identity audit trail, not a comprehensive immutable audit record of
all core product mutations. No cryptographic log sealing or external SIEM sink is included.

`tests/feature/enterprise.test.ts` runs actual native HTTP registration/login,
generated model migrations and real disposable SQLite/PostgreSQL. Only the IdP
HTTP boundary is injected. It exercises signed Ed25519 workspace entitlement,
SCIM tenant isolation, native invitations, OIDC signature/audience checks,
one-use browser binding, native session issuance, workspace-scoped revocation, directory groups, legal holds,
native attachment retention and expiry recovery.
The auth package also has signed XML verification tests and `enterprise-oidc.test.ts` covering issuer, audience,
nonce, expiry, unsigned tokens, callback binding and S256 PKCE. Provider production
configuration and real third-party conformance testing remain deployment gates.
