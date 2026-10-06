# Agenda resource-server candidate

This is a bounded integration candidate, not a deployed or production-validated plugin. The default mock executable is unchanged. The new server exposes one existing tool, `get_agenda`; it does not expand the public tool plan.

## What now runs in tests

HTTP Bearer header → SHA-256 lookup in `mcp_access_tokens` → active `oauth_grants` and matching subject/account generation → internal `calendar.read` plus actual Feishu calendar permissions → encrypted current user token → `ProviderReadRouter` → calendar list and recurring-event `instance_view` → MCP response.

Each provider operation rechecks the persisted grant and generation. Missing/expired/revoked grants fail closed; a lost connection-wide grant is not disguised as a per-calendar partial 403. A request that has ended cannot start another provider read. Already in-flight requests cannot be retroactively undone. MCP tokens are never forwarded to Feishu; reads force user tokens, with no bot fallback or automatic refresh. Refresh is intentionally absent here because refreshed scopes and grant state must be updated atomically by the reviewed linker.

Migration `003_resource_access.sql` stores actual provider scopes separately from internal MCP scopes and adds hashed access-token records. A future reviewed issuer is the only writer of access-token/grant rows. The HTTP resource server has no `/oauth/authorize`, token, registration or grant-seeding route. **Synthetic test SQL is not a deployment/identity verification path.** The production issuer must authenticate the human, obtain consent, bind the OAuth client/resource/scopes, validate PKCE, link a verified Feishu identity and issue high-entropy opaque access tokens tied to the current generation. These issuer routes are not implemented by this slice.

## API evidence

- [Current MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization): resource-specific access-token validation and protected-resource metadata
- [Official Feishu calendar catalog](https://github.com/larksuite/cli/blob/main/internal/registry/catalog/services/calendar.json), checked 2026-10-06: `calendar.list` and `calendar.event.instance_view`, with read-only alternatives; this candidate chooses `calendar:calendar:read` and `calendar:calendar.event:read`
- Installed official SDK 1.74.0 `calendar.v4.calendarEvent.instanceView`: expands recurring events and accepts start/end Unix seconds; it has no provider page-token contract. The candidate applies a conservative 31-day window and 200-instance cap, then signs local continuation against a content version

The old `events.list` adapter remains available for its prior offline contracts; it is not used for the candidate's expanded agenda. Broader scope alternatives are not requested automatically. Resource visibility is still enforced by Feishu and has not been tested against a real tenant.

## Deployment/build boundary

`npm run build && npm run smoke:production` validates compiled imports and refusal without explicit setup. `npm run start:provider` exits with code 78 unless `FEISHU_PROVIDER_RUNTIME=agenda`. Enabling that gate is an operator deployment action, not a step performed in this development task.

After the issuer, real consent and hosting design are approved, secure operator configuration must supply:

- `MCP_RESOURCE_URL`: exact HTTPS `/mcp` resource; `MCP_AUTHORIZATION_SERVER`: actual reviewed HTTPS issuer
- `FEISHU_APP_ID`, `FEISHU_DOMAIN` (`feishu` or `lark`), and securely supplied `FEISHU_APP_SECRET` required by the official SDK constructor
- `DATABASE_URL` and independent 32-byte base64 `FEISHU_TOKEN_KEY_BASE64` / `FEISHU_HANDLE_KEY_BASE64`; no real values belong in examples, chat, logs or the repository
- An ingress that terminates valid HTTPS, preserves the configured Host and restricts access to the internal listener; PostgreSQL verified TLS, migration/runtime role separation, key management and native concurrency validation

The entrypoint does not load `.env` files. It reads secrets only after the explicit runtime gate. It enforces certificate verification and strips supported `sslmode` query options before passing the connection string to `pg`, preventing those options from replacing the verified-TLS configuration; unsupported URL options fail with a sanitized error.

The Dockerfile builds from an explicit source allowlist, installs production dependencies without lifecycle scripts and runs as `node`. Docker is unavailable in the current executor, so image build/run remain unverified until the included CI job runs. The base image is a moving official Node 24 tag and should be pinned to a verified digest for an approved deployment. No hosted resource, public ingress, credentials or paid service has been created.

## Smallest next decisions

Confirm the manageable test enterprise/self-built app and Feishu versus Lark, then the approved HTTPS Node/PostgreSQL host. Complete the production human-login/consent/issuer around that concrete app and domain, with user-controlled secret entry and actual minimal scope approval. Only then perform real read-only tenant → OAuth → ChatGPT acceptance tests. This is more than filling in a key, and official-directory eligibility remains a separate unresolved gate.
