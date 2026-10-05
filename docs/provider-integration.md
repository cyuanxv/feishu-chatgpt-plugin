# Provider integration: implemented offline, not connected

## Evidence and boundary

The provider slices compile against `@larksuiteoapi/node-sdk` 1.74.0. Contract tests instantiate this official SDK with a synthetic injected HTTP client and inspect the actual endpoint, method and payload it produces. They do not reimplement a fake SDK or contact a live service.

The executable MCP endpoint still runs synthetic fixtures. No production OAuth router, authorized account or live backend is selected. `FEISHU_MODE=live` remains rejected. Provider modules return `source: feishu_api` where normalized, but these results are not mixed into the demo's `synthetic_mock` envelope.

## Confirmed SDK bindings

| Area | Official SDK methods | Offline behavior implemented |
| --- | --- | --- |
| Profile | authen.v1.userInfo.get | Minimal profile, tenant check, no phone/email expansion |
| Search | search.v2.docWiki.search | Actual res_units/result_meta schema and provider pagination; no arbitrary returned URL fetching |
| IM | im.v1.chat.list/search; im.v1.message.search/get/list | Chat/message search, signed message fetch and authoritative message-to-thread reads with reply validation |
| Docs / Wiki | docx.v1.document.get/rawContent; drive.v1.fileComment.list; fileCommentReply.list; wiki.v2.space.getNode | Signed DOCX fetch, Wiki resolution, version-bound chunks and full explicit comment-reply paging |
| File metadata | drive.v1.meta.batchQuery | Signed file search-to-metadata-fetch, per-resource partial failure/unknown status and strict request/response identity/type matching; no file download |
| Base | BITABLE-only search.v2.docWiki.search wrapper; fixed Wiki node_by_token; bitable.v1.appTable.list; appTableField.list; appTableRecord.search | Keyword candidates, explicit Base/table selection, Wiki resolution, bounded schema paging, field-ID-to-name translation, numeric/text/select filters and signed pagination |
| Calendar | calendar.v4.calendar.list; calendarEvent.list; freebusy.batch | Explicit calendar/timezone, all-day dates, unknown-busy handling and candidate slots only when all participants have validated availability |
| Rooms | vc.v1.room.search; calendar.v4.freebusy.list | Capacity-aware candidates and bounded single-room availability; never sends user_id in a room query; unavailable/failed data remains unknown |
| Tasks | task.v2.task.list/get/search; task.v2.tasklist.list/tasks | Current-user, explicit tasklist and explicit-assignee workflows; bounded search-to-detail reads, role/status revalidation and preserved partial failures |
| People | fixed SDK request to contact/v3/users/search; contact.v3.user.batchGetId retained as a lower-level binding | Official CLI-backed user-only name/email search, max 50 Unicode characters/30 results, no guessed continuation and no automatic recipient choice |

All SDK calls force `withUserAccessToken`. No tenant/bot fallback is allowed. The gateway binds the subject, tenant, connection and provider domain and requires logical scopes before token acquisition. Path traversal and payload header injection are rejected. All SDK logs are muted because upstream Axios errors may contain secrets.

## Provider OAuth and persistence

- Token exchange and refresh use the official SDK `accessToken` helper. The installed version emits the Feishu `/oauth/v3/token` endpoint on `accounts.feishu.cn`; tests verify that contract instead of guessing an older URL
- Exact HTTPS redirect URI, subject-bound one-time state, encrypted PKCE verifier and requested-scope allowlist
- Granted scopes may narrow, never exceed the request; incomplete refreshable token responses fail closed
- State consumption uses atomic PostgreSQL `DELETE ... RETURNING`, bound to state hash, original subject and expiry
- Verified connection plus encrypted tokens are linked transactionally; conflicting owner/tenant/open_id never overwrite an existing connection
- Reconnect advances a grant generation. Token refresh uses generation + token-revision compare-and-swap, and failed refresh only revokes the exact original snapshot
- Local disconnect revokes the connection, removes stored tokens and marks its MCP grants revoked in one transaction. Provider-side revocation is not yet implemented
- PGlite tests execute the exact migrations and repository SQL. They do not validate remote TLS, native multi-connection behavior, roles/RLS, KMS or backup operations

## Known incomplete behavior

- Actual Feishu OAuth scope names must be verified per endpoint and app type. Internal scopes are not provider scopes
- Provider authorization URL, production user authentication, consent screen, durable MCP AS and real callback route are not configured
- Tasklist discovery is an internal provider helper, not an additional public MCP tool; production routing of the existing `list_tasks` filters remains unconfigured
- Unified search supports DOCX/Wiki/message and explicit file metadata searches, ordered document-domain results before messages. Each continuation preserves query, connection and scope binding. Base aggregate search is not included yet; file fetch is metadata only
- Complete live MCP routing and domain-specific output schemas are not wired. Provider methods remain internal and never enter the synthetic MCP envelope
- Typed API responses are still untrusted. Domain output schema hardening and real empty/partial/error cases require further tests
- Unknown Feishu business error codes fail safely without guessing a meaning or retrying. Exact endpoint-specific business-code classification remains to be verified

## Primary sources

- [Official Feishu Node SDK](https://github.com/larksuite/node-sdk), including the installed SDK type declarations and implementation
- [Official document search API](https://open.feishu.cn/api-explorer?project=search&resource=doc_wiki&apiName=search&version=v2)
- [Official IM message search API](https://open.feishu.cn/api-explorer?project=im&resource=message&apiName=search&version=v1)
- [Official Base record search API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-record/search)
- [Official task v2 overview](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/task-v2/task/overview)
- [Official CLI thread-message reference](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-threads-messages-list.md), confirming the read-only `im/v1/messages` thread-container contract
- [Pinned official contact search implementation](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/contact/contact_search_user.go)
- [Official reply paging implementation](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/drive/drive_list_replies.go), including first-page-only root semantics
- [Official Drive metadata inspection](https://github.com/larksuite/cli/blob/main/shortcuts/drive/drive_inspect.go)
- [Official task search implementation](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/task/task_search.go), confirming explicit assignee filters, query-string pagination and detail enrichment
- [Official Base resolution implementation](https://github.com/larksuite/cli/blob/main/shortcuts/base/base_resolve.go), inspected 2026-10-05 for BITABLE title search and Wiki `node_by_token` object resolution; this source uses newer Base APIs in other workflows, which this project does not silently substitute for its existing `bitable.v1` mappings
- [PGlite](https://pglite.dev/docs/) for the embedded PostgreSQL test engine

Feishu documentation pages that rendered no readable text through the web fetch were not treated as evidence for unverified scope strings or business error codes. The installed official SDK provides the concrete method/payload contracts tested here.

## Comment and file read semantics

`comments` returns `coverage: comments_page` with a separate `reply_cursor` for every incomplete preview. Pass that cursor back with the same document ID and page size to read `coverage: comment_replies_page`. The first full reply page replaces the preview; subsequent pages merge by `reply_id`. Keep the original document-page `next_cursor` separately to continue other comments. Only the first item on the first full reply page is labeled as the root. A continuation page remains partial by itself; `reply_sequence_complete` says the traversal reached the end, while `replies_complete` is true only when the returned array itself covers all replies. Missing data never proves completeness.

File `fetch` returns `coverage: metadata_only`, `content: null` and explicit `ok`/`failed`/`unknown` status. There is no content cursor or binary fetch. Batch metadata preserves each requested token in order, including provider failures and absent responses. Only file and DOCX metadata are currently supported, up to the verified provider limit of 200 unique tokens. Wiki file search references resolve through the authorized Wiki endpoint before reading the underlying file metadata.

## Task-read semantics

`FeishuProviderTasks.list` accepts the existing PRD's tasklist, assignee and status filters. With a tasklist it uses `tasklist.tasks`, preserving empty pages when `has_more` is true; combined assignee filters are evaluated on explicit returned user/assignee membership. Without a list, an explicit assignee uses `task.search` and exact-ID detail reads. The default uses the `my_tasks` endpoint and explicitly states current-user coverage, never pretending to query another person.

At most twenty detail checks are accepted per assignee-search call, sequentially; gateway retries can produce up to three HTTP attempts per check. This is a local budget, not an asserted provider maximum. Failed detail reads, unknown membership/completion and changed filters appear as omitted hits with partial coverage. Token/authorization failures stop the call. Due timestamps and all-day flags stay in provider form. User names are not resolved or guessed by this workflow; callers must select an explicit person ID first.

## Base selection semantics

`FeishuProviderBases.search` requires a title keyword of at most 30 Unicode characters. It never claims an all-app listing. Candidates stay ambiguous when more results exist, and none is automatically selected. The Base-only SDK wrapper fixes both search filters to BITABLE and rejects other returned resource types before returning data. A Base-only logical authorization cannot use it to read DOCX content.

Direct candidates expose a Base ID. Wiki candidates expose a signed reference and a separate Wiki node token, not an invented app token. `inspect` resolves a selected Wiki through the official `node_by_token` route, requires `obj_type: bitable`, then uses the returned object token with the existing bitable table mapping. A changed Wiki object invalidates table continuation. Without a table ID it returns table candidates; with a selected table it returns the reviewed schema. It does not auto-select even a sole table. Schema and record pages must be explicit and well-formed; missing arrays/pagination are not treated as empty complete data. The provider's actual support and grants for these calls remain unverified until a real authorized test tenant exists.
