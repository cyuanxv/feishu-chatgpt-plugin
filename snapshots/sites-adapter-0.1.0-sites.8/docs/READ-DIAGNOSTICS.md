# Read failure diagnostics candidate

This independent, unpublished change fixes lost diagnostic evidence when the user-info,
calendar-list, or calendar-instance API returns an error envelope with HTTP 200.

The adapter keeps the existing `provider_invalid_response` / 502 classification. It
extracts only a bounded nonnegative integer provider code and a validated `x-tt-logid`.
It does not interpret unknown business codes as an expired token, clear a grant, or retry.
Arrays are rejected as response envelopes or data objects.

MCP tool failures now include a locally generated `correlation_id` in structured content.
The same ID appears in a sanitized `feishu_agenda_failure` final-event log, together with
safe provider evidence when available. Provider messages, response bodies, access tokens,
identity data, exception messages, and arbitrary response headers are never copied.
The correlation ID is local; it is not a provider request ID.

## Offline validation

- TypeScript check: passed.
- Unit/integration suite: 168 passed, including 7 new diagnostic regressions.
- Package validation and source-pattern scan: passed.
- Official Miniflare/workerd + D1 harness: 18 checks passed.
- OAuth wire harness with synthetic provider: 13 checks passed.
- Native HTTP form harness: 5 checks passed.
- All provider traffic was synthetic. No production credentials were used.

Not run: real Feishu OAuth, production deployment, Sites dispatcher verification,
production migration, or browser-based live acceptance. Existing real OAuth error 20049
remains unresolved; this change is diagnostic hardening, not a claim to repair OAuth.
