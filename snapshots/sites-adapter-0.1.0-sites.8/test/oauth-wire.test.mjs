import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  checkAuthorizationWire,
  checkTokenWire,
  AUTHORIZE_ENDPOINT,
  TOKEN_ENDPOINT,
  TOKEN_CONTENT_TYPE,
  OAUTH_SOURCE_VERSION,
  SCOPES,
} from "../.test-build/module.mjs";
import { setup, P } from "./helpers.mjs";

const verifier = "V".repeat(43);
const state = "S".repeat(43);
const code = "SENSITIVE_synthetic_code_+/%&=";
const secret = "SENSITIVE_synthetic_secret_+/%&=";
const binding = {
  clientId: "synthetic-app",
  redirectUri: P.site + "/api/feishu/callback",
  challenge: createHash("sha256").update(verifier).digest("base64url"),
  scope: SCOPES.join(" "),
};
const authorization = () => {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: binding.clientId,
    response_type: "code",
    redirect_uri: binding.redirectUri,
    state,
    scope: binding.scope,
    code_challenge: binding.challenge,
    code_challenge_method: "S256",
  });
  return url;
};
const tokenRequest = () => ({
  method: "POST",
  headers: { "Content-Type": TOKEN_CONTENT_TYPE },
  body: new URLSearchParams({
    client_id: binding.clientId,
    client_secret: secret,
    grant_type: "authorization_code",
    code,
    redirect_uri: binding.redirectUri,
    code_verifier: verifier,
    scope: binding.scope,
  }).toString(),
});
const expected = { code, verifier, clientSecret: secret };

test("final serialization checks preserve reserved form characters and emit only boolean evidence", async () => {
  const original = console.info,
    logs = [];
  console.info = (line) => logs.push(JSON.parse(line));
  try {
    checkAuthorizationWire(authorization().href, binding, state);
    await checkTokenWire(TOKEN_ENDPOINT, tokenRequest(), binding, expected);
    assert.equal(logs.length, 2);
    assert.deepEqual(
      logs.map((x) => x.stage),
      ["authorization_response", "token_request"],
    );
    for (const log of logs) {
      const { event, diagnostic_version, source_version, stage, ...checks } =
        log;
      assert.equal(event, "feishu_oauth_wire_check");
      assert.equal(diagnostic_version, 2);
      assert.equal(source_version, OAUTH_SOURCE_VERSION);
      assert(Object.values(checks).every((x) => x === true));
    }
    for (const privateValue of [
      state,
      code,
      secret,
      verifier,
      binding.challenge,
      binding.redirectUri,
    ])
      assert(!JSON.stringify(logs).includes(privateValue));
  } finally {
    console.info = original;
  }
  assert.equal(
    JSON.parse(readFileSync("package.json")).version,
    OAUTH_SOURCE_VERSION,
  );
});
for (const key of [
  "client_id",
  "redirect_uri",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
  "response_type",
]) {
  test("final authorization rejects changed " + key, () => {
    const url = authorization();
    url.searchParams.set(key, "SENSITIVE_tampered");
    assert.throws(() => checkAuthorizationWire(url.href, binding, state), {
      code: "oauth_wire_mismatch",
    });
  });
}
test("final authorization rejects duplicate fields, other endpoint, userinfo and fragments", () => {
  for (const mutate of [
    (u) => u.searchParams.append("state", state),
    (u) => (u.hostname = "evil.test"),
    (u) => (u.pathname = "/unexpected"),
    (u) => (u.username = "synthetic"),
    (u) => (u.hash = "synthetic"),
  ]) {
    const url = authorization();
    mutate(url);
    assert.throws(() => checkAuthorizationWire(url.href, binding, state), {
      code: "oauth_wire_mismatch",
    });
  }
});
for (const key of [
  "client_id",
  "client_secret",
  "grant_type",
  "code",
  "redirect_uri",
  "code_verifier",
  "scope",
]) {
  test("final token form rejects changed " + key, async () => {
    const request = tokenRequest();
    const p = new URLSearchParams(request.body);
    p.set(key, "SENSITIVE_tampered");
    request.body = p.toString();
    await assert.rejects(
      () => checkTokenWire(TOKEN_ENDPOINT, request, binding, expected),
      { code: "oauth_wire_mismatch" },
    );
  });
}
test("final token form rejects duplicates, incorrect media type, method, and endpoint", async () => {
  for (const alter of [
    (r) => (r.body += "&code_verifier=" + verifier),
    (r) => (r.headers["Content-Type"] = "application/json"),
    (r) => (r.method = "GET"),
  ]) {
    const r = tokenRequest();
    alter(r);
    await assert.rejects(
      () => checkTokenWire(TOKEN_ENDPOINT, r, binding, expected),
      { code: "oauth_wire_mismatch" },
    );
  }
  await assert.rejects(
    () =>
      checkTokenWire(
        "https://evil.test/token",
        tokenRequest(),
        binding,
        expected,
      ),
    { code: "oauth_wire_mismatch" },
  );
});
test("typed code exchange rejects a wrong saved challenge before provider transport", async () => {
  const s = await setup();
  await assert.rejects(
    () =>
      s.api.exchangeCode({
        code,
        verifier,
        binding: { ...binding, challenge: "Z".repeat(43) },
      }),
    { code: "oauth_wire_mismatch" },
  );
  assert.equal(s.mocked.calls.length, 0);
});
test("top-level callback failure has a safe copyable receipt and matching log correlation", async () => {
  const s = await setup(),
    flow = await s.begin();
  s.mocked.hooks.token = () =>
    Response.json(
      {
        code: 20049,
        error: "invalid_grant",
        error_description: "SENSITIVE_<script>credential</script>",
      },
      { status: 400 },
    );
  const original = console.info,
    logs = [];
  console.info = (line) => logs.push(JSON.parse(line));
  let response, html;
  try {
    response = await s.send(
      "/api/feishu/callback?" +
        new URLSearchParams({
          state: flow.url.searchParams.get("state"),
          code,
        }),
      {
        headers: {
          Cookie: flow.cookie,
          Accept: "text/html,application/xhtml+xml",
        },
      },
    );
    html = await response.text();
  } finally {
    console.info = original;
  }
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(html, /飞书连接未完成/);
  assert.match(html, /飞书错误码：20049/);
  assert.match(html, /先不要重复授权/);
  const failure = logs.find((x) => x.event === "feishu_callback_failure");
  assert.match(failure.correlation_id, /^[a-f0-9-]{36}$/);
  assert(html.includes(failure.correlation_id));
  assert.equal(failure.provider_code, 20049);
  for (const privateValue of [
    "SENSITIVE",
    flow.url.searchParams.get("state"),
    flow.cookie,
    binding.challenge,
  ])
    assert(!html.includes(privateValue));
  assert.equal(s.mocked.calls.length, 1);
  assert.equal(await s.store.get(P), null);
  assert.equal((await s.callback(flow)).status, 400);
  assert.equal(s.mocked.calls.length, 1);
});
test("callback receipt script clears query without navigation and copies only receipt text", async () => {
  const s = await setup(),
    replaced = [],
    written = [];
  let handler;
  const nodes = {
    "#error-receipt": { value: "safe error receipt" },
    "#copy-status": {},
    "#copy-error": { addEventListener: (_event, fn) => (handler = fn) },
  };
  const context = {
    history: { replaceState: (...args) => replaced.push(args) },
    document: { querySelector: (key) => nodes[key] },
    navigator: {
      clipboard: { writeText: async (value) => written.push(value) },
    },
  };
  const js = await (await s.send("/oauth-error.js")).text();
  vm.runInNewContext(js, context, { timeout: 1000 });
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0][2], "/api/feishu/callback");
  await handler();
  assert.deepEqual(written, ["safe error receipt"]);
  assert.equal(nodes["#copy-status"].textContent, "已复制");
  assert.equal(s.mocked.calls.length, 0);
  const unauthenticatedScript = await s.send("/oauth-error.js", { user: null });
  assert.equal(unauthenticatedScript.status, 200);
  assert.equal(await unauthenticatedScript.text(), js);
  const unauthenticatedCallback = await s.send(
    "/api/feishu/callback?code=SENSITIVE_private&state=SENSITIVE_private",
    { user: null, headers: { Accept: "text/html" } },
  );
  assert.equal(unauthenticatedCallback.status, 401);
  assert(!(await unauthenticatedCallback.text()).includes("SENSITIVE_private"));
  assert.equal(s.mocked.calls.length, 0);
});
