# Architecture and status

The project retains the intended TypeScript/Node/PostgreSQL/BYO Feishu application architecture. The current executable is a test harness for the remote MCP contract and does not replace production OAuth or a live Feishu integration.

## Request flow implemented

1. Loopback HTTP validates Host/Origin, bounds the request and authenticates a demo bearer token
2. MCP SDK handles initialization, tool discovery and calls using Streamable HTTP
3. ToolEngine validates arguments, gates logical scopes, rate-limits the connection and selects a synthetic workspace after identity checks
4. Typed read handlers enforce object boundaries, filters, explicit timezone, field schema validation and signed connection-bound references/cursors
5. Output schema validation produces a structured success/error envelope and an allowlisted metadata audit event

## Production architecture retained, not deployed

ChatGPT/MCP client → production OAuth 2.1 authorization provider → Feishu OAuth bridge → encrypted token store in PostgreSQL → targeted Feishu SDK domain services → stable MCP tool contracts.

The included AES-GCM token vault, parameterized PostgreSQL store and token-refresh coordinator are separately tested primitives. They are not secretly used by the demo server: synthetic MCP authorization is memory-only and disappears on restart. Feishu refresh tokens are not created by the demo OAuth flow.

`@larksuiteoapi/node-sdk` is pinned in the lockfile and used by concrete read bindings plus a provider token-exchange core. Tests exercise the real SDK with an injected HTTP transport. These adapters are not exposed through the mock MCP listener and have not contacted Feishu. Public MCP tools must not shell out to CLI commands or expose generic API execution.

The in-memory OAuth maps deliberately store token hashes. The mock broker issues test tokens only. Production must add user authentication/consent, trusted client registration, durable grant state, signing/key rotation decisions and a complete Feishu linking flow. It must not reuse the synthetic account selector.

## Scope mapping

Logical scopes (`profile.read`, `people.read`, `search.read`, `im.read`, `docs.read`, `base.read`, `calendar.read`, `task.read`) are internal contracts. They are **not Feishu OAuth scope names**. Actual Feishu endpoint/scope mapping remains a live-integration task; requesting these invented logical strings directly from Feishu would be incorrect.

The aggregate search/fetch tools also check resource-specific logical scopes. `search.read` alone cannot authorize private documents or messages. People lookup has its own logical scope to avoid implicitly widening profile access.

## SDK compatibility

The initial implementation uses `@modelcontextprotocol/sdk` v1 as specified by the PRD, locked to the tested version. The official SDK has a newer split-package v2 line; v1 remains on a supported maintenance branch at the time of this development cut. Review support dates and migrate before production if required. Typescript `strict` and `noUncheckedIndexedAccess` are enabled. `exactOptionalPropertyTypes` is not enabled because the tested SDK transport declarations are internally incompatible with it.

## Source of requirements

The accepted PRD was completed on 2026-10-05 UTC. Its enumerated tool list contains 30 tools despite a heading that says 29. This repository tracks the complete enumeration. The private source document is not included in an export or a public release.
