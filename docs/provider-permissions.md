# Provider permission evidence, not user authorization

No Feishu app or user has granted these permissions to this project. This document records narrowly verified provider requirements for later configuration; it is not consent, a configured OAuth scope set or a claim that the live integration is ready.

| Concrete operation | Verified minimum provider permission | Verified source |
| --- | --- | --- |
| Name/email people search | contact:user:search | [Official CLI contact search](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/contact/contact_search_user.go) |
| DOCX/Wiki/Base metadata search | search:docs:read | [Official CLI Drive search](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/drive/drive_search.go) |
| Single-room busy intervals | calendar:calendar.free_busy:read | [Official calendar catalog](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/registry/catalog/services/calendar.json) |
| Tasks assigned to current identity | task:task:read | [Official task catalog](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/registry/catalog/services/task.json) |
| Task search by explicit assignee | task:task:read | [Official user-only task search](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/task/task_search.go) |
| Tasklist discovery and tasklist tasks | task:tasklist:read | [Official task catalog](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/registry/catalog/services/task.json) |
| File/DOCX metadata batch | drive:drive.metadata:readonly | [Official Drive catalog](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/registry/catalog/services/drive.json) |
| Comment reply pages | docs:document.comment:read | [Official Drive catalog](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/registry/catalog/services/drive.json) |
| BITABLE-only title search | search:docs:read | [Official Base resolution](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/base/base_resolve.go); the shortcut and this project use user tokens, while the complete endpoint identity matrix is unverified |
| Selected Wiki-to-Base object lookup | wiki:node:retrieve | [Official Base URL resolution](https://github.com/larksuite/cli/blob/main/shortcuts/base/base_resolve.go), checked 2026-10-05; this project requires user identity, while the full provider identity matrix remains unverified |

The code's internal `people.read`, `search.read`, `calendar.read`, etc. are separate MCP authorization capabilities. They must not be sent to Feishu as provider permissions or treated as proof of provider consent. `assertProviderGrant` validates a known operation against actual provider consent results, but no production linking/routing code is wired yet. It is not a complete global scope mapper.

Other endpoint requirements must be verified before enabling those operations. Catalog entries may list broad alternative permissions; requesting every listed alternative would violate the intended minimum-permission approach. No write permission is included here.

## Verified limits that affect behavior

- People search is user-only, accepts up to 50 Unicode characters and 1–30 results. A response with `has_more` requires a more specific query; the official CLI does not invent automatic pagination
- Drive document search uses a maximum 30-character query and page size 1–20 in the verified official implementation. The provider adapter and unified workflow enforce these conservative bounds
- Room busy uses the single-entity free/busy endpoint with `room_id`. It must not send `user_id`, which the provider prioritizes if both are supplied. The adapter chooses a conservative 31-day window and at most ten room checks per page
- A verified permission requirement does not establish user visibility to a document, person, room or task. The provider still enforces resource-level visibility

## OAuth evidence boundary

The installed official SDK's `client.accessToken` helper uses `https://accounts.feishu.cn/oauth/v3/token`; its authorization-code/refresh contract is tested offline. The matching fixed web authorization URL and complete authorization-side PKCE/public-client behavior have not been established. Do not guess an `/oauth/v3/authorize` path or mix in older OIDC helper assumptions.

The current official CLI also documents a device flow at `/oauth/v1/device_authorization` and requests `offline_access`, followed by v3 token polling. No device authorization has been initiated and no credentials have been transmitted. Configuration and a reviewed production linking design are still required.
