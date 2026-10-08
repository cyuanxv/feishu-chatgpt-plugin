import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, P, request } from "./helpers.mjs";
import { hash, SCOPES, aad, random } from "../.test-build/module.mjs";
test("browser start, official v3 exchange, identity and encrypted D1 persistence", async () => {
  const s = await setup();
  const flow = await s.begin();
  assert.equal(
    flow.url.origin + flow.url.pathname,
    "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
  );
  assert.deepEqual(flow.url.searchParams.get("scope").split(" "), SCOPES);
  assert.equal(
    flow.url.searchParams.get("redirect_uri"),
    P.site + "/api/feishu/callback",
  );
  assert.equal(flow.url.searchParams.get("code_challenge_method"), "S256");
  assert.match(
    flow.response.headers.get("set-cookie"),
    /Secure; HttpOnly; SameSite=Lax/,
  );
  assert.equal((await s.callback(flow)).status, 303);
  const row = await s.store.get(P);
  assert.equal(row.tenant_key, "synthetic-tenant");
  assert.equal(row.open_id, "ou_synthetic");
  const body = new URLSearchParams(s.mocked.calls[0].init.body);
  assert.equal(body.get("client_secret"), "synthetic-app-secret");
  assert.equal(
    await hash(body.get("code_verifier")),
    flow.url.searchParams.get("code_challenge"),
  );
  assert.equal(
    s.mocked.calls[1].init.headers.Authorization,
    "Bearer synthetic-user-token",
  );
  assert(!JSON.stringify(row).includes("synthetic-user-token"));
  assert(!JSON.stringify(row).includes("not-stored@example.test"));
  assert.equal(
    s.db.sql.prepare("SELECT count(*) n FROM oauth_states").get().n,
    0,
  );
});
test("missing Sites user and service-only authorization never manufacture a user", async () => {
  const s = await setup();
  for (const path of ["/api/status", "/api/feishu/callback?state=x&code=x"]) {
    const r = await s.send(path, {
      user: null,
      headers: { "OAI-Sites-Authorization": "Bearer synthetic-service" },
    });
    assert.equal(r.status, 401);
  }
  assert.equal(s.mocked.calls.length, 0);
});
test("no actual credentials or explicit gate means no network", async () => {
  const s = await setup();
  s.env.FEISHU_READ_ENABLED = "false";
  const status = await s.status();
  assert.equal(status.configured, false);
  assert.equal(status.csrf, null);
  const r = await s.send("/api/feishu/connect", {
    method: "POST",
    body: { csrf: "fake" },
    headers: { Origin: P.site },
  });
  assert.equal(r.status, 503);
  assert.equal(s.mocked.calls.length, 0);
});
test("OAuth start requires exact origin and encrypted per-user CSRF", async () => {
  const s = await setup();
  const a = await s.status();
  for (const [user, Origin, csrf] of [
    [P.user, undefined, a.csrf],
    [P.user, "https://evil.test", a.csrf],
    ["other", P.site, a.csrf],
    [P.user, P.site, a.csrf + "x"],
  ]) {
    const r = await s.send("/api/feishu/connect", {
      method: "POST",
      user,
      body: { csrf },
      headers: Origin ? { Origin } : {},
    });
    assert(r.status >= 400);
  }
  assert.equal(s.mocked.calls.length, 0);
});
test("cross-user state and wrong browser cookie cannot consume legitimate state", async () => {
  const s = await setup();
  const flow = await s.begin();
  const path =
    "/api/feishu/callback?" +
    new URLSearchParams({
      state: flow.url.searchParams.get("state"),
      code: "synthetic",
    });
  assert.equal(
    (await s.send(path, { user: "other", headers: { Cookie: flow.cookie } }))
      .status,
    400,
  );
  assert.equal(
    (
      await s.send(path, {
        headers: { Cookie: "__Host-feishu-link=" + random() },
      })
    ).status,
    400,
  );
  assert.equal((await s.callback(flow)).status, 303);
  assert.equal(s.mocked.calls.length, 2);
});
test("callback duplicate fields, expiry and replay fail closed", async () => {
  const s = await setup();
  const flow = await s.begin();
  const query = new URLSearchParams({
    state: flow.url.searchParams.get("state"),
    code: "synthetic",
  });
  assert.equal(
    (
      await s.send("/api/feishu/callback?" + query + "&state=other", {
        headers: { Cookie: flow.cookie },
      })
    ).status,
    400,
  );
  s.advance(600001);
  assert.equal((await s.callback(flow)).status, 400);
  assert.equal(s.mocked.calls.length, 0);
  const next = await s.begin();
  assert.equal((await s.callback(next)).status, 303);
  assert.equal((await s.callback(next)).status, 400);
  assert.equal(s.mocked.calls.length, 2);
});
for (const data of [{ open_id: "only" }, { tenant_key: "only" }, {}])
  test(
    "stable profile must include tenant and open_id " + JSON.stringify(data),
    async () => {
      const s = await setup();
      const flow = await s.begin();
      s.mocked.hooks.profile = () => Response.json({ code: 0, data });
      assert.equal((await s.callback(flow)).status, 401);
      assert.equal(await s.store.get(P), null);
    },
  );
for (const scope of [
  "calendar:calendar:read offline_access",
  SCOPES.join(" ") + " im:message:send",
])
  test(
    "actual scopes are both sufficient and no broader than requested " + scope,
    async () => {
      const s = await setup();
      const flow = await s.begin();
      s.mocked.hooks.token = () =>
        Response.json({
          access_token: "synthetic",
          refresh_token: "synthetic",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token_expires_in: 86400,
          scope,
        });
      assert.equal((await s.callback(flow)).status, 401);
      assert.equal(await s.store.get(P), null);
    },
  );
test("unknown token exchange outcome is not retried or reflected", async () => {
  const s = await setup();
  const flow = await s.begin();
  s.mocked.hooks.token = () => {
    throw Error("synthetic-secret-upstream");
  };
  const r = await s.callback(flow);
  assert.equal(r.status, 503);
  assert(!JSON.stringify(await r.json()).includes("synthetic-secret"));
  assert.equal((await s.callback(flow)).status, 400);
  assert.equal(s.mocked.calls.length, 1);
});
test("disconnect epoch fences a callback already in flight before any connection exists", async () => {
  const s = await setup();
  const flow = await s.begin();
  const snap = await s.status();
  s.mocked.hooks.profile = async () => {
    assert.equal((await s.disconnect(snap)).status, 200);
    return Response.json({
      code: 0,
      data: { open_id: "ou_synthetic", tenant_key: "synthetic-tenant" },
    });
  };
  assert.equal((await s.callback(flow)).status, 409);
  assert.equal(await s.store.get(P), null);
});
test("stale disconnect cannot remove a newly linked grant; other user remains", async () => {
  const s = await setup();
  await s.grant();
  const old = await s.status();
  await s.grant("other");
  await s.grant();
  const current = await s.store.get(P);
  assert.equal((await s.disconnect(old)).status, 409);
  assert.equal((await s.store.get(P)).grant_id, current.grant_id);
  assert.equal((await s.disconnect(await s.status())).status, 200);
  assert.equal(await s.store.get(P), null);
  assert.equal((await s.store.get({ ...P, user: "other" })).status, "active");
});
test("credential ciphertext cannot move to another grant or owner", async () => {
  const s = await setup();
  const row = await s.grant();
  await assert.rejects(() =>
    s.vault.open(row.credentials, aad(P, "credentials", random())),
  );
  await assert.rejects(() =>
    s.vault.open(
      row.credentials,
      aad({ ...P, user: "other" }, "credentials", row.grant_id),
    ),
  );
});
