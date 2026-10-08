export type ProviderOperation =
  "oauth_token" | "user_info" | "calendar_list" | "calendar_instances";
export interface ProviderDiagnostic {
  operation: ProviderOperation;
  kind:
    "network" | "http" | "invalid_json" | "oauth_rejected" | "invalid_response";
  http_status?: number;
  provider_code?: number;
  provider_error?: string;
  provider_log_id?: string;
  transport_error?: "TimeoutError" | "AbortError" | "TypeError" | "other";
}
// Only this named response header is eligible. Opaque IDs are bounded ASCII;
// duplicate headers, URLs, whitespace, controls and other payloads are omitted.
export function safeProviderLogId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value)
    ? value
    : undefined;
}
export function providerLogId(headers: Headers): string | undefined {
  return safeProviderLogId(headers.get("x-tt-logid"));
}
const errors = new Set([
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_grant_type",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
]);
// Never emit descriptions, request URLs/bodies, client values, authorization codes,
// response payloads, identity fields, or token-looking fields.
export function providerDiagnostic(
  base: ProviderDiagnostic,
  body?: unknown,
): ProviderDiagnostic {
  const out: ProviderDiagnostic = { ...base };
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const value = body as Record<string, unknown>;
    if (
      typeof value.code === "number" &&
      Number.isSafeInteger(value.code) &&
      value.code >= 0 &&
      value.code <= 999999999
    )
      out.provider_code = value.code;
    if (typeof value.code === "string" && /^\d{1,9}$/.test(value.code))
      out.provider_code = Number(value.code);
    if (typeof value.error === "string" && errors.has(value.error))
      out.provider_error = value.error;
  }
  return out;
}
export function emitProviderDiagnostic(value: ProviderDiagnostic) {
  console.warn(JSON.stringify({ event: "feishu_provider_failure", ...value }));
}
