# Validation scope

All fixtures are synthetic. This snapshot contains source, schema/migrations and validation scripts, excluding execution reports, databases, browser profiles, deployment archives and account history.

README commands cover:

- TypeScript, Workers ESM output and source/package allowlists
- SQLite unit tests for identity, CSRF, exact origin, one-use state, PKCE binding, provider errors, calendar bounds and grant fencing
- Official Miniflare/workerd with native D1, restart persistence, competing refreshes, ABA/epoch fencing and forced rollback
- Independent synthetic-provider comparison of final challenge and outbound verifier, with a changed-challenge rejection control
- Native loopback HTTP for opaque/missing/foreign Origin rejection, missing/forged CSRF rejection, fixed303/cookie behavior, replay and callback privacy
- Served UI scripts in a VM: double-submit prevention, fresh-form recovery and safe error rendering
- SQLite execution-time expiry that prevents a queued old form reclaiming an expired marker

Snapshot validation covers 161 Node tests, 18 workerd/D1 checks, 13 wire/VM checks and 5 native HTTP checks, plus type/source/package checks. Provider requests are intercepted; no real Feishu authorization is performed.

These checks do not establish a newly registered host's identity boundary, real browser/provider redirects, actual grants, live calendar semantics, error20049 resolution or production readiness. Internal equality checks cannot prove what challenge a real authorization server associated with a code.

The preservation branch intentionally skips repository CI to avoid unrelated unbounded duplicate jobs. Local synthetic validation and independent source review are reported separately. Skipped CI is not successful CI or merge acceptance. Integration/deployment requires its own authorized validation.
