import { AppError, assert, hash } from "./security.ts";

export const AUTHORIZE_ENDPOINT =
  "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
export const TOKEN_ENDPOINT =
  "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
export const TOKEN_CONTENT_TYPE = "application/json; charset=utf-8";
export const OAUTH_SOURCE_VERSION = "0.1.0-sites.21";
export interface OAuthBinding {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
}
function uniqueFields(params: URLSearchParams, keys: string[]) {
  return (
    [...params.keys()].length === keys.length &&
    keys.every((key) => params.getAll(key).length === 1)
  );
}
function check(
  stage: "authorization_response" | "token_request",
  checks: Record<string, boolean>,
) {
  console.info(
    JSON.stringify({
      event: "feishu_oauth_wire_check",
      diagnostic_version: 2,
      source_version: OAUTH_SOURCE_VERSION,
      stage,
      ...checks,
    }),
  );
  assert(Object.values(checks).every(Boolean), "oauth_wire_mismatch");
}
export function checkAuthorizationWire(
  serialized: string,
  binding: OAuthBinding,
  state: string,
) {
  const url = new URL(serialized);
  const p = url.searchParams;
  check("authorization_response", {
    endpoint_matches:
      url.origin + url.pathname === AUTHORIZE_ENDPOINT &&
      !url.username &&
      !url.password &&
      !url.hash,
    fields_unique: uniqueFields(p, [
      "client_id",
      "response_type",
      "redirect_uri",
      "state",
      "scope",
      "code_challenge",
      "code_challenge_method",
    ]),
    client_matches: p.get("client_id") === binding.clientId,
    redirect_matches: p.get("redirect_uri") === binding.redirectUri,
    state_matches: p.get("state") === state,
    challenge_matches:
      p.get("code_challenge") === binding.challenge &&
      /^[A-Za-z0-9_-]{43}$/.test(binding.challenge),
    method_matches: p.get("code_challenge_method") === "S256",
    response_matches: p.get("response_type") === "code",
    scope_matches: p.get("scope") === binding.scope,
  });
}
export async function checkTokenWire(
  url: string,
  request: RequestInit & { body: string },
  binding: OAuthBinding,
  expected: { code: string; verifier: string; clientSecret: string },
) {
  let fields: Record<string, string>;
  try {
    fields = JSON.parse(request.body);
  } catch {
    throw new AppError("oauth_wire_mismatch", 500);
  }
  assert(
    fields &&
      typeof fields === "object" &&
      !Array.isArray(fields) &&
      Object.values(fields).every((v) => typeof v === "string"),
    "oauth_wire_mismatch",
    500,
  );
  const p = new URLSearchParams(fields);
  const verifier = p.get("code_verifier") ?? "";
  check("token_request", {
    endpoint_matches: url === TOKEN_ENDPOINT,
    method_matches: request.method === "POST",
    encoding_matches:
      new Headers(request.headers).get("content-type") === TOKEN_CONTENT_TYPE,
    fields_unique: uniqueFields(p, [
      "client_id",
      "client_secret",
      "grant_type",
      "code",
      "redirect_uri",
      "code_verifier",
      "scope",
    ]),
    grant_matches: p.get("grant_type") === "authorization_code",
    client_matches: p.get("client_id") === binding.clientId,
    secret_matches: p.get("client_secret") === expected.clientSecret,
    redirect_matches: p.get("redirect_uri") === binding.redirectUri,
    scope_matches: p.get("scope") === binding.scope,
    code_matches: p.get("code") === expected.code,
    verifier_matches:
      /^[A-Za-z0-9_-]{43}$/.test(verifier) && verifier === expected.verifier,
    challenge_matches: (await hash(verifier)) === binding.challenge,
  });
}
