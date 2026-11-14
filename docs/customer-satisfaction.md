# Customer satisfaction

CSAT is an opt-in project setting. Owners/admins enable the question; an authenticated customer can rate their own resolved conversation once, using an integer score from 1 through 5 and an optional comment of up to 2000 characters. Settings initially remain disabled without a database write. This backend does not send survey messages, consume conversation or AI allowance, or grant marketing consent.

| Method and `/api` path | Contract |
| --- | --- |
| `GET /support/projects/{project}/csat-settings` | Owner/admin reads `settings: { enabled, question, revision }`; absent settings have revision 0 |
| `PATCH /support/projects/{project}/csat-settings` | Owner/admin sends `enabled`, `question` (1 to 160 characters), and numeric `expectedRevision` |
| `GET /widget/projects/{project}/conversations/{id}/csat` | Customer gets the offered question/revision, their existing immutable response, or an explicit unavailable reason |
| `POST /widget/projects/{project}/conversations/{id}/csat` | Customer sends `score`, optional `comment`, offered `revision`, and a stable `idempotencyKey` |
| `GET /support/projects/{project}/csat-report?period=YYYY-MM` | Active native workspace member gets aggregate scores for this project and UTC response month; current month is the default |

All routes return `Cache-Control: no-store`. Native cookie authentication requires CSRF for configuration writes. Widget calls use an exact allowed Origin and scoped customer bearer, with the native bearer preflight; cookies and body identity fields confer no authority. Read/integration keys do not act as signed-in agents for feedback reporting.

Configuration uses an optimistic revision check under the workspace transaction lock and rechecks current owner/admin membership there. A stale update returns 409 instead of overwriting another administrator's question. Submissions recheck the SQL customer session after acquiring the same lock used by session revocation. The conversation, project, workspace and contact must all match. Internal notes, other customers and sibling projects do not become feedback access grants.

The response stores its question and revision snapshot. Later edits, disabling the survey or reopening the thread do not rewrite that history or create another rating opportunity. New submissions require the conversation to be closed and the survey to remain enabled at its current revision. A cached question from an earlier revision returns 409 and must be refreshed. After a successful answer, GET returns `reason: answered` and that customer's own response even when the current setting is disabled.

Concurrent competing submissions commit one response, enforced both by workspace serialization and a model-generated unique conversation index. Retrying the same committed payload/key returns the original response; changing that payload or using another key after submission returns 409. Current authentication is checked before replay, so a revoked session cannot retrieve an old operation receipt. Responses and configuration changes produce metadata-only audit intents; these are not external delivery receipts. Comments stay out of those intents and aggregate reporting.

Reports count responses by their UTC creation month, independently of the conversation's creation/resolution month. They return five score buckets, response count, average score and the percentage scoring 4 or 5. Empty reports return null averages/percentages. They omit raw comments and customer identifiers. They do not claim a response rate because there is no invitation-delivery denominator in this slice.

`CsatSetting` and `CsatResponse` own the schema. Native generated SQLite/PostgreSQL migrations, tenant/report indexes, parent deletion cascades and snapshots accompany the models. The real HTTP suite runs against both disposable databases: native agent/browser authentication and CSRF, opt-in, exact customer/origin ownership, strict bounds, concurrent submissions, immutable question history, stale configuration/questions, current revocation, quota neutrality and exact UTC reporting boundaries.

The messenger rating form, settings editor, broader surveys, localization, accessibility/browser qualification and operational audit export remain separate work. These endpoints are not a claim that the full proactive engagement or survey product is launched.
