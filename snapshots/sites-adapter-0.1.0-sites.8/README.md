# Feishu Sites adapter source snapshot

This directory preserves the standalone TypeScript/Cloudflare Workers adapter at package version **0.1.0-sites.8**. It is separate from the repository's Node/PostgreSQL implementation and is not wired into the root build or deployment.

The adapter exposes one read-only MCP tool, `get_agenda`, and a small connection UI. It does not expose the broader Node tool catalog or document/task write workflows. This source snapshot is not a claim of successful real-account OAuth, resolved provider error 20049, or production readiness.

## Included implementation

- Sites-authenticated principal boundary, exact-origin checks and owner-scoped storage
- Native form POST, expiring encrypted CSRF, atomic single-use form claim, fixed server HTTP303 handoff, state and Secure/HttpOnly/SameSite cookie binding
- S256 PKCE, encrypted pending bindings, one-use callback consumption, bounded provider diagnostics and safe error receipts
- AES-GCM credentials, grant/epoch fencing, single-winner refresh lease and fail-closed uncertain redemption
- Bounded calendar traversal, recurring instances, explicit partial coverage and continuations
- Synthetic mode that blocks real OAuth and provider transport
- D1 schema/migrations, build scripts, locked dependencies and synthetic unit/workerd/HTTP/served-script tests

Only the connection homepage uses `Referrer-Policy: same-origin`; redirects and callback/error pages retain `no-referrer`. Opaque, absent and foreign Origin values remain rejected. Protocol endpoints and security logic are preserved; publishing this snapshot does not introduce an alternate provider endpoint.

## Run the synthetic checks

Run from **this directory**, using Node.js 24:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix runtime-check
npm run typecheck
npm test
npm run check:source
npm run check:package
npm run check:workerd
npm run check:oauth-wire
npm run check:form-http
```

Tests use disposable synthetic databases and intercept provider calls. They need no real app credentials or account data. Generated builds, test databases, runtime reports and installed dependencies are excluded. HTTP and VM checks are not real-browser or live-account acceptance.

## Configuration and handoff

The hosting manifest contains only logical D1/MCP configuration, without a registered project ID. No deployment audience, app ID, Site URL, user identity, runtime key, grant, database contents, request log or private Git history is included.

See [handoff](docs/HANDOFF.md), [security](docs/SECURITY.md), [contracts](docs/CONTRACTS.md) and [validation](docs/VALIDATION.md). `SNAPSHOT-MANIFEST.sha256` covers all shipped files except itself.

This preservation branch requires separate integration review and normal repository CI before any merge or deployment. Publishing source does not activate the adapter or provision a Site. MIT attribution is preserved.
