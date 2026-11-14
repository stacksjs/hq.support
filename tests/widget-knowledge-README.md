# Knowledge console browser qualification

Verified in Chrome on 2026-11-14 UTC against the real native API/password session and disposable SQLite fixture used by `tests/widget-preview.ts`. Pending native features were loaded with the enterprise fixture's source aliases; published native package qualification remains a separate release gate.

An exact `/app/knowledge?project=PUBLICID&article=ID` link selected a public article and a newly saved internal article by native authenticated ID lookup, independent of the 50-result article-search cap. An inaccessible project left the project selector empty and showed an explicit error; a missing article showed the actual 404 error without selecting a different article.

The capability panel showed the real provider-unavailable, persisted lexical index state, 10 customer AI conversations, 100 separate copilot requests/100,000 tokens and a separate 100,000 embedding-token allowance from the fixture plan. These are server responses, not UI defaults. Saving an internal published article updated the actual authorized source count to one, and its source status reported active revision 1, one chunk and zero vector dimensions. Refreshing capabilities preserved an unsaved title, and discarding restored the saved article.

The panel reports full-text/vector mode only if returned by the server. It does not equate vector readiness with active vector retrieval or equate remaining budget with provider availability. Source permissions and index state are read-only here.

Screenshot: `/tmp/hq-support-knowledge-capabilities.png` (machine-local).
