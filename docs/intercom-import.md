# Resumable Intercom migration

This importer accepts a private file containing supplied Intercom contacts, full conversations, articles and explicit collection metadata. It makes no live Intercom API calls and stores no Intercom credentials. It does not claim to discover omitted or filtered source data.

Current Intercom API 2.18 retrieval supports numbered part pagination. Without a page request it returns the most recent 500 parts; list/search responses do not supply full message histories. Retrieve every unfiltered page from page one through `conversation_parts.pages.next:null`, preferably with `display_as=plaintext` to preserve link destinations. [Intercom retrieval reference](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations/retrieveconversation)

## Bundle format

Upload JSON with `version:1`, `provider:"intercom"`, `format:"plaintext"` (or `"html"`), and `contacts`/`conversations` arrays. These two arrays may be empty for article-only migration. Optional `articles` and `collections` arrays contain their complete original retrieve responses. Contacts contain the original Contact response objects. Conversations contain either a complete retrieve response or an explicit page sequence:

```ts
interface PagedConversation {
  pages: Array<{
    page: number // 1, 2, 3, in order
    response: IntercomConversationResponse // complete original response for this page
  }>
}
```

Every response page must name the same conversation, contain at most 500 parts, and include its original next-page cursor. The chain must begin at page one, advance by one page, and end at `next:null`. Part IDs cannot repeat. Intercom 2.18 reports `total_count` for the current page. When supplied, part counts and page counts must match the archive, the page size must stay consistent, and the conversation's update timestamp must agree across pages. The importer retains filtered continuation URLs and inconsistent page histories for review by source ID. Retrieve fresh, unfiltered pages to resolve them. [Intercom 2.18 pagination](https://developers.intercom.com/docs/references/changelog#page-through-a-conversations-parts)

Explicit pagination supports up to 5,000 parts per conversation. An ambiguous unpaged 500-part response, unfinished chain, or missing full `conversation_parts` is held for review. The operator remains responsible for retrieving all parts without filters, including when an export omits its original request parameters.

The administrative upload is multipart `file` at `POST /api/support/projects/{project}/imports/intercom`, with native owner/admin authentication and ordinary cookie CSRF protection. Limits are 10,000,000 bytes, 5,000 total supplied records, nesting depth 32 and 100,000 JSON values. The response is HTTP 202 with the actual persisted run state. Source bytes go to a private native Stacks storage disk with a SHA-256 digest. The same archive hash returns its existing run.

## Conversation attachments

Keep the original `attachments` entries on the source message and conversation parts. Add an optional top-level `attachmentFiles` array with one entry per exact source URL. Each entry contains `url`, `data` as canonical base64, and `sha256` as the lowercase hex digest of the decoded bytes. Obtain the bytes separately from an approved Intercom export or download. HQ.support treats source URLs as private references and makes no requests to them. [Intercom attachment response fields](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/models/part_attachment)

The importer verifies the SHA-256 digest and checks Intercom's `filesize` when present. It keeps files from internal notes private and exposes files from public messages to the customer who owns the conversation. Native attachment storage allowances apply. Split large migrations into bundles with up to 100 supplied files and up to 100 attachment transfers totaling 10 MB, including repeated references. The 10 MB JSON upload limit still includes base64 overhead. A message can retain up to ten attachments.

Missing bytes, source size conflicts and redacted messages stay in review. The dry run rehearses native metadata and quota changes inside a rollback without writing blobs. A real worker writes to deterministic private keys under the archive's attachment prefix, so retries address the same files. Preview and replay verify previously imported files against the source size and SHA-256. The attachment transfer limits also bound those reads, and each preview or worker batch reuses successful checks for repeat references to the same bytes. If the bytes differ, the record stays in `import_attachment_changed` review until the original file is restored and the run resumes. Retention and erasure reviews must include the retained archive, which contains the supplied bytes, and its attachment prefix.

## Article migration

Supply full Article retrieve responses, including title, HTML `body` or `body_markdown`, source author, state and UTC Unix timestamps. Intercom supplies `default_locale` for multilingual help centers; for a single-language response without it, set bundle `articleLocale` explicitly. Supplied `translated_content` locales are checked together before any locale is committed. A duplicate default-locale entry must agree with the top-level fields. [Intercom Article reference](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/articles/article)

Each supplied locale becomes a native **internal draft**, including articles originally published or restricted in Intercom. Native knowledge sanitization produces plain text, and native article revisions retain its history. Stable project/provider/article-ID/locale mappings preserve native targets across archives. Collection responses are retained as source metadata; an explicitly supplied single collection supplies the article's flat label and available translated name. Nested collection trees, sections and multiple-parent placement require review. [Intercom Collection reference](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/help-center/retrievecollection)

The actual upload principal is persisted for worker restart and checked again when each article is written. Native revisions name that native operator or integration key. Original authors, timestamps, audience, collection data and source payload remain private mapping provenance; no external author becomes a native login, owner or audit actor. A revoked integration key cannot continue article writes under an owner's identity.

Contacts and conversations retain their existing checkpoint order, followed by collections and articles. One article checkpoint atomically commits all its supplied locales. Identical source mappings skip writes. Changed source creates a native revision only while the prior imported native revision and content baseline still match; native edits, publication changes, removed targets and older source versions require reconciliation. Omitted articles/locales are not inferred as deleted, and their existing native targets remain unchanged. Reconcile source inventory separately before claiming a complete migration.

Missing bodies, partial translations, explicit truncation/redaction, missing timestamps/locales, separate staged drafts, remote HTML/Markdown media and unresolved collection placement produce per-record review codes. The archive and failed source payload remain available for review, with no partial native article or phantom media transfer. Publishing, widening audience and indexing are separate operator actions after content and permissions review. Article migration never calls an embedding provider, creates an index generation, sends notifications or consumes conversation, customer AI, copilot or indexing quota.

The same `dryRun=true` rehearsal validates collection dependencies, native content, existing mappings and reconciliation conflicts through actual native transactions, then rolls back every target, revision and mapping. `tests/feature/import-articles.test.ts` verifies actual HTTP upload, private storage, native queue restart and revoked actors on disposable SQLite and PostgreSQL using installed framework packages. These controlled fixtures do not qualify a production Intercom export as complete.

## Recovery and provenance

Each native `RunSupportImport` job processes at most 25 records, storing the source position, entity mapping, report and native row changes transactionally. Continuations use the native database queue `support-imports`. The scheduled recovery job can resume expired run ownership after a process exits. Run `./buddy queue:work --queue support-imports` and the native scheduler beside production workers.

Use `GET /api/support/projects/{project}/imports` and `/imports/{id}` for progress and per-record review codes. `POST /imports/{id}/pause` stops at a record checkpoint. `/resume` retries the earliest review record or the saved cursor; a live worker lease cannot be stolen. Source byte/hash mismatches stop processing. Restoring the exact original source allows continuation. Failed records retain their full supplied JSON and the source archive remains private; the API does not silently omit failures from a completed count.

Project/provider/entity/external-ID mappings deduplicate records across files. Contacts link only by an explicit external identity or a namespaced `intercom:{id}` identity, never by matching email and never to native login accounts. Existing native contact name/email edits remain intact. Source custom fields, tags and company metadata are retained under `attributes.intercom`. A removed mapped target is held for review. Changes to an imported message's source content or effective timestamp also require review. The existing message stays in place.

Historical messages preserve source UTC timestamps, public comments and internal notes. Supply whole Unix seconds as numbers or digit strings. The original message inherits the conversation's creation time when its own timestamp is omitted. Each numbered response page must carry the same conversation creation time, and supplied update times must agree. If a legacy export omits the update time throughout, the importer uses creation time. Explicit null, blank, or non-numeric creation, update, and message timestamps leave the source record in `invalid_source_timestamp` review. An absent or null closure date remains unknown. A supplied closure date must be valid, and a closed conversation's resolution must fall within its exported history. Retrieve the complete original dates before submitting a corrected archive.

Imported messages use `delivery_status:"imported"`. Importing history sends no notifications and runs no workflows. It consumes no new-conversation usage and generates no unread badge. Large conversations expose `messagesNextCursor`. Request `?beforeMessage=<cursor>` to read older pages.

## Review boundaries

The source archive and per-record provenance are retained; configure their retention/export/erasure lifecycle before production migration. Group conversations, attachment URLs without supplied bytes, redacted or missing bodies and unknown message-bearing part or author types stay in explicit review. Metadata-only parts remain metadata. HTML bodies are converted through the native plain-text importer; request plaintext source responses for faithful link text and destinations.

`tests/feature/imports-http.test.ts` uses actual authenticated HTTP, private filesystem bytes, the native database queue processor in fresh Bun processes, and disposable SQLite/PostgreSQL databases. It covers pause/resume checkpoints, identical and cross-file replay, external identity versus email, historical notes/timestamps, complete 501-part pagination, incomplete history refusal, changed-history conflicts, missing attachment review, source checksum failure/recovery and tenant isolation. No production Intercom export has been claimed as qualified by these fixture tests.

## Buddy integration and server rehearsal

Server integrations use the current project write key at `/api/v1/projects/{project}/imports/intercom` with the same multipart file. A read key is refused. The integration principal is checked against its real database key inside mutation transactions, including a second check after archive upload; it never impersonates a workspace owner.

Set multipart `dryRun=true` for a server rehearsal. The importer executes its actual native mapping/history checks within an intentionally rolled-back outer transaction, including existing native profiles and mappings. It returns `{dryRun,totalRecords,compatibleRecords,skippedRecords,reviewRecords,reasons:[{code,count,message}]}`. It creates no archive file, import run, target row, notification, usage charge or native job. Local source-file counts alone are not a compatibility report. PostgreSQL identifier sequences may advance during a rolled-back rehearsal; no target records remain.

In Project Settings, select the project and choose **Preview an Intercom migration** to check an archive in the browser. The report supports paging and a review-only filter. Keep the source file private while resolving the recorded issues.

On the authenticated owner/admin route, `dryRun=true` also returns a `records` inventory. Each item contains the zero-based import position, `entityType`, `sourceId`, `status` and `errorCode`. Positions follow the import order of contacts, conversations, collections and articles. A paginated conversation uses the ID of its first supplied response. Use the position to locate invalid or missing IDs, which appear as `null`. A status of `compatible` indicates that the supplied record passed the rehearsal. The inventory describes the supplied bundle only. The project write-key preview continues to return the summary contract above.

An accepted real integration upload returns only `{run:{id,status,totalRecords,cursor,processed,imported,skipped,failed},duplicate}`. `GET /api/v1/projects/{project}/imports/{id}` returns the same counts/status; `POST /imports/{id}/resume` adds `resumed`. These integration responses exclude raw records, transcripts, source names, file locations and hashes. Browser owner/admin endpoints retain detailed review reports. Both dialect fixtures verify this separation and that dry-run native row values/timestamps, job counts, usage and private archive directories remain unchanged.
