# Cloud OAuth repair — 2026-10-11

## Failure and correction

The previously deployed adapter reproduced `provider_oauth_rejected / 20049` with real user reauthorization. Local S256 binding checks passed, but the code paired the authorize-v1 endpoint with token-v3.

The [official authorization documentation](https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code) currently explicitly instructs PKCE callers to pair this authorization endpoint with token-v2 while support for the latest token endpoint is pending. The v3 token documentation advertises standard PKCE, so these documents have an important compatibility inconsistency. Live verification of the documented v2 pairing succeeded; the v3 pairing failed in the same account and application.

`0.1.0-sites.13` uses `https://open.feishu.cn/open-apis/authen/v2/oauth/token`, JSON encoding, and the existing S256 verifier. Refresh uses the same endpoint. No token, secret, authorization code, or private calendar data is included here. Do not migrate back to v3 solely based on mock tests: require an official compatible authorization endpoint and a new real-account acceptance run.

## Calendar request correction

Live calendar listing then returned provider code 99992402. The implementation requested page_size=5, below the [official minimum of 50](https://open.feishu.cn/document/server-docs/calendar-v4/calendar/list-2). The request now uses 50 and the response validator accepts up to 50 entries. The existing explicit 20-calendar traversal budget remains; excess calendars fail with a budget error rather than silently claiming completeness. The browser read-check uses the same owner-bound Agenda reader, same-origin protection and rate limit as MCP. It displays partial coverage explicitly.

## MCP metadata compatibility

The standard MCP RequestParams `_meta` object is accepted but never used as tool input or identity. Unknown nonstandard fields remain rejected. A regression verifies that metadata cannot override the authenticated principal.

## Evidence

- Before repair: live OAuth 20049 reproduced.
- After repair: deployed private Worker completed real OAuth and user profile lookup; homepage returned connected state from encrypted D1 grant.
- Node regression: 214 / 214.
- TypeScript typecheck: passed.
- Actual Miniflare / workerd and D1: 18 checks passed.
- OAuth wire, one-use state and failure-race checks: 13 passed; upstream was mocked.
- Browser cloud calendar read succeeded with 7 real events and complete traversal for the selected seven-day range. No event contents are exported to this public repository.
- Native chat `get_agenda` succeeded after MCP metadata repair: 7 events, source=feishu_api, partial=false, traversal_complete=true, next_cursor=null, errors=[].
- The legacy response field live_verified=false is a static candidate marker, not a per-request provider verdict. The live acceptance recorded above was observed separately. Token-expiry refresh has synthetic race coverage but was not forced against the live grant.

## Operations

Use the existing owner-private Site and its registered project ID. Keep app credentials and encryption keys only in runtime secrets. Preserve the D1 database and existing migrations. This repair introduces no schema change. Build with `npm run build`; publish an archive from the exact pushed Site source commit. A public source checkout deliberately does not carry deployment identity or user data.

The deployment runs in Cloudflare Workers and stores encrypted grants in cloud D1. A user's computer is needed only for interactive consent, not to serve MCP calls. Refresh failure requires reconnecting; do not claim indefinite unattended authorization.

Rollback is a redeploy of the previous saved version using unchanged runtime secrets and D1. That version retains the known 20049 connection defect. Do not run a local tunnel as a fallback.
