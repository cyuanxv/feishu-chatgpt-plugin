# Disabled document-create candidate

`0.1.0-dev.13` implements one planned write operation, `create_doc`, as an internal, default-off candidate. The existing MCP and HTTP entrypoints still expose no writes. The twelve other planned write operations are not implemented by this slice. No live account, new permission, secret configuration, document or deployment was used to test it.

## Working flow

1. `preview` validates a title, text-only Markdown and optional Drive folder token, verifies an existing document-write grant, and stores a request digest under an idempotency key. It returns the full reviewable content and destination, without calling Feishu.
2. A trusted host must display that exact preview and obtain an explicit user decision in its authenticated, CSRF-protected interaction. Only that trusted boundary may call `WriteConfirmationAuthority.issue`. The signing key and issue method must never be exposed to a model, MCP tool or ordinary request body. This is a confirmation attestation, not a login mechanism; the trusted UI integration is not built or mounted in this cut.
3. `confirm` verifies the signed action/request/account/client/resource binding and the short expiration, then approves or cancels the durable intent. A model-supplied boolean cannot authorize it. Approval may still be cancelled before the execution claim.
4. `execute` verifies the exact original input, atomically claims the approved intent, revalidates current account/grant/provider credentials, and sends at most one create POST.
5. A synchronous result produces a durable receipt. An async task produces a pending receipt; an explicit `getReceipt(..., true)` performs one status GET using the stored task ID. No background polling or extra write is hidden in receipt retrieval.

`PostgresDocumentWriteAccess` is separate from the calendar-read verifier. It checks the opaque MCP bearer against the active, unexpired resource/client grant, account generation, internal `docs.write`, and actual `docx:document:create` provider scope. It loads the Feishu user token from the encrypted store only immediately before provider access. The current calendar issuer cannot grant these write capabilities. No existing OAuth scope configuration was expanded.

## Idempotency and uncertainty

Migration 005 adds `document_write_intents`. A unique connection/key pair and atomic approved-to-executing update prevent concurrent callers or restarted workflow instances from sending a second create. Content, destination, account generation, OAuth grant/client and resource are bound to the stored digest and approval.

This is durable local **at-most-once dispatch**, not a claim of exactly-once provider execution. The inspected official create contract contains no documented replay/idempotency field. A timeout, malformed response, failed receipt write or process crash never releases an executing reservation. A repeated execute returns the existing receipt or executing/uncertain state. It never retries POST, including after HTTP 429/5xx. An operator reconciliation mechanism is still required for unresolved executing/uncertain actions with no recoverable task ID; do not create again automatically.

Successful async receipts cannot be overwritten by a slower pending poll. Failed/expired provider tasks can still have partial side effects, so receipts retain `may_have_created: true`. A pre-dispatch authorization failure is recorded with `may_have_created: false`. Uncertain tasks with a known ID may be checked again by GET without recreating the document.

No title, body, raw idempotency key, user token, confirmation proof or raw warning text is stored in the intent table. It contains hashes, state and a bounded receipt. Retention/cleanup must preserve the required idempotency horizon and be designed before production; deleting a record removes that local duplicate-protection history.

## Bounded content and receipts

- Title: trimmed, nonempty, at most 200 UTF-16 code units; control characters rejected.
- Markdown: nonempty, at most 20,000 UTF-16 code units and 64 KiB UTF-8. This is a local budget, not an asserted provider limit.
- Images/media and raw HTML/XML are rejected. The provider Markdown format also recognizes rich XML extensions, so this candidate does not silently inherit uploads, remote image fetches, attachment handling or permission grants.
- A selected Drive folder is passed as `parent_token`; otherwise `parent_position: my_library` is explicit. Existing destination permissions apply. No sharing settings are modified.
- The adapter uses fixed Feishu/Lark API origins and a bounded validated task-ID path segment. It never follows a returned URL.
- A receipt reports `succeeded` only with a validated document ID and revision. Any warning yields `partial`; warning counts are retained without re-emitting arbitrary provider diagnostics. Content read-back verification is not implemented, so every receipt says `content_verified: false`.
- `data.result: failed`, including inside a decoded async result, is not success. Conflicting or unsupported response shapes remain uncertain.
- A document link is returned only if HTTPS, on the selected provider's domain boundary, without credentials/query/fragment, and exactly bound to the returned document ID. Otherwise the URL is omitted rather than guessed.

## Primary protocol evidence and limits

The implementation is based on pinned official CLI commit `7beffb086d7fa3c5b843d8affa7c089f49cfc65e`:

- [Create request construction](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/doc/docs_create_v2.go): `POST /open-apis/docs_ai/v1/documents`, `format: markdown`, XML-escaped title wrapper, optional parent location, and `extra_param` as a JSON-encoded string.
- [Declared create permission](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/doc/docs_create.go): `docx:document:create`. This candidate forces user identity and omits the CLI bot-side permission-grant behavior.
- [Async status and result contract](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/doc/docs_create_async.go): fixed GET task endpoint; processing/succeeded/failed/expired; successful `result.create_document` is a JSON-encoded string.
- [Business failure fixtures](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/doc/docs_result_test.go) and [Markdown behavior](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/skills/lark-doc/references/lark-doc-md.md).

The ordinary public [docx create API page](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/create?lang=zh-CN) describes a different, title/folder-only endpoint. Its limits and schema must not be applied to the docs_ai operation. An independently published docs_ai create/status specification was not found during this research. Real endpoint acceptance, exact permission behavior and returned content therefore remain unverified. Conservative shape checks may reject provider variants rather than falsely claim success.

## Validation and remaining gates

PGlite tests execute the real migration, authorization checks and intent SQL, and the actual official Node SDK runs with injected synthetic transport. Tests cover preview/approval/execution/receipt, body/destination edits, cancellation, account and generation isolation, replay/restart, concurrent claims, ambiguous writes, persistence failure, async completion, out-of-order status reads, warning handling and hostile responses. Five new native-PostgreSQL concurrency tests run only in the existing ephemeral synthetic CI service, alongside the five issuer tests.

Before live activation: independently review the exact commit and CI; implement the trusted host confirmation UI/session boundary; obtain specific scope/credential/configuration authorization; validate real provider behavior with a dedicated test account; establish destination visibility, ingress limits, storage retention, recovery and content verification. Passing offline tests does not authorize live writes or establish production readiness.
