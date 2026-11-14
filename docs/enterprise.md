# Enterprise identity and licensing

Status: source implementation with automated HTTP/database verification. This is
not broad-launch acceptance. SAML, SCIM Groups, automatic IdP account creation,
organization-wide SSO enforcement, directory role mapping, retention controls,
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
`features` from `oidc`, `scim`, `audit`. Private signing keys never belong in the
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
Only RS256-signed ID tokens are supported in this release. There is no SAML
assertion verifier: `/saml/acs` explicitly answers 503, including unsigned input.

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
PUT preserves immutable `userName`/`externalId` and updates `active`. Other patch
paths, filters, bulk, password changes, sorting, ETags and Groups are unsupported.

Provisioning creates an agent invitation, not a new global auth account. Native
registration and invitation acceptance are required before linking SSO. Directory
role claims cannot create owners/admins, and directory writes refuse owner
memberships. Manually promoted administrators can still be deactivated. This deliberately requires a native onboarding step; automatic JIT
account creation and third-party directory compatibility certification remain work.

Deactivation revokes the workspace membership and its identity inside the same
transaction as native account credential revocation. Existing access/refresh
credentials and native browser sessions lose authority. The global account and
other workspace memberships remain intact; users may sign in again to access
those other workspaces. This signs out the affected account across workspaces
because native credentials are account-wide. Token revocation and provisioning
serialize on the workspace row. The application does not delete customer contacts,
conversations or exports when a human agent is deactivated.

## Audit and verification

Enterprise provider configuration, identity linking/sign-in, provisioning token
issue/revoke and directory user changes append to a workspace-owned audit table.
Owners/admins export `GET /api/support/workspaces/{workspace}/enterprise/audit`
with an optional numeric `cursor`; pages hold at most 100 events. This is an
Enterprise identity audit trail, not a comprehensive immutable audit record of
all core product mutations. No cryptographic log sealing, retention scheduler or
external SIEM sink is included.

`tests/feature/enterprise.test.ts` runs actual native HTTP registration/login,
generated model migrations and real disposable SQLite/PostgreSQL. Only the IdP
HTTP boundary is injected. It exercises signed Ed25519 workspace entitlement,
SCIM tenant isolation, native invitations, OIDC signature/audience checks,
one-use browser binding, native session issuance/revocation and expiry recovery.
The auth package also has `enterprise-oidc.test.ts` covering issuer, audience,
nonce, expiry, unsigned tokens, callback binding and S256 PKCE. Provider production
configuration and real third-party conformance testing remain deployment gates.
