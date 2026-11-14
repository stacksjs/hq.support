# Native documentation sync

`buddy support:sync-docs docs/getting-started.md --dry-run` previews explicitly selected Markdown files without sending their contents. No implicit directory crawl or default upload occurs. Each file must be inside the connected application, including its resolved symlink target, and at most 100 KB; a batch has at most twenty files.

After preview, omit `--dry-run` to sync. New documents default to internal drafts. `--public` selects customer visibility and `--publish` selects publication; both must be supplied for public customer knowledge. `--locale en-US` selects a locale. The integration key stays in server environment configuration and bearer headers, never the widget or console output.

The server accepts `POST /api/v1/projects/{project}/knowledge/sync` with an exact project write key and `{documents:[{source,title,body,locale,visibility,publish}]}`. Read keys cannot mutate knowledge. Selected sources use stable mappings and revisions. Repeated unchanged content is deduplicated. Changed content increments the article revision; manual article edits produce a conflict rather than being silently replaced. A bundle is one transaction, including every article, revision and source mapping. Omitted files are never deleted.

Integration-authored revisions record `author_id=0` and the integration key's database identifier, instead of attributing a machine write to a human. The selected source path is relative to the app; no absolute local path, file contents or server credential is printed by Buddy. The app rechecks revocation and project/workspace scope within the transaction.

The HTTP tests exercise actual auth, native model migrations, SQL transactions, private/public article search, revision conflicts and key revocation on SQLite/PostgreSQL. The Buddy tests also prove path/symlink confinement, explicit selection, dry-run network silence, and safe error output.
