# Milestone evidence

## Second-slice update

The table below records the first-slice boundary. The second slice adds actual official SDK endpoint bindings and offline provider contract tests, the Feishu exchange core, encrypted one-time state, transactional connection linking, generation/revision-safe token refresh and PGlite migration tests. See [provider integration status](provider-integration.md) and [validation](validation.md) for current evidence. No real Feishu tenant, public production authorization flow or live MCP endpoint has been enabled. The nine-flow execution-boundary experiment is postponed and is not included in this source export.

## First-slice baseline

| Milestone | Current implementation | Remaining evidence / dependency |
| --- | --- | --- |
| M0 Project skeleton | TypeScript, lint-equivalent strict typecheck, build, test, health, MCP server, CI definition | GitHub CI has not run; npm layout rather than pnpm workspace packages |
| M1 Feishu test tenant | Synthetic accounts/tenants only | User-approved real test tenant, app and callback configuration |
| M2 OAuth metadata | Protected-resource and AS discovery, PKCE/resource contract | Production provider and external ChatGPT discovery test |
| M3 Auth broker | Loopback mock codes, refresh rotation, replay revocation | Real user login/consent, Feishu OAuth linking, durable grants, production authorization provider |
| M4 Token store | AES-GCM, identity-bound AAD, key IDs, memory store, parameterized Postgres adapter and SQL draft | Actual PostgreSQL migration test, role/RLS strategy, key management, lifecycle/revocation integration |
| M5 Profile | Synthetic connection profile and declared permissions | Real Feishu profile and host multi-account display verification |
| M6 Feishu adapter core | Typed domain model, synthetic adapter, bounded read retry/error mapping, process-local refresh singleflight | Real SDK adapter, provider pagination and scopes, distributed refresh locks |
| M7 Search/fetch | Authorized synthetic aggregate search, signed IDs, chunked fetch | Real Feishu domain search and fetch adapters |
| M8 Contacts | Name/email lookup, multiple-candidate flag | Real people API and actual visibility behavior |
| M9 IM read | Chat/message/thread filters and pagination | Real message search permissions and transport |
| M10 Base read | Schema, typed filters, sorting, projection, pagination | Real field type and upstream filter normalization |
| M11 Calendar read | Explicit timezone, agenda, busy times, candidate slots, room availability | Live calendars/rooms, daylight-saving and provider-specific edge-case validation |
| M12 Tasks read | Task query/detail and status/assignee filters | Real task API and permission checks |
| M13–M18 Writes | Full traceability; all 13 tools unregistered | Policy/idempotency/confirmation design plus real writes and cancellation tests |
| M19 Skills | Not packaged | Actual host workflows and skill evaluation |
| M20 Observability | Metadata-only allowlisted audit sink | Production sink, retention/consent choices, operational dashboards |
| M21 Eval/security | Automated unit/contract/HTTP/security suite | Independent review, host-model eval set and real cross-tenant security test |
| M22 Self-host docs | Synthetic run instructions and production gap list | Real BYO app/OAuth/deployment instructions proven on clean install |
| M23 Plugin packaging | Tool schemas; no public installation bundle | Stable HTTPS endpoint, installed host smoke tests, branding/metadata materials |
| M24 Release | MIT license, owner, source check, contribution/security/change docs | Independent review, approved public source push, CI on exact public commit |

Passed fixture tests must not be reported as completed real-provider milestones. A development source release can be honest and useful while most production evidence remains outstanding.
