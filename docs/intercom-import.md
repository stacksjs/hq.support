# Resumable Intercom migration

This importer accepts a private file containing supplied Intercom contact and full conversation response objects. It makes no live Intercom API calls and stores no Intercom credentials. It does not claim to discover omitted or filtered source data.

Current Intercom API 2.18 retrieval supports numbered part pagination. Without a page request it returns the most recent 500 parts; list/search responses do not supply full message histories. Retrieve every unfiltered page from page one through `conversation_parts.pages.next:null`, preferably with `display_as=plaintext` to preserve link destinations. [Intercom retrieval reference](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations/retrieveconversation)

## Bundle format

Upload JSON with `version:1`, `provider:"intercom"`, `format:"plaintext"` (or `"html"`), and `contacts`/`conversations` arrays. Contacts contain the original Contact response objects. Conversations contain either a complete retrieve response or an explicit page sequence:

```ts
interface PagedConversation {
  pages: Array<{
    page: number // 1, 2, 3, in order
    response: IntercomConversationResponse // complete original response for this page
  }>
}
```

Every response page must name the same conversation, contain at most 500 parts and include its original next-page cursor. The chain must be contiguous, begin at one and end at null; part IDs cannot repeat. Complete explicit page sequences support up to 5,000 parts per conversation. An ambiguous unpaged 500-part response, unfinished chain or missing full `conversation_parts` is held for review. A source-controlled completeness flag cannot bypass these checks. These structural checks validate the supplied bundle; an operator remains responsible for supplying an unfiltered source export.

The administrative upload is multipart `file` at `POST /api/support/projects/{project}/imports/intercom`, with native owner/admin authentication and ordinary cookie CSRF protection. Limits are 10,000,000 bytes, 5,000 contact/conversation records, nesting depth 32 and 100,000 JSON values. The response is HTTP 202 with the actual persisted run state. Source bytes go to a private native Stacks storage disk with a SHA-256 digest. The same archive hash returns its existing run.

## Recovery and provenance

Each native `RunSupportImport` job processes at most 25 records, storing the source position, entity mapping, report and native row changes transactionally. Continuations use the native database queue `support-imports`. The scheduled recovery job can resume expired run ownership after a process exits. Run `./buddy queue:work --queue support-imports` and the native scheduler beside production workers.

Use `GET /api/support/projects/{project}/imports` and `/imports/{id}` for progress and per-record review codes. `POST /imports/{id}/pause` stops at a record checkpoint. `/resume` retries the earliest review record or the saved cursor; a live worker lease cannot be stolen. Source byte/hash mismatches stop processing. Restoring the exact original source allows continuation. Failed records retain their full supplied JSON and the source archive remains private; the API does not silently omit failures from a completed count.

Project/provider/entity/external-ID mappings deduplicate records across files. Contacts link only by an explicit external identity or a namespaced `intercom:{id}` identity, never by matching email and never to native login accounts. Existing native contact name/email edits remain intact; source custom fields, tags and company metadata are retained under `attributes.intercom`. A removed mapped target is held for review instead of being silently recreated. Changed previously imported message content becomes a conflict, preserving native history.

Historical messages preserve source UTC timestamps, public comments and internal notes. They use the truthful `delivery_status:"imported"` state. Importing history neither sends notifications nor runs workflows nor consumes new-conversation usage. Imported history does not generate an unread badge. Large conversations expose `messagesNextCursor`; request `?beforeMessage=<cursor>` to read older pages instead of losing messages at a response bound.

## Review boundaries

The source archive and per-record provenance are retained; configure their retention/export/erasure lifecycle before production migration. This slice does not transfer remote attachments, group conversations, redacted/missing bodies or unknown message-bearing part/author types. Those records are retained with explicit review codes, with no phantom native conversation or pretend attachment. Metadata-only parts are retained as metadata, rather than fabricated customer messages. HTML bodies are converted through the native plain-text importer; request plaintext source responses for faithful link text and destinations.

`tests/feature/imports-http.test.ts` uses actual authenticated HTTP, private filesystem bytes, the native database queue processor in fresh Bun processes, and disposable SQLite/PostgreSQL databases. It covers pause/resume checkpoints, identical and cross-file replay, external identity versus email, historical notes/timestamps, complete 501-part pagination, incomplete history refusal, changed-history conflicts, missing attachment review, source checksum failure/recovery and tenant isolation. No production Intercom export has been claimed as qualified by these fixture tests.

## Buddy integration and server rehearsal

Server integrations use the current project write key at `/api/v1/projects/{project}/imports/intercom` with the same multipart file. A read key is refused. The integration principal is checked against its real database key inside mutation transactions, including a second check after archive upload; it never impersonates a workspace owner.

Set multipart `dryRun=true` for a server rehearsal. The importer executes its actual native mapping/history checks within an intentionally rolled-back outer transaction, including existing native profiles and mappings. It returns `{dryRun,totalRecords,compatibleRecords,skippedRecords,reviewRecords,reasons:[{code,count,message}]}`. It creates no archive file, import run, target row, notification, usage charge or native job. Local source-file counts alone are not a compatibility report. PostgreSQL identifier sequences may advance during a rolled-back rehearsal; no target records remain.

An accepted real integration upload returns only `{run:{id,status,totalRecords,cursor,processed,imported,skipped,failed},duplicate}`. `GET /api/v1/projects/{project}/imports/{id}` returns the same counts/status; `POST /imports/{id}/resume` adds `resumed`. These integration responses exclude raw records, transcripts, source names, file locations and hashes. Browser owner/admin endpoints retain detailed review reports. Both dialect fixtures verify this separation and that dry-run native row values/timestamps, job counts, usage and private archive directories remain unchanged.
