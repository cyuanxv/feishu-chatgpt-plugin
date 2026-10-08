import { z } from "zod";
import {
  AppError,
  assert,
  boundedText,
  dataMode,
  type Env,
} from "./security.ts";
import {
  providerDiagnostic,
  emitProviderDiagnostic,
  providerLogId,
  safeProviderLogId,
  type ProviderOperation,
} from "./provider-diagnostics.ts";
import {
  TOKEN_ENDPOINT,
  TOKEN_CONTENT_TYPE,
  checkTokenWire,
  type OAuthBinding,
} from "./oauth-wire.ts";
export class ProviderFailure extends AppError {
  constructor(
    code: string,
    status: number,
    readonly providerCode?: number,
    readonly providerLogId?: string,
  ) {
    super(code, status);
    this.providerLogId = safeProviderLogId(providerLogId);
    this.providerCode =
      Number.isSafeInteger(providerCode) &&
      providerCode! >= 0 &&
      providerCode! <= 999999999
        ? providerCode
        : undefined;
  }
}
export const SCOPES = [
  "calendar:calendar:read",
  "calendar:calendar.event:read",
  "offline_access",
] as const;
export interface Tokens {
  access_token: string;
  refresh_token: string;
  access_expires: number;
  refresh_expires: number;
  scopes: string[];
}
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  refresh_token: z.string().min(1).max(8192),
  token_type: z.string().refine((v) => v.toLowerCase() === "bearer"),
  expires_in: z.number().finite().positive().max(31536000),
  refresh_token_expires_in: z.number().finite().positive().max(31536000),
  scope: z.string().min(1).max(4096),
});
export class Feishu {
  constructor(
    private env: Env,
    private fetcher: Fetcher = globalThis.fetch.bind(globalThis),
    private now = Date.now,
  ) {}
  private async request(
    url: string,
    init: RequestInit,
    operation: ProviderOperation,
  ) {
    assert(
      dataMode(this.env) === "feishu",
      "synthetic_mode_oauth_disabled",
      403,
    );
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "other";
      emitProviderDiagnostic({
        operation,
        kind: "network",
        transport_error:
          name === "TimeoutError" ||
          name === "AbortError" ||
          name === "TypeError"
            ? name
            : "other",
      });
      throw new AppError("provider_network_error", 503);
    }
    let failureCode: number | undefined;
    const logId = providerLogId(response.headers);
    if (response.status !== 200) {
      let detail: unknown;
      try {
        detail = JSON.parse(await boundedText(response, 32768));
      } catch {
        detail = undefined;
      }
      const diagnostic = providerDiagnostic(
        {
          operation,
          kind: "http",
          http_status: response.status,
          ...(logId ? { provider_log_id: logId } : {}),
        },
        detail,
      );
      failureCode = diagnostic.provider_code;
      emitProviderDiagnostic(diagnostic);
    }
    if (response.status >= 300 && response.status < 400)
      throw new ProviderFailure(
        "provider_redirect_denied",
        502,
        failureCode,
        logId,
      );
    if (response.status === 401)
      throw new ProviderFailure(
        "provider_authorization_required",
        401,
        failureCode,
        logId,
      );
    if (response.status === 403)
      throw new ProviderFailure(
        "provider_permission_denied",
        403,
        failureCode,
        logId,
      );
    if (response.status === 404)
      throw new ProviderFailure("provider_not_found", 404, failureCode, logId);
    if (response.status === 429)
      throw new ProviderFailure(
        "provider_rate_limited",
        429,
        failureCode,
        logId,
      );
    if (operation === "oauth_token" && response.status === 400)
      throw new ProviderFailure(
        "provider_oauth_rejected",
        400,
        failureCode,
        logId,
      );
    if (response.status !== 200)
      throw new ProviderFailure(
        "provider_unavailable",
        503,
        failureCode,
        logId,
      );
    try {
      return { body: JSON.parse(await boundedText(response)), logId };
    } catch (e) {
      emitProviderDiagnostic({
        operation,
        kind: "invalid_json",
        http_status: response.status,
        ...(logId ? { provider_log_id: logId } : {}),
      });
      if (e instanceof AppError) throw e;
      throw new ProviderFailure(
        "provider_invalid_response",
        502,
        undefined,
        logId,
      );
    }
  }
  async exchangeCode(input: {
    code: string;
    verifier: string;
    binding: OAuthBinding;
  }): Promise<Tokens> {
    const binding = { ...input.binding };
    return this.token(
      {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: binding.redirectUri,
        code_verifier: input.verifier,
        scope: binding.scope,
      },
      SCOPES,
      binding,
    );
  }
  async token(
    data: Record<string, string>,
    allowed: readonly string[] = SCOPES,
    binding?: OAuthBinding,
  ): Promise<Tokens> {
    assert(
      this.env.FEISHU_APP_ID && this.env.FEISHU_APP_SECRET,
      "configuration_required",
      503,
    );
    const request = {
      method: "POST",
      headers: { "Content-Type": TOKEN_CONTENT_TYPE },
      body: new URLSearchParams({
        client_id: this.env.FEISHU_APP_ID,
        client_secret: this.env.FEISHU_APP_SECRET,
        ...data,
      }).toString(),
    };
    if (binding)
      await checkTokenWire(TOKEN_ENDPOINT, request, binding, {
        code: data.code!,
        verifier: data.code_verifier!,
        clientSecret: this.env.FEISHU_APP_SECRET,
      });
    const { body: raw, logId } = await this.request(
      TOKEN_ENDPOINT,
      request,
      "oauth_token",
    );
    // Match the official SDK's error-envelope precedence: token-looking fields do not
    // turn invalid_grant or a non-zero provider code into a successful authorization.
    const envelopeValid =
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      !raw.error &&
      (raw.code === undefined ||
        raw.code === 0 ||
        raw.code === "0" ||
        raw.code === "");
    if (!envelopeValid) {
      const diagnostic = providerDiagnostic(
        {
          operation: "oauth_token",
          kind: "oauth_rejected",
          http_status: 200,
          ...(logId ? { provider_log_id: logId } : {}),
        },
        raw,
      );
      emitProviderDiagnostic(diagnostic);
      throw new ProviderFailure(
        "provider_authorization_required",
        401,
        diagnostic.provider_code,
        logId,
      );
    }
    const parsed = tokenSchema.safeParse(raw);
    assert(parsed.success, "provider_authorization_required", 401);
    const scopes = [...new Set(parsed.data.scope.split(" ").filter(Boolean))];
    assert(
      SCOPES.every((s) => scopes.includes(s)) &&
        scopes.every((s) => allowed.includes(s)),
      "provider_scope_changed",
      401,
    );
    return {
      access_token: parsed.data.access_token,
      refresh_token: parsed.data.refresh_token,
      access_expires: this.now() + parsed.data.expires_in * 1000,
      refresh_expires: this.now() + parsed.data.refresh_token_expires_in * 1000,
      scopes,
    };
  }
  private async read(
    path: string,
    token: string,
    params: Record<string, string> = {},
  ) {
    const url = new URL("https://open.feishu.cn" + path);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const operation: ProviderOperation = path.includes("user_info")
      ? "user_info"
      : path.includes("instance_view")
        ? "calendar_instances"
        : "calendar_list";
    const { body: raw, logId } = await this.request(
      url.href,
      {
        method: "GET",
        headers: { Authorization: "Bearer " + token },
      },
      operation,
    );
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      raw.code !== 0 ||
      !raw.data ||
      typeof raw.data !== "object" ||
      Array.isArray(raw.data)
    ) {
      // Read APIs can return a failure envelope with HTTP 200. Retain only
      // bounded diagnostic evidence; never infer retry/auth semantics from an
      // undocumented business code or expose the provider's message/data.
      const diagnostic = providerDiagnostic(
        {
          operation,
          kind: "invalid_response",
          http_status: 200,
          ...(logId ? { provider_log_id: logId } : {}),
        },
        raw,
      );
      emitProviderDiagnostic(diagnostic);
      throw new ProviderFailure(
        "provider_invalid_response",
        502,
        diagnostic.provider_code,
        logId,
      );
    }
    return raw.data;
  }
  async profile(token: string) {
    const raw = await this.read("/open-apis/authen/v1/user_info", token);
    const parsed = z
      .object({
        open_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        tenant_key: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        name: z.string().max(100).optional(),
      })
      .safeParse(raw);
    assert(parsed.success, "provider_identity_invalid", 401);
    return parsed.data;
  }
  async calendars(token: string, pageToken?: string) {
    return this.read("/open-apis/calendar/v4/calendars", token, {
      page_size: "5",
      ...(pageToken ? { page_token: pageToken } : {}),
    });
  }
  async instances(token: string, calendar: string, start: number, end: number) {
    assert(
      /^[A-Za-z0-9_.@+-]{1,256}$/.test(calendar) &&
        calendar !== "." &&
        calendar !== "..",
    );
    return this.read(
      "/open-apis/calendar/v4/calendars/" +
        encodeURIComponent(calendar) +
        "/events/instance_view",
      token,
      {
        start_time: String(Math.floor(start / 1000)),
        end_time: String(Math.floor(end / 1000)),
        user_id_type: "open_id",
      },
    );
  }
}
