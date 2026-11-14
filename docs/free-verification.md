# Stacks Free eligibility

A project qualifies by completing both the native HQ/Buddy connection confirmation and a public deployment ownership challenge. Ordinary owner-created API keys and self-reported framework metadata alone do not grant Free. A native account can claim exactly one Free workspace, including when it owns several trial workspaces.

The server first records `buddy_connected_at` when a signed-in owner/admin types the Buddy confirmation code and approves the HQ connection. The approval API can accept `workspaceId` to select an authorized workspace; its default is the oldest owned workspace.

## Deployment flow

Use a project write key, server-side only:

1. `POST /api/v1/projects/{project}/verification/challenges` with `{origin:"https://your-app.example",frameworkVersion:"0.75.574"}`.
2. The server returns `{challenge:{id,nonce,project,origin,url,expiresAt},document}`. Publish the returned document unchanged at `https://your-app.example/.well-known/hq-support` in the application you own. A static file under `public/.well-known/hq-support` is sufficient. Do not expose an integration key there.
3. After the application is deployed, `POST /api/v1/projects/{project}/verification/challenges/{id}/confirm` with `{nonce}`. Creating the challenge does not deploy or publish an application.
4. The server fetches the exact path. A matching successful public proof atomically grants Free if the workspace fits the Free allowances and the owning account has not claimed another workspace.

The document is `{service:"supporthq",project,nonce,framework:"stacks",frameworkVersion}`. JSON and extensionless `application/octet-stream` responses are accepted; HTML is refused. The document must be at most 4096 bytes. Challenges are random 32-byte nonces, hashed at rest, bound to owner/workspace/project/origin/version, expire after ten minutes, and allow five confirmation attempts. Starting another challenge consumes the previous pending one for that project. A successful matching proof replay returns the existing result without another external probe.

Equivalent browser endpoints live under `/api/support/projects/{project}/verification`, require owner/admin native authentication, and retain native CSRF protection. `GET` on either verification base returns the actual persisted connection/proof/plan state. Integration endpoints accept only an unrevoked project write key, including a second check after the network probe. A read key cannot grant Free.

## What is proved

Serving the unpredictable challenge over public HTTPS demonstrates control of that deployment at the time of verification. `framework:"stacks"` and its version are eligibility metadata, explicitly returned as `frameworkAttestation:"self_reported"`; they are not a cryptographic attestation of an executable or source tree. The separate confirmed Buddy connection is also required. Do not claim otherwise.

The native `fetchPublicUrl` guard from `@stacksjs/security` validates all resolved addresses, connects to the checked address with the original host/TLS name, bounds the response and the entire request, and is configured to follow zero redirects. This blocks loopback, private, link-local/cloud-metadata, mixed private/public DNS responses and DNS rebinding between validation and connection. The application additionally requires a named HTTPS origin on port 443 with no path, credentials, query or fragment. No cookies or authorization are forwarded to the probed application.

The final transaction locks the owning native `users` row before the workspace row. It rechecks authorization, project connection, challenge expiry and ownership, the account claim ledger and every Free capacity. It then writes the user claim, plan, proof, project origin and challenge consumption together. A partial unique workspace index independently enforces one `plan='free'` workspace per owner. Trial/Free workspaces can qualify; active paid workspaces must manage their subscriptions first. No traffic is deleted or sampled to make a workspace eligible.

`tests/feature/verification-http.test.ts` uses actual HTTP/native auth, actual Buddy confirmation and disposable SQLite/PostgreSQL databases. Only the external deployment response is injected. It verifies the ownership/nonce/project/expiry/attempt bounds, static MIME, response-size cap, key revocation during the probe, tenant refusal, native private/mixed-DNS refusal and concurrent claims across two workspaces of one owner. It does not claim that a production domain was deployed or probed during development.
