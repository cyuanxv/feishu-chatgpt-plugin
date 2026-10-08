# Single-agenda issuer candidate

dev11 is a separate, default-disabled integration candidate. It completes an **offline-tested protocol flow**, not real Feishu/ChatGPT or production acceptance:

1. An explicitly pre-registered MCP public client requests `calendar.read` for the exact resource with S256
2. A new browser capability is set in a Secure/HttpOnly/SameSite=Lax host-only cookie; the separate Feishu state and verifier are stored encrypted and bound to that browser
3. The browser is redirected to Feishu's documented authorization endpoint for the two calendar scopes plus `offline_access`
4. The callback consumes the bound state once, exchanges the code through the official SDK v3 confidential-client API, and obtains identity through user-token `user_info`
5. The user sees the configured client name and current provider account name, then explicitly allows or cancels read-only calendar access through a same-origin, CSRF-protected form
6. Allowing stores encrypted provider credentials for the verified tenant/open_id account and creates a short-lived, one-use MCP authorization code
7. The SDK token handler delegates to transactional code/PKCE verification, which issues an opaque MCP token tied to client, resource and account generation
8. The existing resource candidate validates that token and invokes only `get_agenda`; it never forwards the MCP bearer to Feishu

The default mock broker remains a loopback-only synthetic harness. Neither its demo account selector nor manually seeded SQL is a production authorization path. `live_verified` remains false.

## Verified protocol sources, checked 2026-10-06

- [Feishu authorization code](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code): `https://accounts.feishu.cn/open-apis/authen/v1/authorize`, registered exact redirect URI, `response_type=code`, state and S256
- [Feishu v3 token](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3): `https://accounts.feishu.cn/oauth/v3/token`; ordinary self-built apps remain confidential clients requiring their secret, even with PKCE
- [User information](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get): user Bearer token; the endpoint itself requires no extra scope for `open_id` and `tenant_key`. Email, mobile and employee identifiers are not requested or stored by this candidate
- [Feishu v3 refresh](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3): `offline_access` must actually be granted; refresh tokens are single-use and expiry follows the returned values
- [OpenAI authentication](https://developers.openai.com/plugins/build/auth): OAuth resource binding, S256, pre-registered clients and issuer identification. Copy the exact client redirect from the management page; never infer a callback ID. The candidate returns `iss` with successful/denied/error redirects

The two business API scopes are `calendar:calendar:read` and `calendar:calendar.event:read`. `offline_access` supports a refreshable provider grant; the candidate currently **does not automatically refresh Feishu tokens**. An expired provider token causes reauthorization. MCP refresh rotation is a separate local protocol and does not refresh the upstream Feishu credential.

## Persistence and limits

Migration 004 stores hashed browser capabilities, authorization codes and MCP tokens, plus encrypted pending provider credentials. Stable opaque account identifiers are keyed by configured app, provider, tenant and open_id. Explicit reauthorization currently replaces that account's provider grant and increments its generation, invalidating earlier MCP access for that connection.

Browser attempts expire after ten minutes; MCP codes after sixty seconds, access tokens after fifteen minutes and refresh families after one absolute day. These are this candidate's local policy, not promised Feishu lifetimes. Used code/refresh hashes remain to detect replay. Correctly bound replay commits grant-wide revocation; bad client/resource/PKCE substitutions do not consume a valid grant. Native PostgreSQL locks follow connection-before-grant order for refresh/disconnect; CI adds independent-connection races rather than relying on PGlite to prove concurrency.

Unconsented encrypted browser credentials are removed on cancellation or opportunistically on the next authorization after expiry. An operator retention job is still needed for idle services and historical grant/replay rows. Callback failure is not retried automatically because authorization codes are one-use. Consent/linking failures require starting again. No raw credential or provider error is rendered in the browser. The consent page keeps a restrictive CSP while adding only its current, revalidated client callback (including path) to `form-action`, so the form can complete the cross-origin OAuth redirect. It does not allow other registered clients or a generic HTTPS source; unsafe CSP characters/wildcards in redirect configuration are rejected. See [the W3C OAuth redirect discussion](https://github.com/w3c/webappsec-csp/issues/8).

## Operator configuration, after approval

`npm run start:issuer` refuses startup with exit 78 unless `FEISHU_AUTH_RUNTIME=issuer`. The container can run the compiled `main-issuer.js` as a separate process; its default command remains the resource candidate. Both processes require a reviewed HTTPS ingress, and neither has been deployed.

The issuer needs `MCP_AUTHORIZATION_SERVER` as a canonical HTTPS origin, `MCP_RESOURCE_URL` as the exact resource `/mcp`, and `MCP_OAUTH_CLIENTS_JSON` containing a bounded pre-registered public-client ID/name/exact-HTTPS-redirect allowlist. It does not support DCR, CIMD, client-secret authentication at the MCP token endpoint, or arbitrary client metadata fetching. The Feishu upstream app is separately confidential and requires its own secret.

The Feishu callback is the chosen issuer origin plus `/oauth/feishu/callback`. The MCP host redirect is a different address, copied from the host's management page into the client allowlist. Do not configure a placeholder domain or paste a ChatGPT conversation URL into either field.

Secure operator settings also supply the Feishu App ID/Secret, `FEISHU_DOMAIN=feishu`, verified-TLS database URL, shared token-encryption key and an independent state-encryption key (`FEISHU_STATE_KEY_BASE64`). The resource process additionally needs its independent handle-signing key. Real values must be entered by the user in the approved provider's secure settings, never in chat, source, screenshots or fixtures. No real App ID is present in this export.

## Remaining acceptance work

Independent review and exact-commit Node/container/native-PostgreSQL CI; concrete approved hosting/domain; actual app scope approval and securely configured secret; real Feishu browser login/consent/denial/reconnect; valid-HTTPS Secure-cookie and browser usability tests; actual tenant calendar/recurrence/all-day behavior; ChatGPT linking and MCP execution; hosted PostgreSQL roles/TLS/concurrency, key rotation, retention, ingress limits and operational review. No token refresh, directory submission or production-readiness claim follows merely from a green synthetic flow.
