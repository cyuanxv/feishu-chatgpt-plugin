# Security and persistence boundary

Only an owner-private Sites deployment is supported. The dispatcher authenticates browser/MCP users and supplies oai-authenticated-user-id. Data access is keyed by this Site-scoped identity and configured Site origin. Service credentials do not produce a user identity. Do not expose this bundle as a public raw Worker or substitute model arguments, email, query values or caller-spoofed headers. Discovery is metadata-only; data-bearing routes require trusted identity.

Tests model this boundary; they cannot prove Sites strips forged headers for a new Site. That requires platform acceptance after registration. Verification from a separate Site does not establish this Site's identity boundary. No existing Site configuration, user identities or credentials were copied. A synthetic same-site callback is not evidence of a real external Feishu roundtrip.

## User grants

Authorization starts through a same-origin POST with an encrypted expiring user-bound CSRF token. Feishu state and a separate Secure/HttpOnly/SameSite=Lax cookie bind the callback to the browser and Sites user. D1 stores hashed state and encrypted PKCE verifier. Atomic DELETE ... RETURNING consumes state only for matching user, cookie, expiry and owner epoch.

The connection homepage alone uses Referrer-Policy: same-origin. Fetch serializes a non-CORS native form POST's Origin as null under no-referrer; preserving same-origin metadata avoids rejecting the legitimate form. This is not an Origin fallback: null, absent and foreign Origin values are still rejected. Callback/error pages and HTTP303 responses retain no-referrer, so provider authorization query values do not become referrer data. Unexpected queries on the homepage are rejected before its policy override.

The confidential-client exchange includes the server-held Feishu secret and S256 verifier. user_info supplies tenant_key and open_id; names and client arguments cannot select identity. Only the actual granted scope set is accepted. Tokens, verifier and encryption key never leave through MCP or HTML. Names render with textContent; email/phone/employee fields are discarded.

D1 stores AES-GCM credential ciphertext. The root key stays separately in Sites secret settings. AAD separates Site, user, grant and purpose; every encryption uses a random nonce. The current key format is v1. Production key rotation and retention still need validation; losing/changing the key may require reconnecting existing accounts.

## D1 concurrency is not PostgreSQL row locking

No SELECT FOR UPDATE or transaction spanning HTTP is assumed. Owner epochs fence pending OAuth start/consume/save. Every new grant gets a random ID, even when delete/reinsert returns version to one. Disconnect batches the epoch change and state/credential deletion atomically, bound to the expected grant and epoch. Stale disconnects cannot remove newer grants.

Refresh claims a single-winner conditional UPDATE lease bound to Site/user/grant/version. It redeems once, then atomically replaces ciphertext/scopes/expiries only if grant/version/lease still match. Stale success or failure cannot overwrite or invalidate a new authorization. Failures or uncertain outcomes invalidate only the matching lease. Expired abandoned leases require reconnection; they are not stolen to replay a one-use token. External redemption and database commit cannot be one atomic transaction, so a crash after redemption requires reconnecting.

Queries use primary D1, with no read replication enabled. Every provider operation checks the active grant, and traversal rechecks before returning data. Disconnect cannot undo a provider request already in flight. Local disconnect is not a claim that Feishu upstream authorization has been revoked.

## Bounded reads

Only fixed Feishu hosts and paths are callable. Manual redirects are rejected. Bodies, timeouts, time window (31 days), directory pages, calendars (20), instances (200 per view), output and per-user rates are bounded. Errors are sanitized. Malformed/unknown data, cursor cycles and changed snapshots fail closed; known per-calendar HTTP 403/404 remains partial coverage.

All-day filtering retains the prior UTC basis and original provider encoding; actual tenant timezone behavior is unverified. Source text may contain hostile instructions and is marked untrusted. Writes and general executors are absent.

## Synthetic deployment boundary

FEISHU_DATA_MODE=synthetic is a server-only setting, never a model argument. It bypasses no identity check. It hard-disables provider HTTP and every /api/feishu/ route, including callback and disconnect, and reports connected=false without reading existing grants. Fixture IDs use a separate D1 table keyed by Site origin and trusted user identity. Metadata, UI and every result identify synthetic_fixture; no actual-account claim is made. The existing request budget applies. Only synthetic and feishu are accepted explicit mode values; unknown, differently cased, whitespace-suffixed or empty values fail closed before routes or provider HTTP. An unset mode preserves R2 compatibility but still requires the original explicit real-read and credential gate.

## Browser demonstration versus MCP transport

The browser uses POST /api/demo/agenda with the Sites-authenticated principal, exact Origin check, bounded JSON, strict agenda arguments, synthetic-only gate and the same per-owner rate budget as MCP. It calls the existing synthetic fixture function; no generic tool dispatcher or real provider route is exposed. The platform-owned /mcp authentication boundary is unchanged. Browser login cookies are not treated as MCP authorization. Non-JSON or 401/403 platform responses produce a safe login message, never a JSON parser exception or raw response body.

Provider-failure diagnostics whitelist only a fixed operation/kind, HTTP status, recognized OAuth error enum and bounded numeric provider error code. Never log token request bodies, authorization codes, PKCE values, client values, response bodies, descriptions, identities, cookies or exception messages. Boolean configuration checks do not establish that an app secret is valid with Feishu. Consumed OAuth state/code is never recovered from logs or replayed.
