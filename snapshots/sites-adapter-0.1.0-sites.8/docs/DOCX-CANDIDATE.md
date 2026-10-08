# Independent DOCX search/fetch candidate

This module is offline-only and not imported by the production Worker. It adds no MCP
tool registration, OAuth scope, permission, database schema, or deployment change.
The frozen 0.1.0-sites.9 release remains unchanged. The module requires an explicitly
injected transport and trusted access resolver; it never defaults to global fetch.

## Official evidence checked 2026-10-08

The official Lark CLI at commit cff1bdadbf8c8ab6601330bfbfca8610f9292e84 declares:

- [Drive search](https://github.com/larksuite/cli/blob/cff1bdadbf8c8ab6601330bfbfca8610f9292e84/shortcuts/drive/drive_search.go): `search:docs:read`, POST `/open-apis/search/v2/doc_wiki/search`, DOCX resource filter and bounded page size.
- [Document fetch](https://github.com/larksuite/cli/blob/cff1bdadbf8c8ab6601330bfbfca8610f9292e84/shortcuts/doc/docs_fetch.go): read-only `docx:document:readonly`, including user identity.
- [Official document guide](https://open.larkoffice.com/document/server-docs/docs/docs/docx-v1/guide) demonstrates user-token GET `/open-apis/docx/v1/documents/{document_id}/raw_content` for plain text. [Endpoint reference](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content).

The API detail pages returned titles without rendered permission tables during this
check. Scope evidence comes from the official CLI; the current CLI fetch implementation
uses a newer Docs AI path. This candidate deliberately keeps the separately documented
Docx raw-content endpoint and does not adopt that alternate endpoint. Live scope and
application support for raw-content remains an integration acceptance condition.

Current production calendar scopes do not include either document scope. The constants
in this module are evidence/guards, not consent. Missing permissions fail before any
transport call. Do not modify the production OAuth scope list or perform an authorization
experiment as part of this candidate.

## Minimal contract and limits

- Search accepts only a query (1–30 Unicode codepoints), page size (1–5), and opaque cursor.
- Only DOCX resources with DOC container type are accepted. Wiki, file, Base, mixed-domain
  results, unknown types and duplicate document IDs are rejected without fallback.
- Upstream URLs are never returned or fetched; only the fixed official search and
  raw-content paths are used. No arbitrary URL input or provider redirects.
- Search titles and snippets use UTF-16 code-unit budgets of 256 and 512. Truncation
  accumulates whole Unicode codepoints and never splits a surrogate pair; isolated
  surrogate units in provider titles/snippets are rejected. The encrypted title claim
  uses the same 256-unit limit.
- Result IDs use AES-GCM and bind Site, owner, current grant and permission fingerprint.
  They remain reusable for ten minutes, but are not deterministic across searches.
- Search cursors also bind query/page size, expire without sliding renewal, and track
  at most twenty provider page-token hashes to reject cycles.
- Fetch accepts only a generated result ID. It returns plain text, not rich formatting,
  media, attachments or Wiki resolution. Title is the search-time snapshot.
- Body is bounded to 262144 transport bytes / 60000 text codepoints. Larger responses
  fail explicitly. Pages contain at most 2000 codepoints and never split surrogate pairs.
- `truncated=true` always has a next cursor; `false` means no text remains. Cursors bind
  result ID/page size/content digest. Document changes require a restart instead of
  mixing versions. Output JSON is bounded to 20000 UTF-8 bytes.
- Access/grant/scope is rechecked before output. A disconnect/relink/permission change
  while awaiting the provider suppresses the response.
- Provider failures do not retry and never return raw error bodies or exception messages.
  Candidate output is marked synthetic and unverified; this is not live acceptance.

## Reuse and future integration conditions

The Node adapter's bounded search/result/cursor contract is reusable. Its Node SDK,
crypto handles and PostgreSQL/auth broker wiring are not imported into Workers. This
candidate uses fixed fetch-compatible HTTP and the existing Workers WebCrypto Vault.

The module itself does not implement a verified live-enable gate. Its current safety
boundary is exclusion from production imports/registration and unchanged production
scopes, plus mandatory test-supplied transport. Temporary native-D1 tests exercise the real asynchronous adapter; see
[DOCX/D1 integration](DOCX-D1-INTEGRATION.md) for its authorization linearization
boundary and conservative token-refresh reference invalidation. These tests do not
establish atomic response delivery against future database writes.

Before live integration: verify the exact raw-content endpoint, minimum scope and
user-token behavior for the target app;
obtain explicit authorization for the additional read scopes; adapt the production grant
resolver without weakening fencing; implement approved scope negotiation and per-tool
registration; decide partial-domain behavior; and run real-account end-to-end acceptance.
Existing three-scope token validation intentionally remains unchanged and would reject
unapproved expanded grants. Do not patch it merely to make this candidate accessible.

No Wiki, IM, Base, write tools, new credentials or deployment are part of this change.

## Offline validation

Run from this snapshot directory:

- `npm run typecheck`
- `npm test` (211 passing: 169 baseline and 42 candidate regressions)
- `node scripts/check-docx-workerd.mjs` (nine native Workers checks)
- `node scripts/check-docx-d1-workerd.mjs` (18 real Workers/temporary-D1 checks)
- Existing package/source, workerd, OAuth-wire and native-HTTP checks

The production Worker bundle must remain byte-for-byte identical to the frozen sites.9
bundle. Candidate exports occur only in the test entrypoint. No live provider requests.

The current D1 bridge specifically reuses calendar Linking and therefore additionally
requires its existing calendar/offline scopes. DOCX-only grants are unsupported by this
bridge and fail before provider access. Do not infer independent minimum-scope consent
support from the standalone provider scope evidence.
