# Feishu for ChatGPT: development preview

A TypeScript/Node.js remote MCP integration under development. The current build exposes 17 **read-only tools using synthetic fixtures**. It has never connected to a real Feishu account, and is not installed in ChatGPT or submitted to the public directory.

Repository owner: `cyuanxv` · License: MIT · Version: `0.1.0-dev.4`

## Current safety boundary

- The executable starts a **loopback-only synthetic demo**. It cannot bind to a public address or enable live mode.
- Its OAuth broker is a protocol test harness. It **does not authenticate people**. Demo account selection is intentional and only accesses synthetic records. Never put it behind a tunnel, reverse proxy or public service.
- No Feishu credentials are read, requested, configured or included. Tokens used in tests are generated or synthetic.
- Thirteen planned write tools are not registered. Raw API/HTTP executors, deletion, approval and admin operations are absent.
- The SQL migrations and encrypted repositories are tested against in-memory PostgreSQL via PGlite. Remote/native PostgreSQL, multi-connection locks, operational roles and production deployment remain unverified.
- This is not a submission-ready public plugin. Adding workflows does not resolve the directory's restriction on unofficial third-party connectors.

## Run in an authorized cloud development environment

Requirements: Node.js 22+ and npm. No local desktop or Work mode is required by the project.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm start
```

The listener is `http://127.0.0.1:3333`. `GET /health` reports the actual synthetic mode. `PORT` may select another unprivileged port. `FEISHU_MODE=live` fails closed. The project never loads an `.env` file automatically.

The HTTP integration tests use the official MCP SDK client to register a demo OAuth client, request a PKCE-bound code, exchange it in memory, initialize MCP and call tools. They do not print access tokens. See `tests/http.test.ts` for the reproducible test flow.

## Implemented read surface

- Identity: `get_profile`
- Search: `search`, `fetch`
- People and IM: `search_people`, `list_chats`, `search_messages`, `get_message_thread`
- Documents: `list_doc_comments`
- Base: `list_bases`, `get_base_schema`, `query_base_records`
- Calendar: `get_agenda`, `get_free_busy`, `suggest_meeting_times`, `list_meeting_rooms`
- Tasks: `list_tasks`, `get_task`

Every response identifies the source as `synthetic_mock`. Search/fetch results are signed and connection-bound. Responses and inputs are validated. Search requires both the search scope and each resource domain's scope. Missing permissions never grant broader access.

## Layout

```text
apps/mcp-server/         Loopback HTTP/MCP server and demo OAuth routes
packages/auth/          Test OAuth broker, encrypted token vault, PostgreSQL adapter
packages/feishu/        Domain types, synthetic adapter, retry and token refresh helpers
packages/tools/         Read-only business handlers
packages/schemas/       Input/output contracts and all 30 planned tools
packages/policy/        Scope checks, isolation, signed references, rate limits
packages/observability/ Allowlisted metadata-only audit events
infra/migrations/       PostgreSQL schema draft
tests/                  Protocol, security, contract and HTTP tests
docs/                   Architecture, roadmap, release and review limitations
```

The product document says 29 tools but enumerates 30. All 30 are tracked in [the tool catalog](docs/tool-catalog.md); none was silently removed.

## Provider implementation progress

The provider slices add 23 finite provider read bindings, targeted domain adapters, scoped document/message search-to-fetch (including Wiki DOCX resolution), message-thread reads, comment completeness tracking and meeting-slot suggestions. People search now returns ambiguous candidates without selecting a recipient; room selection combines known capacity with explicit-window availability and marks missing data unknown. Feishu token exchange/refresh primitives, encrypted one-time PKCE state and transactional account linking are also implemented. Contract tests run the actual installed SDK against an injected synthetic HTTP transport. Database integration tests execute real PostgreSQL SQL in memory through PGlite.

These modules are **not wired into the demo MCP listener**. They have not contacted Feishu or exchanged real credentials. See [provider integration status](docs/provider-integration.md) for exact endpoint coverage and incomplete features.

## Next verified milestones

1. Complete a production authorization provider, real identity/consent routes and the Feishu linking flow around the tested exchange core. Do not promote the mock broker to production.
2. Finish missing targeted domain workflows, verify actual provider scope mappings and test the implemented SDK adapters against a dedicated Feishu tenant.
3. Repeat PostgreSQL integration on the intended native/database service, configure operational roles and key management, and validate multi-replica refresh/revocation behavior.
4. Validate the read-only version in the intended ChatGPT host. The current fixture tests are not live integration or model routing evaluations.
5. Implement authorized write flows only after scope, idempotency, recipient resolution and external-action confirmation are verified.
6. Check public directory eligibility before preparing any submission. Keep source releases distinct from hosted publication and directory approval.

This is an independent project. It does not claim affiliation with, endorsement by, or official status from Feishu/Lark or OpenAI.
