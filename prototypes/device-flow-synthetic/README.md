# Synthetic device-authorization state-machine prototype

**Live device authorization is unavailable.** This is an offline protocol/state-machine
exercise, not a replacement for the existing PKCE flow, not a fix for provider error
20049, and not evidence that an ordinary self-built Feishu app supports device grant.
No Sites or DOCX source, deployed tool, OAuth scope, schema, or frozen artifact is changed.

## Official evidence, pinned 2026-10-08

Reviewed official CLI commit `cff1bdadbf8c8ab6601330bfbfca8610f9292e84`:

- [device_flow.go](https://github.com/larksuite/cli/blob/cff1bdadbf8c8ab6601330bfbfca8610f9292e84/internal/auth/device_flow.go) requests device authorization, then polls with `urn:ietf:params:oauth:grant-type:device_code`; token endpoint resolution uses the OAuth v3 constant. The CLI initiation uses Basic client authentication; token polling includes client credentials in form data.
- [paths.go](https://github.com/larksuite/cli/blob/cff1bdadbf8c8ab6601330bfbfca8610f9292e84/internal/auth/paths.go) defines `/oauth/v1/device_authorization` and a separate `/oauth/v1/revoke`.
- [login.go](https://github.com/larksuite/cli/blob/cff1bdadbf8c8ab6601330bfbfca8610f9292e84/cmd/auth/login.go) calls the device-flow path, then verifies user information and stores tokens. Its no-wait CLI output may include a device code; this prototype deliberately never exposes one in the browser projection.
- [revoke.go](https://github.com/larksuite/cli/blob/cff1bdadbf8c8ab6601330bfbfca8610f9292e84/internal/auth/revoke.go) is a separate remote revocation operation. No revoke implementation is included here.
- [RFC8628](https://www.rfc-editor.org/rfc/rfc8628.html), especially sections 3.2 and 3.5, defines device expiry, default polling interval, pending and slow-down semantics.

These sources describe the official CLI, not target-app eligibility. Device grant does
not establish an authorization-code/PKCE endpoint pairing or diagnose error 20049.
CLI DPoP branches are deliberately not reused. This prototype implements stricter local
validation than several CLI defaults and is not a claim of provider-wire compatibility.

## Hard offline boundary

- Constructor requires `mode: "synthetic"`; other modes fail.
- No fetch/HTTP client, source credential, app secret, route registration, browser handler,
  grant writer, token store, user-info call, remote revoke, DPoP, or automatic poll loop.
- Only injected synthetic provider methods are called. They receive protocol-shaped
  requests, not an actual credential-bearing wire request.
- App names and device/access/refresh values must use synthetic prefixes. Verification
  URI is exactly `https://verify.example.test/device`; no real provider link is accepted.
- A valid synthetic token response is validated and discarded. Completion stores a state
  marker only. No provider token is ever returned or persisted, even on success.

Injecting an arbitrary malicious callback could itself perform external actions; this
module is not a sandbox for injected code. Tests use in-process functions and no network.

## State and protocol contracts

`MemoryCASStore` is an atomic, synchronous in-memory reference store. It clones rows on
read/write. A separate per-session monotonic time high-water mark is shared across
controllers; ordinary views and early polls update it without changing a poll lease or
business revision. Compare-and-swap checks the exact stored revision. It is not production
D1 or distributed persistence, and its CAS is not a distributed correctness claim.

The state machine binds owner, Site, app, exact requested scopes and owner epoch. It
snapshots the binding so a caller cannot mutate the object during asynchronous work.
It rechecks the trusted current-binding resolver before committing provider responses.

- States: starting → pending → polling → pending or completed/denied/expired/failed;
  cancellation can win against starting/polling, with late provider completion discarded.
- A never-resolving initiation has a separate 30-second local timeout covering the provider request and subsequent
  asynchronous binding revalidation, also checked
  against the clock on response receipt. Timeout/cancellation only fences local state;
  it does not claim that a remote device code was revoked. The final commit explicitly rechecks the original local deadline even if a timer
  callback was delayed. The timer is injectable for
  deterministic tests and is cleared when initiation completes.
- The absolute deadline is computed from the time before the initiation request plus
  the original provider `expires_in`. Responses, resume and repeated polls cannot reset it.
- Explicit expiry is required and bounded to 1–900 seconds in this synthetic contract.
  Missing interval defaults to five seconds; explicit interval must be an integer 1–60.
- Polls cannot begin before `next_poll_at`. One CAS winner acquires a single poll; other
  callers observe polling without sending another request. A lost in-flight poll is not
  stolen/redeemed again; it must terminate by expiry/cancellation/restart.
- Each `slow_down` adds five seconds permanently, with no downward cap that could violate
  the growing minimum. Subsequent polls wait from response receipt. Expiry is unchanged.
- A session is limited to 120 attempts. Caller-driven `pollOnce` never sleeps or schedules
  background work. Unknown/network/malformed results fail closed rather than retrying an
  uncertain token redemption.
- Success requires HTTP200, a valid Bearer synthetic token envelope, bounded integer
  lifetimes and an exact scope set. Error envelopes take precedence over token fields.
- Only a safe error allowlist is returned. Raw descriptions, error URIs, exception text,
  device codes and access/refresh values are excluded from user-facing projections.
- Browser projection exposes the plain verification URI and user code only while pending;
  the complete provider URL is validated but intentionally omitted.

The current-binding check and final synchronous CAS define the reference implementation's
commit boundary. A future remote resolver/store needs an atomic epoch check and CAS in
the durable transaction; an async lookup alone cannot exclude changes after its snapshot.
No promise is made to revoke a provider token remotely when cancellation wins.

## Tests

From this directory, with Node 22+:

    node --test *.test.mjs

38 tests cover strict provider shapes, deadlines/resume, interval/slow-down, single-poll
CAS, cancellation/late success, binding mutations, exact scopes, malicious URIs, token
and error redaction, clock rollback terminal-state behavior, shared clock high-water, and never-resolving initiation timeout.
No installation needed.

## Preconditions before any live work

1. Obtain authoritative provider confirmation that the exact target ordinary/self-built
   app and account type support device grant, including endpoints, client authentication,
   scope rules, polling errors and eligible verification hosts. CLI behavior is insufficient.
2. Obtain the user's action-time approval for any new persistent credential/access grant,
   the exact app/account and permissions. Do not infer permission from this prototype.
3. Implement separately reviewed durable encrypted state, atomic epoch/CAS fencing,
   authenticated owner/CSRF initiation, strict verification-URL policy, timeouts and
   post-token user identity verification before any connection commit.
4. Review token disposal/uncertain redemption and cancellation handling. Remote revoke
   is a separate consequential action; it is not an automatic fallback here.
5. Run a separately authorized live acceptance experiment. Do not modify or weaken the
   existing PKCE/Origin flow, swap endpoints, or claim error 20049 has been resolved.
