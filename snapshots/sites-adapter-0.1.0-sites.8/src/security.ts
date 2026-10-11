export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number }; changes?: number }>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch<T = Record<string, unknown>>(
    statements: Statement[],
  ): Promise<{ results: T[]; meta?: { changes?: number } }[]>;
}
export interface Env {
  DB: Database;
  APP_ORIGIN: string;
  APP_ENCRYPTION_KEY?: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_READ_ENABLED?: string;
  FEISHU_DATA_MODE?: string;
  FEISHU_DOCX_ENABLED?: string;
}
export interface Principal {
  site: string;
  user: string;
}
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
export function assert(
  value: unknown,
  code = "invalid_argument",
  status = 400,
): asserts value {
  if (!value) throw new AppError(code, status);
}
export function object(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert(Object.keys(value).every((k) => keys.includes(k)));
}
export function origin(env: Env) {
  let url: URL;
  try {
    url = new URL(env.APP_ORIGIN);
  } catch {
    throw new AppError("configuration_required", 503);
  }
  assert(
    url.protocol === "https:" && url.origin === env.APP_ORIGIN,
    "configuration_required",
    503,
  );
  return url.origin;
}
export function principal(request: Request, env: Env): Principal {
  const site = origin(env);
  assert(new URL(request.url).origin === site, "invalid_origin", 403);
  // These are trusted only after the owner-private Sites dispatcher. This Worker must not be
  // deployed to a public raw workers.dev endpoint or use service credentials as user identity.
  const user = request.headers.get("oai-authenticated-user-id");
  assert(
    user && user.length <= 256 && !/[\r\n]/.test(user),
    "authentication_required",
    401,
  );
  return { site, user };
}
export function sameOrigin(request: Request, env: Env) {
  assert(
    request.headers.get("origin") === origin(env),
    "cross_origin_denied",
    403,
  );
}
export function browserOrigin(request: Request, env: Env) {
  const value = request.headers.get("origin");
  if (value) assert(value === origin(env), "cross_origin_denied", 403);
}
export const enc = new TextEncoder();
export const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export function unb64(value: string) {
  assert(/^[A-Za-z0-9_-]+$/.test(value), "invalid_encoding");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
  } catch {
    throw new AppError("invalid_encoding");
  }
  assert(b64(bytes) === value, "invalid_encoding");
  return bytes;
}
export const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
export const hash = async (value: string) =>
  b64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))));
export const aad = (p: Principal, kind: string, id = "") =>
  JSON.stringify([p.site, p.user, kind, id]);
export class Vault {
  constructor(private readonly secret?: string) {}
  private async key() {
    assert(this.secret, "configuration_required", 503);
    const bytes = unb64(this.secret);
    assert(bytes.length === 32, "configuration_required", 503);
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }
  async seal(value: unknown, binding: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(binding) },
      await this.key(),
      enc.encode(JSON.stringify(value)),
    );
    return `v1.${b64(iv)}.${b64(new Uint8Array(bytes))}`;
  }
  async open<T>(value: string, binding: string): Promise<T> {
    try {
      assert(value.length <= 20000);
      const [v, iv, data, ...rest] = value.split(".");
      assert(v === "v1" && iv && data && !rest.length);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(binding) },
        await this.key(),
        unb64(data),
      );
      return JSON.parse(new TextDecoder().decode(plain)) as T;
    } catch {
      throw new AppError("invalid_or_expired_state");
    }
  }
}
export async function boundedText(response: Response, max = 1_000_000) {
  assert(response.body, "empty_response", 502);
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      assert(size <= max, "response_too_large", 502);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(joined);
}
export async function requestJSON(request: Request, max = 32768) {
  assert(
    request.headers.get("content-type")?.split(";")[0] === "application/json",
    "unsupported_media_type",
    415,
  );
  try {
    return JSON.parse(
      await boundedText(new Response(request.body), max),
    ) as unknown;
  } catch (e) {
    if (e instanceof AppError && e.code === "response_too_large")
      throw new AppError("request_too_large", 413);
    if (e instanceof AppError && e.code === "empty_response")
      throw new AppError("invalid_json");
    if (e instanceof AppError) throw e;
    throw new AppError("invalid_json");
  }
}
export function dataMode(env: Env): "synthetic" | "feishu" {
  assert(
    env.FEISHU_DATA_MODE === undefined ||
      env.FEISHU_DATA_MODE === "synthetic" ||
      env.FEISHU_DATA_MODE === "feishu",
    "invalid_data_mode",
    503,
  );
  return env.FEISHU_DATA_MODE ?? "feishu";
}
export function configured(env: Env) {
  return Boolean(
    dataMode(env) === "feishu" &&
    env.FEISHU_READ_ENABLED === "true" &&
    env.FEISHU_APP_ID &&
    env.FEISHU_APP_SECRET &&
    env.APP_ENCRYPTION_KEY,
  );
}
export function configurationChecks(env: Env) {
  let encryption_key_valid = false;
  try {
    encryption_key_valid =
      typeof env.APP_ENCRYPTION_KEY === "string" &&
      unb64(env.APP_ENCRYPTION_KEY).length === 32;
  } catch {
    /* boolean only */
  }
  return {
    app_id_present: Boolean(env.FEISHU_APP_ID),
    app_secret_present: Boolean(env.FEISHU_APP_SECRET),
    app_secret_shape_ok: Boolean(
      env.FEISHU_APP_SECRET &&
      env.FEISHU_APP_SECRET === env.FEISHU_APP_SECRET.trim() &&
      !/[\r\n\0]/.test(env.FEISHU_APP_SECRET),
    ),
    encryption_key_valid,
  };
}
export function safeError(e: unknown) {
  return e instanceof AppError ? e : new AppError("service_unavailable", 503);
}
export async function connectionForm(request: Request) {
  assert(
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ===
      "application/x-www-form-urlencoded",
    "unsupported_media_type",
    415,
  );
  const encoded = await boundedText(new Response(request.body), 32768);
  const form = new URLSearchParams(encoded);
  assert(
    [...form.keys()].length === 1 && form.getAll("csrf").length === 1,
    "invalid_connection_form",
  );
  const csrf = form.get("csrf");
  assert(csrf && csrf.length <= 20000, "invalid_connection_form");
  return { csrf };
}
