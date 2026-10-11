# Provider and browser contracts

This version preserves the following fixed operations:

| Operation | Endpoint | Binding |
| --- | --- | --- |
| Authorization | `https://accounts.feishu.cn/open-apis/authen/v1/authorize` | Exact configured callback, state, S256 |
| Exchange/refresh | `POST https://accounts.feishu.cn/oauth/v3/token` | Confidential-client body credentials; one-use code/refresh token |
| Identity | `GET /open-apis/authen/v1/user_info` | User token; provider tenant/open ID |
| Calendar catalog | `GET /open-apis/calendar/v4/calendars` | Bounded pagination |
| Instances | `GET /open-apis/calendar/v4/calendars/{id}/events/instance_view` | Unix-second window and explicit partial coverage |

Scopes are `calendar:calendar:read`, `calendar:calendar.event:read` and `offline_access`. Actual returned scopes are checked. A successful login notification does not establish successful token exchange or API access.

Token bodies use `application/x-www-form-urlencoded`. Connection starts accept exactly one `csrf` form field and return HTTP303 only after identity, exact Origin, CSRF and single-use checks. The final authorization URL has a fixed official host/path, unique fields, configured client/redirect/scope, state and S256. Final token serialization is checked against the sealed binding. Browser JavaScript does not construct provider URLs.

Only response header `x-tt-logid` is eligible as a provider trace: 8–128 bounded ASCII letters/digits/underscore/hyphen, starting alphanumeric. Raw provider bodies, codes, tokens and verifiers are excluded from error receipts. Provider and local correlation IDs have separate labels.

The homepage uses `Referrer-Policy: same-origin`; callback/error pages and HTTP303 retain `no-referrer`. Null and foreign origins remain rejected. CSP limits form destinations to self and the fixed official accounts origin; the server additionally fixes path and fields.

This snapshot preserves an integration contract, not a guarantee of provider acceptance. No endpoint changes or authorization experiments are part of source preservation.

Primary references:

- [Feishu authorization](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code)
- [Feishu v3 token](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3)
- [Feishu v3 refresh](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3)
- [Fetch Origin generation](https://fetch.spec.whatwg.org/#append-a-request-origin-header)
- [PKCE RFC7636](https://www.rfc-editor.org/rfc/rfc7636)
- [D1 atomic operations](https://developers.cloudflare.com/d1/worker-api/d1-database/)
