# Changelog

## 0.1.0-dev.5

- Completed explicit nested comment-reply paging through document-bound signed cursors, root labeling and cycle/budget checks
- Added file search-to-metadata-fetch with scoped signed references; no binary download or fabricated file text
- Preserved batch metadata failures and unknown responses, rejected unrequested/duplicate/mismatched resources and limited output projection
- Rejected mismatched DOCX metadata IDs and malformed comment/reply pages
- Expanded to 244 offline tests; live MCP routing and production configuration remain closed

## 0.1.0-dev.4

- Added fixed-endpoint, user-only name/email search from the official CLI contract, with ambiguous-candidate and query-refinement semantics
- Added capacity-aware room discovery plus individual-room busy checks; missing/failed information remains unknown
- Added cycle detection to room/calendar/Base provider continuation and enforced verified Drive search bounds
- Added traceable minimum-provider-permission evidence, explicitly separate from actual user grants
- Hardened source exports against editor/patch backups
- Required strictly numeric room capacities and offset-aware busy intervals; rejected missing/oversized room pages before availability fan-out
- Expanded to 214 passing tests including independent-review boundary regressions
- No live credentials, external writes, real invitations, public deployment or live MCP exposure

## 0.1.0-dev.3

- Added scoped, explicitly paginated unified DOCX/Wiki/message search with signed fetch references
- Added Wiki-node-to-DOCX resolution and content-version-bound fetch continuation
- Added authoritative message-to-thread resolution with validated reply identities and pagination
- Added comment reply completeness flags and safe meeting-slot suggestions from complete busy data
- Enforced explicit chat/sender constraints on returned message search results
- Rejected repeated/cyclic provider pagination and limited per-query continuation budgets
- Kept missing comment reply arrays partial and rejected unavailable message bodies
- Kept Base/file aggregate search, name resolver and live MCP/production authorization outside the completed surface
- All provider behavior remains tested offline; no live connection or public listener is enabled

## 0.1.0-dev.2

- Added 20 finite official Feishu SDK read bindings; no generic API tool
- Added targeted profile, document/message search, task, Base and calendar mappings using actual SDK contracts
- Added safe SDK client configuration with silent credential-sensitive logs, timeouts and redirect limits
- Added Feishu token exchange/refresh core, encrypted subject-bound one-time PKCE state and PostgreSQL account-link transactions
- Added embedded PostgreSQL migration/repository integration tests using PGlite
- Prevented late token writes from restoring revoked connections
- Expanded to 150 passing automated tests, including independent-review regressions
- Fixed disconnect/relink stale-refresh ABA with grant generation and token-revision CAS
- Treat missing/malformed busy intervals as unknown, reject unexpected search resource types and sanitize pool-acquisition failures
- Reject standalone dot-segment provider resource IDs
- Live mode remains closed; provider transport and OAuth calls are verified with injected synthetic responses only

## 0.1.0-dev.1

- Added a cloud-development, loopback-only synthetic MCP server
- Added 17 read tools and a complete 30-tool traceability catalog
- Added mock OAuth security checks, signed references, scope gates and encrypted token-storage interfaces
- Added PostgreSQL schema draft and parameterized storage adapter
- Added synthetic contract, OAuth, isolation, HTTP/MCP and adversarial tests
- No live Feishu connection, public deployment, directory submission or write actions
