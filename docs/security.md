# Security model and production gaps

## Enforced in this development build

- Loopback-only binding, exact Host matching and hostile Origin rejection
- 64 KiB request size limit, HTTP timeouts and bounded OAuth request rates
- Public demo clients restricted to exact loopback callback URIs; PKCE S256 only
- Authorization codes are short-lived, single-use and bound to client, redirect URI and MCP resource
- Access and refresh tokens are random, kept only as SHA-256 lookup hashes in the test broker, with expiry, rotation and family revocation on refresh replay
- Logical scopes are checked per tool and per search/fetch resource type
- Synthetic connections enforce tenant, subject and connection identity together
- Resource references and pagination cursors use HMAC, expire and bind to connection and query
- AES-256-GCM ciphertext uses identity-bound associated data; key IDs support explicit key rotation
- PostgreSQL statements use bound parameters and include subject/tenant predicates
- Logs use a fixed metadata-only schema. They contain no tool arguments, source content, raw account IDs or credentials
- Source text is untrusted data. No write tools or arbitrary network execution are available

## Not yet established

The mock OAuth broker does not authenticate users, display consent, implement Feishu OAuth, implement production client trust policies or provide durable authorization state. It must not be publicly reachable. It is intentionally not a production OAuth server.

The in-memory read adapter selects a synthetic workspace snapshot. A real adapter must make targeted authorized API calls, never mirror an entire user's workspace simply to answer a single query. No live adapter is implemented yet.

The PostgreSQL repositories are now tested with both query stubs and PGlite's embedded PostgreSQL engine. A deployed database still needs restricted runtime roles, native/multi-connection integration validation, appropriate RLS/service policies, backups, key management, retention decisions and operational monitoring. The SQL files do not claim to complete those controls. The application layer enforces ownership; the migrations do not enable RLS.

Refresh singleflight is process-local. Database connections carry a grant generation and tokens carry a revision. Refresh writes and failed-refresh revocation compare both values under an active connection row lock. Reconnecting the same ID advances the generation, preventing old in-flight refresh success or failure from modifying a new grant. Disconnected memory-store connections use revocation tombstones. PGlite tests reproduce these interleavings in one process; production still needs true multi-connection scheduling validation, distributed refresh coordination, token rotation recovery and provider-side revocation behavior. Production MCP authorization must also bind grants to current connection state/generation.

Prompt-injection tests here check that source data cannot make the server call unavailable tools. They do not prove that a host model will never follow source text. Host-level adversarial and tool-selection evaluations remain necessary.

## Handling security reports

Until a private vulnerability-reporting channel is configured, do not put secrets, private account content or exploitable production details in public issues. This preview has no public production endpoint.
