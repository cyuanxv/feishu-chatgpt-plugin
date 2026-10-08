# Unassigned task creation candidate (dev15)

The original V1 catalog includes `create_task` at milestone M18. This bounded candidate implements the full preview → explicit confirmation → one create → receipt workflow for **an unfinished, unassigned task created under the current user identity**. It does not promise placement in “assigned to me.” It is separate from document creation and remains default off.

## User flow and supported content

The review page displays the complete title/description, verified user/tenant/client, the empty assignee/follower lists, no task-list placement and one of:

- No deadline, if the optional field is omitted.
- A timed deadline with a required explicit UTC offset or Z, at whole-second precision. Each Feishu viewer sees the same instant in their timezone.
- An all-day YYYY-MM-DD date, encoded at UTC midnight so all viewers see that calendar date.

Only summary (up to 200 code units), description (up to 3000 code units/20 KiB) and an optional typed deadline are accepted. The candidate is deliberately narrower than the provider's 3000-character title limit. Media and raw HTML/XML/rich-mention markup in the description are rejected. No assignees, followers, tasklists, reminders, recurrence, source document, custom fields, external URLs or completion callbacks can be added through extra JSON fields. The request explicitly sets `completed_at:"0"`.

The UI says that provider-default notification behavior is unverified. Omitting recipient/list/reminder configuration does not justify promising that Feishu will never generate a notification.

## Primary API evidence

- [Official Task v2 create API](https://open.feishu.cn/document/task-v2/task/create): `POST /open-apis/task/v2/tasks`, `user_id_type=open_id`, business code 0 and `data.task`.
- [Official CLI API catalog](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/registry/catalog/services/task.json): `task:task:write` **or** `task:task:writeonly` grants creation. These scopes are not create-only; writeonly also permits updates. The candidate never requests either grant itself.
- [Official generated MCP input contract](https://github.com/larksuite/lark-openapi-mcp/blob/21920354ec6e3966b52e89152620c5085e496b55/src/mcp-tool/tools/zh/gen-tools/zod/task_v2.ts): omitted members means no members; omitted tasklists means no list placement; title/description limits; optional due and client_token.
- [Official task feature overview](https://open.feishu.cn/document/task-v2/task/overview): epoch **milliseconds**; timed values retain seconds, all-day values use UTC date precision; creator has read/edit rights but is not an assignee merely by creating the task. Example 2023-05-01 all-day encodes as `1682899200000`.
- [Official idempotency specification](https://open.feishu.cn/document/task-v2/overview#6134aee8): successful `client_token` deduplication lasts five minutes, failures immediately permit a new operation and concurrency can return 1470422. Changed input with the same token is undefined. Deduplication across refreshed credentials is not established.

The actual installed official Node SDK handles the fixed `task.v2.task.create` operation with an explicit user-token override, silent logging, no redirects and bounded transport. No app/tenant-token fallback or generic HTTP executor is exposed.

## Durable execution and partial outcomes

Each operation stores only its account/grant/content/idempotency hashes, UUID, state and bounded receipt. The title, description and deadline are never persisted in the action/session tables or logged. The UUID is the provider client_token, stable for the approved operation. The database timestamp records the transition to executing.

The local reservation, not the provider's short dedupe window, is the at-most-once boundary. An approved intent must atomically become executing before any mutation. Executing and uncertain records are never released after expiry, restart, timeout, credential refresh or receipt-storage failure. Reusing a key with changed content/deadline/account conflicts. Receipt queries never perform another POST and do not silently acquire read permission.

A valid returned GUID is retained even when response fields do not establish that the title, description, deadline, empty members/lists or unfinished state match. Such outcomes are **partial**, with a bounded list of unverified field names and no private body. Malformed/error responses and transport ambiguity are **uncertain**. No corrective update/delete or recreate is attempted. A code-0 receipt is not a later read-back verification.

Task links come only from the provider response. The candidate conservatively requires the exact HTTPS applink provider host and /client/todo/detail path, one matching GUID parameter and at most a bounded t-number display identifier; it rejects credentials/ports/fragments, conflicting IDs and arbitrary path/query text, and suppresses links it cannot verify. Unrecognized provider URL formats can therefore leave a valid task receipt without a clickable link; no task URL is invented.

## Confirmation and separation from document writes

The task UI reuses the reviewed browser client, HMAC confirmation authority and current-grant checks. It has a separate `task_review` Ed25519 host-handoff purpose, `create_task` action binding, task-only ledger/session tables, cookie name and HTTP route prefix. A valid document handoff/proof or docs.write scope cannot authorize a task.

The trusted host must separately authenticate the user-controlled browser and deliver the bootstrap directly over the exact HTTPS origin. Only its public Ed25519 SPKI key is accepted by the review service. There is no signing/minting endpoint. The production host-delivery adapter is still an explicit integration gate, as described in [document review boundaries](document-review-candidate.md).

After current cookie/CSRF/content/account checks, a real Confirm click records the decision and dispatches once. Cancel updates the shared intent before acknowledgement; a started operation cannot be retracted by closing a page. Repeated clicks, concurrent windows, lost responses, navigation, BFCache and expiry retain the reviewed no-recreate behavior. Titles/bodies are rendered literally, with no browser storage and no-store/no-referrer/frame-denial headers.

## Runtime and validation

`npm run start:task-review` exits 78 without reading secret configuration unless `FEISHU_TASK_REVIEW_RUNTIME=review`. Provider execution additionally requires `FEISHU_TASK_WRITE_RUNTIME=create_task`. The listener is loopback-only and needs separately reviewed HTTPS ingress. Review-only mode does not read provider token/app-secret configuration.

Configuration names only: `TASK_REVIEW_ORIGIN`, `TASK_REVIEW_HOST_PUBLIC_KEY_PEM`, `TASK_REVIEW_CONFIRMATION_KEY_BASE64`, existing `MCP_RESOURCE_URL` and verified-TLS `DATABASE_URL`; provider settings are needed only behind the execution gate. No configuration values or credentials are committed or provisioned.

Tests cover provider serialization, optional/all-day/timed deadlines, recipient-property rejection, strict response/URL mapping, partial results, no repeated mutation beyond provider dedupe expiry, storage loss/restarts, current grant validation, document/task separation and actual confirmation HTTP flows. Native PostgreSQL CI exercises concurrent sessions and cancellation. Sandboxed Chromium CI tests actual synthetic task and document pages at desktop/mobile widths; it does not establish production HTTPS/host delivery or real Feishu behavior.

No real task, permission grant, production deployment or public tool registration is part of this change. Actual host delivery, task-scope consent/issuance and a separately approved dedicated-tenant test remain required. The other eleven planned writes remain outside this candidate.
