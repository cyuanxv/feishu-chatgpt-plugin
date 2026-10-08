# Offline DOCX / D1 access integration

This candidate now contains an actual asynchronous access adapter, not just a synthetic
callback shape. It is still excluded from production imports, MCP registration and
OAuth scopes. No production schema or runtime configuration changes are made.

## Existing interfaces and adapter

- `Store.current(principal, grant?)` asynchronously reads the principal's connection and
  checks active status, encrypted credentials presence and optional exact grant ID.
- `Linking.access(principal, grant)` returns `Promise<{token,row}>`, may refresh using
  the existing lease/CAS flow, and returns the persisted Grant version.
- `createDocxD1Access(store, linking)` implements the candidate's `DocxAccess` callback.
  It awaits a current row, validates persisted scopes and the exact requested DOCX
  scope before accessing or refreshing tokens, awaits Linking, then rereads current D1.
  It requires the returned grant, version and scope snapshot to match that final row.
- The returned D1 revision is included in result-reference and cursor fingerprints.
  The workflow compares initial and final revisions before output, detecting scope
  A→B→A transitions even when the final scope set matches the initial set.

Integration must use this persisted revision adapter, not a resolver that drops the
revision. Scope/grant writers must increment the stored version for same-grant changes.
The existing Store rotate/save operations already increment version. This candidate
adds no scope-editing route. The test harness performs synthetic, versioned SQL scope
mutations only inside its temporary D1 database.

## Scope compatibility limit

This bridge reuses the existing calendar Linking implementation. Linking still requires
`calendar:calendar:read`, `calendar:calendar.event:read`, and `offline_access`. Therefore
this D1 bridge only supports an existing calendar connection additionally authorized for
the requested DOCX read scope. A DOCX-only grant is deliberately rejected with
`provider_scope_changed` before any provider call or refresh; it is not silently expanded.

The standalone DOCX provider's minimal read-scope evidence does not mean this reused
calendar connection flow supports independent DOCX-only consent. A future separate
minimum-scope connection policy would need its own reviewed token/refresh validation.
This candidate does not modify Linking, Feishu token validation, or production scopes.

## Normal refresh versus reconnection

A successful token refresh increments version. Consequently, old result IDs and cursors
are conservatively invalidated even when scopes are unchanged. This preserves ABA
protection rather than keeping older references usable.

- A stale result ID returns `invalid_reference` (400); a stale search cursor returns
  `invalid_cursor` (400). Repeat the search to get a new reference, then read again.
- A same-grant/scope version change between Linking and the final D1 reread, or
  during an in-flight read, returns `docx_state_changed_restart` (409).
  Discard the old page and restart the search/read workflow explicitly.
- The grant can remain active. These states do not mean OAuth consent was revoked and
  must not trigger a reconnect prompt or a new authorization experiment.
- There is no automatic replay of the old request or provider read.

Actual disconnect, changed grant, missing document scope, or failed refresh retain their
separate errors. A missing document scope is checked before Linking so it cannot trigger
an unnecessary upstream token request.

## Verified boundaries

`node scripts/check-docx-d1-workerd.mjs` uses real Miniflare/workerd, the unchanged D1
migrations and real Store/Linking/Vault implementations. Provider traffic is intercepted.
Eighteen checks cover successful search/fetch continuation, missing-scope preflight,
explicit DOCX-only-grant rejection, search/fetch each during disconnect, grant replacement, scope removal/addition/ABA, and
normal refresh invalidating old references while allowing a new search on the same grant.
They also cover refresh reducing DOCX permissions, a parallel refresh loser, and refresh
awaiting while disconnect or grant replacement commits. Old refresh responses cannot
revive disconnected state or invalidate the replacement grant.
Unit tests additionally force a mutation after Linking's promise resolves but before
the adapter's final D1 reread, and validate malformed scope handling.

These checks establish behavior when a tested mutation commits before the final D1
snapshot check. They do not retract bytes already sent or make the network response
atomic with future database writes. The final read is the authorization linearization
point; a revocation committed after that point can race response delivery. No claim is
made that an arbitrary production database integration is transactional across network
I/O. Hosted Sites dispatcher identity and real-account behavior remain unverified.

Before actual mounting: review the access resolver/principal boundary, verify exact
DOCX endpoint + minimum scope + user-token support, obtain any additional authorization,
and perform separately approved live acceptance. Keep production scope and registration
unchanged until then.
