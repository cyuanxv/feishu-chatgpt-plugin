# Validation record

## Thirteenth slice, default-off document creation

The candidate adds end-to-end synthetic tests through real PostgreSQL-compatible SQL and the installed official SDK injected transport. Preview makes no provider request; signed trusted-host approval binds exact content, destination and current authorization; an atomic durable claim permits at most one POST; uncertain results are never retried as creates. Async status reads preserve pending/uncertain state and cannot regress successful receipts. Native PostgreSQL adds five concurrency cases to the existing five issuer cases, run only in the ephemeral CI service. Full counts, independent review and exact-commit CI are recorded in the PR. No write scope, real credentials, user data, hosting or existing runtime configuration was changed.

## Twelfth slice, reviewed read-only branch integration

Version `0.1.0-dev.12` combines the default-disabled agenda HTTP/issuer candidates from PRs 6–7 with the message-search filters from PR 8. The combined source preserves both histories; no live configuration, OAuth grant, credentials, private data or deployment is included.

The new filter slice passed 416 tests before integration and independent review added 504 precision/offset checks across four entry points. That review found and corrected silent subsecond time truncation, including sub-millisecond values. The merged candidate retains all existing agenda/issuer tests and all 47 search-filter regressions. Integration review additionally reproduced stale authorization across retry backoff. The gateway now revalidates authorization and token expiry before every transport attempt, with 12 regressions for revocation, closed requests, lost scope, expiry, invalid credentials, refreshed tokens and retry limits. The combined cloud suite passes 539 tests, with five native PostgreSQL cases explicitly skipped locally. Final native PostgreSQL, Docker and exact-commit CI results are recorded in the integration PR; a skipped native database test is never represented as a local pass.

No GitHub workflow deploys a service or pushes a container image. Production startup still requires explicit provider/issuer gates and reviewed secure configuration. Green source integration does not establish real OAuth or ChatGPT readiness.

## Eleventh slice, single-agenda browser/issuer candidate

`0.1.0-dev.11` has 480 passing local tests across twenty active files, plus five explicitly skipped native PostgreSQL concurrency cases awaiting CI. Typecheck, build, both compiled default-disabled entrypoint smoke checks and source allowlist checks are required for this cut. New tests cover browser-bound provider state, confidential-client v3/S256, verified tenant/user identity, explicit same-origin CSRF-protected consent, exact OAuth client/redirect/resource binding, durable code/token replay, refresh-family revocation and HTTP agenda reads with separate provider credentials. The full browser-to-agenda test creates grants through the candidate flow rather than SQL seeding.

The native PostgreSQL cases use only the dedicated ephemeral GitHub CI service and an owned random schema. They do not read DATABASE_URL or operator credentials. They are not a local pass and do not validate a hosted database, TLS, backup, key management or real Feishu refresh. The dev10 Docker image and disabled-startup checks passed public CI; dev11 image/issuer checks require the new exact-commit run. No real account authorization, secret configuration, deployment, browser usability/HTTPS-cookie test or ChatGPT installation has been performed.

The first dev11 review identified that a consent form protected only by `form-action self` can block the final cross-origin OAuth redirect in browsers. R2 keeps the other CSP directives and allows only the current persisted, revalidated callback URI on its consent page. It rejects CSP separators/wildcards in registered redirect configuration and tests separation between two clients. A cloud-browser attempt to reach the synthetic loopback fixture returned `ERR_BLOCKED_BY_CLIENT`; the tab/server were closed, with no alternate access path or browser-pass claim. Real HTTPS browser acceptance remains required.

## Tenth slice, one-tool HTTP resource candidate

Version `0.1.0-dev.10` has **414 passing tests across eighteen files** before independent review. New tests run the actual HTTP/MCP path through PGlite-backed opaque access-token/grant validation, current account generation, actual provider-scope checks, encrypted credential loading, the existing provider router and the official SDK's injected recurring-instance transport. Cases cover revoke/relink, lost scopes during traversal, wrong audience/subject, same-tenant account isolation, token separation, duplicate headers, streamed body limits and stable instance pagination.

Typecheck, complete test suite, TypeScript build, compiled provider-entrypoint import/refusal smoke and source allowlist checks run in the current cloud environment. The baseline was restored from the verified dev9 export after the old shared path disappeared; tests use an isolated copy of the existing dependency tree. No fresh dependency install was performed.

Docker/Podman are absent in this cloud executor, so the Docker image has **not** been built or run here. A CI build-and-default-refusal job is included for review and later verification against the published commit. The Node smoke verifies the compiled entrypoint and disabled default only. PGlite still does not establish native PostgreSQL multi-connection behavior or TLS. No actual Feishu authorization, production token issuance, public listener, ChatGPT host or deployment was tested.

## Ninth slice, finite provider routing seam

Version `0.1.0-dev.9` has **369 passing automated tests across sixteen files**, before independent review. Thirty-nine new tests cover all seventeen routes, all thirteen write denials, actual SDK injected-transport calls, out-of-band context validation, audience/session/expiry checks, source/ref isolation, metadata-only logs, rate/output budgets, unsupported-filter rejection, Base ref/paging and capacity-only room metadata. The synthetic server retains its existing HTTP/MCP tests and live-mode refusal. A structurally valid supplied context is not proof of real authentication; production middleware and provider grant verification are absent.

## Eighth slice, read-flow orchestration

Version `0.1.0-dev.8` has **330 passing automated tests across fifteen files**. Independent review passed these and 56 selected additional checks against the immutable snapshot. Twenty-seven new cases connect Base search/fetch, validate cross-calendar and empty-page continuation, preserve denied-calendar coverage, enforce per-call and total traversal budgets, reject query/identity/scope replay and harden thread pagination against loops/unknown/duplicate results. Existing negative unsupported-domain coverage now uses an actually unsupported domain because explicit Base search is implemented. Typecheck, build and source allowlist are part of the final slice checks.

## Seventh slice, bounded Base read workflow

Version `0.1.0-dev.7` has **303 passing automated tests across fourteen files**. Independent review passed these and 57 selected additional checks against the immutable snapshot. Thirty-one new cases cover keyword candidates, explicit Base/table selection, schema/record projection, Base-only permission isolation, fixed BITABLE request/response types, verified Wiki object resolution, retargeted Wiki cursors, Unicode and result budgets, empty-page continuation, malformed schemas/records and prototype-inherited property exclusion. No all-Base enumeration or actual provider permission grant is inferred from these tests.

## Sixth slice, task-read completion

Version `0.1.0-dev.6` has **272 passing automated tests across thirteen files**. Independent review passed these and 56 selected additional checks against the immutable snapshot. Twenty-eight new tests cover official tasklist and task-search transports, empty nonterminal task pages, query-bound continuation, exact assignee roles, task-detail identity checks, inaccessible/unknown/filtered results, local detail fan-out limits, completion rechecks, explicit `my_tasks` coverage and missing-scope/session rejection. Provider task search's maximum page size is not claimed; twenty is this project's local detail-read budget.

## Fifth slice, document-read completion

Version `0.1.0-dev.5` has **244 passing automated tests across twelve files**. Independent review passed these and 53 selected additional checks against the immutable snapshot. New official-SDK transport contracts cover Drive metadata and comment replies. Tests include file search-to-fetch, Wiki file resolution, partial metadata failures, unrequested/duplicate resource rejection, first-page-only root replies, independent document/reply cursors, empty nonterminal pages, scope/identity/query binding, cyclic pagination and malformed provider output. No real Feishu/ChatGPT/production database was used.

## Fourth slice, person and room selection

Version `0.1.0-dev.4` has **214 passing automated tests across eleven files** after review corrections, before independent re-verification. Typecheck, build and source allowlist checks pass. The actual-user configuration remains absent. The new tests cover fixed-path user identity in people search, duplicate names and incomplete matches, provider query/page bounds, room-only busy requests, capacity filtering, missing/malformed/denied room availability, query-bound room continuation and the distinction between internal scopes, verified provider documentation and actual granted scopes.

Room capacities must be positive safe integers, without string coercion. All room/person busy intervals require valid RFC3339 timestamps with an explicit UTC offset or `Z`; timezone-less and invalid calendar dates remain unknown. Missing or oversized provider room pages fail before any per-room requests, enforcing at most ten room checks per page even when the provider ignores page size. Each room check can make up to three HTTP attempts under the gateway retry policy. The reviewer's twelve boundary cases and eleven additional malformed-data/budget checks are permanent regressions. Independent dev.4 R2 review passed 214 formal tests and 52 additional selected checks against the immutable snapshot.

## Third slice, minimal high-level reads

Version `0.1.0-dev.3` extends the offline provider layer with cross-domain continuation, signed document/message fetch, Wiki node resolution, thread replies, comment completeness and meeting recommendations that reject unknown availability. After independent-review corrections, the suite has **178 passing tests** across ten files. Strict typecheck, build and source allowlist checks pass before independent re-verification of this corrected slice.

Provider cursor history now rejects repeated and A→B→A cyclic tokens and bounds continuation to twenty provider pages. A missing nested comment `replies` array remains partial. Missing message bodies fail rather than being represented as empty source text. The reviewer's initial workflow edge cases were added to the formal regression suite.

At that third-slice cut, no production configuration was supplied or used and the mock executable was the only runnable HTTP listener. Real Feishu, a live ChatGPT OAuth roundtrip and native concurrent PostgreSQL remain unverified in the current development candidate as well.

## Second slice, after independent-review fixes

Version `0.1.0-dev.2` passes strict typecheck, **150 automated tests across eight files**, build and the source allowlist check in the cloud environment. The suite includes the independent reviewer's four reproducible failures as permanent regressions, plus malformed busy intervals, standalone dot-segment IDs, stale token revision and failed-old-refresh cases.

Two exact SQL migrations execute in PGlite's in-memory PostgreSQL engine. This is a single-process/single-connection test database, not native multi-connection PostgreSQL. Production pool behavior, concurrent lock scheduling, TLS, roles/RLS, KMS and actual OAuth remain unverified.

Independent review identified and the revised code addresses:

- Disconnect/relink ABA: connection grant generations and token revisions gate compare-and-swap refresh writes and conditional revocation, so old refresh success or failure cannot overwrite/delete a newer grant
- Missing or malformed busy intervals remain unknown, even when the provider returned a user ID
- Document search rechecks returned resource types against both requested types and logical permissions
- Connection pool acquisition, transaction and cleanup errors are sanitized
- Standalone `.`/`..` resource path segments are rejected before transport

The reviewed first-slice export remains unchanged. Revised second-slice independent verification is a separate gate; this record does not itself declare that review complete.

## First slice history

Development cut checked on 2026-10-05 UTC, using Node.js 24.19.0. The operating environment's displayed test clock differs from the conversation's UTC clock; this record uses the task date rather than inferring a release date from file mtimes.

## Passed

- `npm run typecheck`: strict TypeScript checks passed
- `npm test`: 85 tests passed across three files
- `npm run build`: TypeScript build passed
- `npm run check:source`: release allowlist and limited secret-pattern/path check passed
- `npm audit --omit=dev`: production dependency advisory scan returned zero known vulnerabilities at this check; development dependencies and broader application security are not covered by that result
- Official MCP SDK client: authenticated Streamable HTTP initialize, 17-tool discovery and profile/search/fetch calls
- HTTP: protected-resource challenge, OAuth metadata, PKCE flow, duplicate query rejection, malformed/oversized body handling, hostile Origin/Host rejection
- OAuth: exact redirect/audience binding, code expiry/single-use, refresh rotation/replay revocation and scope narrowing
- Security primitives: ciphertext isolation/tamper detection/key rotation, same-tenant/different-user and cross-tenant checks, cursor/reference purpose/query binding, rate limits, source-data handling and metadata-only logs
- Read tools: synthetic success contracts, filters, field type validation, pagination, ambiguity and explicit timezone
- Write tools: all 13 omitted from discovery and rejected by the engine

## Not run / not established

- Live Feishu API, actual app scopes, callback configuration and real user consent
- Running PostgreSQL migration, SQL permissions/RLS or multi-process token refresh
- External ChatGPT installation, host OAuth and host-model tool routing
- Production deployment, TLS/domain challenge or uptime
- Full golden model evaluation set, independent penetration testing or public-directory review
- GitHub Actions on the final public commit, including the Node.js 22 matrix job

Passing fixture tests is not a claim that the production plugin works. This record should be updated after independent review and when new real integration evidence exists.
