# Document confirmation UI candidate (dev14)

This closes the browser usability layer for the existing `create_doc` candidate. It is **default off**, runs separately from all MCP/OAuth entrypoints, and has not created a real document. It does not implement the other twelve planned writes.

## Product scope

The original V1 product/UX scope calls for a lightweight confirmation UI rather than a complex document editor, explicit write intent, full title/Markdown/destination review, idempotency and no server-side persistence of document/chat bodies. The UI therefore displays the complete literal Markdown, verified provider account/tenant and originating client, explicit folder token or personal library, content version and expiry. It does not render untrusted HTML, accept edits after review, or silently choose another folder.

The supplied folder token is shown exactly; a friendly folder name, current folder audience and folder-content read-back are not fetched. Existing destination permissions still apply. Those facts must not be presented as independently verified sharing/audience evidence.

## Implemented flow

1. The existing authenticated workflow prepares a durable intent containing account/grant binding, content hash, expiry and idempotency hash. It does not store the title/body.
2. A **separate trusted host** signs a one-use Ed25519 browser handoff with `version=1`, `purpose=document_review`, exact intent, binding hash, request hash, HTTPS origin, random 32-byte nonce and a lifetime of at most 120 seconds.
3. `POST /document-review` requires both the existing MCP Bearer and that independent handoff in headers, plus strict version/intent/input JSON. It verifies current account, grant generation, actual provider scope and exact content hash. Neither a Bearer alone, a self-asserted account nor `approved:true` can mint a confirmation session.
4. The server consumes the nonce atomically and issues an HttpOnly, Secure, SameSite=Strict `__Host-` cookie and separate CSRF secret, bound to this intent/account/site/content version. Session lifetime is at most five minutes and no longer than the original token or intent. Only session/token/CSRF/nonce hashes and token-row references are stored.
5. The page first revalidates status. Only a human's explicit **Confirm create** click sends the exact content plus intent/version/hash/CSRF. The server atomically claims the session and internally issues the workflow's confirmation proof after rechecking authorization. The existing durable intent still owns the at-most-once provider execution fence across all sessions/processes.
6. Cancel/Close cancels the shared intent before acknowledging cancellation. If execution already won, it reports that closing cannot retract the request. Navigation uses best-effort cancellation; lost navigation beacons are not represented as confirmed cancellation. Reload shows an inert restart page, and BFCache restoration must revalidate.
7. After a lost response the client only queries receipts. It never retries create, changes the idempotency key or enables a second submit. Local `executing` receipts keep polling without provider refresh; async task polling requires an existing task ID. Polling stops at a terminal result or session expiry, and known terminal receipts stay visible after expiry.

Provider success remains an unverified provider receipt, not proof of complete rendered content. Partial/uncertain outcomes retain the dev13 no-recreate semantics. See [provider contract and limits](document-create-candidate.md).

## Trust boundary and exact remaining activation work

The actual host must bind its own authenticated user-controlled browser to the matching MCP account and deliver the bootstrap response/cookie directly over the configured HTTPS origin. Its private signing key and handoff proofs **must never enter model/tool output, frontend code, URLs or this review service**. This repository only accepts an Ed25519 **public SPKI** key and provides no host signing endpoint. A private PEM is rejected before Node can derive a public key from it.

A production host adapter is **not implemented or deployed**. A conventional browser navigation cannot set the bootstrap Bearer/custom headers by itself. The trusted host needs a separately reviewed same-origin backend handoff (forwarding the verified bootstrap HTML/Set-Cookie directly to its user browser) or equivalent trusted embedded-host transport. The synthetic browser bridge is not such a production adapter and must never be deployed.

The calendar issuer still grants only `calendar.read`. It does not issue `docs.write` or request `docx:document:create`. Production activation therefore still requires:

- A reviewed host browser delivery adapter and independent signing-key management.
- Explicit approval and implementation of the appropriate account/OAuth permission expansion; no new grant is created by this change.
- HTTPS ingress, exact host/origin preservation, no request/body/authorization logging, isolated loopback upstream, reviewed database roles/migrations and independent secret configuration.
- Dedicated-tenant actual provider/API acceptance, async failure/recovery and browser/ChatGPT acceptance tests.

The service is loopback-only (`127.0.0.1`); the HTTPS reverse proxy must share the network namespace and may not expose the HTTP upstream directly. It ignores forwarded-host headers. Host and Origin are matched exactly; all mutations reject missing/null/duplicate Origin, duplicate auth/cookie fields and query-string credential transport. Security headers include no-store, no-referrer and frame-ancestors none. The UI is a top-level page, not an iframe.

## Runtime and offline verification

`npm run start:document-review` exits with code 78 before reading secret configuration unless `FEISHU_DOCUMENT_REVIEW_RUNTIME=review`. The separate `FEISHU_DOCUMENT_WRITE_RUNTIME=create_doc` gate is required for provider execution. With only review enabled, the page can preview/cancel but does not read provider token/app-secret configuration or submit creates. Do not enable either mode without the activation work above.

Configuration names (no values belong in source/chat): `DOCUMENT_REVIEW_ORIGIN`, `MCP_RESOURCE_URL`, verified-TLS `DATABASE_URL`, `DOCUMENT_REVIEW_HOST_PUBLIC_KEY_PEM`, and an independent `DOCUMENT_REVIEW_CONFIRMATION_KEY_BASE64`. The execution gate additionally requires the existing provider token-key/app/domain settings. Keys are operator-managed; startup creates no persistent credentials.

- HTTP/PGlite tests cover full review-to-receipt, one-use host handoff, binding/expiry/revocation, mutation gates, strict input/header handling, no plaintext persistence, repeated/concurrent submit, cross-window cancellation and provider uncertainty.
- Deterministic client tests cover double click, lost response while executing, stale responses after navigation, BFCache, expiry, cancellation acknowledgement and literal text rendering.
- Five native PostgreSQL cases test nonce uniqueness, session claims and same-/cross-window cancel-versus-execute serialization. They run only against CI's synthetic service.
- The browser CI job uses official [Playwright Python](https://playwright.dev/python/docs/ci), pinned [1.62.0](https://pypi.org/project/playwright/1.62.0/), on Ubuntu 22.04 with `chromium_sandbox=True`. Its local synthetic bridge exercises production HTML/JS/handlers, desktop/mobile layout, preview, confirm/receipt, repeated click, cancel and navigation. It does **not** establish production HTTPS/cookie delivery, genuine host integration or real provider behavior.

Run `npm run typecheck`, `npm test -- --maxWorkers=2`, `npm run build`, `npm run smoke:production` and `npm run check:source`. For the synthetic browser suite, install the pinned official Playwright browser and run `python tests/document-review-browser.py`; it starts/cleans up its own test-only fixture and uses no real credentials. Do not disable the browser sandbox when an executor cannot launch it.
