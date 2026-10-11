import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, mkdtemp, rm, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store, random, SCOPES } from "../.test-build/module.mjs";
import { mock, ARGS, P } from "../test/helpers.mjs";
const { Miniflare } = createRequire(import.meta.url)(
  process.env.MINIFLARE_MODULE ?? "../runtime-check/node_modules/miniflare",
);
await mkdir(".runtime-test", { recursive: true });
const persistence = await mkdtemp(resolve(".runtime-test/d1-"));
const provider = mock();
const bindings = {
  APP_ORIGIN: P.site,
  APP_ENCRYPTION_KEY: random(),
  FEISHU_APP_ID: "synthetic-app",
  FEISHU_APP_SECRET: "synthetic-app-secret",
  FEISHU_READ_ENABLED: "true",
};
const script = await readFile("dist/server/index.js", "utf8");
const options = () => ({
  modules: true,
  script,
  compatibilityDate: "2026-07-30",
  host: "127.0.0.1",
  port: 0,
  cf: false,
  d1Databases: { DB: "synthetic-feishu-d1" },
  d1Persist: persistence,
  bindings,
  outboundService: async (req) =>
    provider.fetcher(req.url, {
      method: req.method,
      headers: {
        Authorization: req.headers.get("authorization"),
        "Content-Type": req.headers.get("content-type"),
      },
      body: await req.text(),
      redirect: "manual",
    }),
});
let mf = new Miniflare(options());
let db;
let count = 0;
const ok = (name) => {
  count++;
  console.log("PASS " + name);
};
const request = (
  path,
  { user = P.user, method = "GET", body, form, headers = {} } = {},
) =>
  mf.dispatchFetch(P.site + path, {
    method,
    redirect: "manual",
    headers: {
      ...(user ? { "oai-authenticated-user-id": user } : {}),
      ...(body ? { "Content-Type": "application/json", Origin: P.site } : {}),
      ...(form
        ? {
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: P.site,
          }
        : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
const status = async (user = P.user) =>
  (await request("/api/status", { user })).json();
async function begin(user = P.user) {
  const s = await status(user);
  const r = await request("/api/feishu/connect", {
    user,
    method: "POST",
    form: { csrf: s.csrf },
  });
  assert.equal(r.status, 303, await r.clone().text());
  return {
    state: new URL(r.headers.get("location")).searchParams.get("state"),
    cookie: r.headers.get("set-cookie").split(";")[0],
    user,
  };
}
const callback = (flow) =>
  request(
    "/api/feishu/callback?" +
      new URLSearchParams({ state: flow.state, code: "synthetic-code" }),
    { user: flow.user, headers: { Cookie: flow.cookie } },
  );
async function grant(user = P.user) {
  const flow = await begin(user);
  const r = await callback(flow);
  assert.equal(r.status, 303, await r.clone().text());
  return new Store(db).get({ ...P, user });
}
const call = async (args = ARGS, user = P.user) =>
  (
    await request("/mcp", {
      user,
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_agenda", arguments: args },
      },
    })
  ).json();
try {
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("drizzle"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    for (const sql of (await readFile("drizzle/" + file, "utf8"))
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  ok("generated schema runs on actual workerd D1");
  assert.equal(
    (
      await request("/api/status", {
        user: null,
        headers: { "OAI-Sites-Authorization": "Bearer synthetic-service" },
      })
    ).status,
    401,
  );
  ok("service-only request has no invented user identity");
  const row = await grant();
  const a = await call();
  assert.equal(a.result.isError, false, JSON.stringify(a));
  assert.equal(a.result.structuredContent.events.length, 2);
  ok(
    "actual bundled Worker completes synthetic OAuth, user_info, encrypted grant and agenda read",
  );
  const client = new Client(
    { name: "synthetic-sdk-client", version: "1" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(P.site + "/mcp"),
    {
      fetch: async (input, init) => {
        const req = new Request(input, init);
        const headers = new Headers(req.headers);
        headers.set("oai-authenticated-user-id", P.user);
        return mf.dispatchFetch(req.url, {
          method: req.method,
          headers,
          redirect: "manual",
          ...(req.method !== "GET" && req.method !== "HEAD"
            ? { body: await req.arrayBuffer() }
            : {}),
        });
      },
    },
  );
  await client.connect(transport);
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name),
    ["get_agenda"],
  );
  assert.equal(
    (await client.callTool({ name: "get_agenda", arguments: ARGS })).isError,
    false,
  );
  await client.close();
  ok("official MCP client initializes, discovers and invokes the single tool");
  await mf.dispose();
  mf = new Miniflare(options());
  db = await mf.getD1Database("DB");
  const persisted = await new Store(db).get(P);
  assert.equal(persisted.grant_id, row.grant_id);
  assert.equal((await call()).result.isError, false);
  ok("D1 grant survives actual Worker restart with the same bindings");
  await grant("other-user");
  const denied = await call(
    { ...ARGS, cursor: a.result.structuredContent.next_cursor },
    "other-user",
  );
  assert.equal(denied.result.isError, true);
  ok("encrypted continuation cannot cross Sites users");
  const store = new Store(db);
  const current = await store.get(P);
  const leases = await Promise.allSettled(
    Array.from({ length: 30 }, () => store.lease(P, current, Date.now())),
  );
  assert.equal(leases.filter((r) => r.status === "fulfilled").length, 1);
  const leased = leases.find((r) => r.status === "fulfilled").value;
  ok("30 concurrent D1 CAS leases yield one winner");
  const epoch = await store.epoch(P);
  await store.disconnect(P, current.grant_id, epoch);
  const fresh = await grant();
  assert.equal(fresh.version, 1);
  assert.notEqual(fresh.grant_id, current.grant_id);
  await assert.rejects(() => store.rotate(P, leased, "stale", "[]", 1, 1));
  await store.invalidate(P, leased);
  assert.equal((await store.get(P)).grant_id, fresh.grant_id);
  ok(
    "delete/reinsert version-one ABA cannot overwrite or invalidate a new grant",
  );
  const beforeEpoch = await store.epoch(P);
  await db
    .prepare(
      "CREATE TRIGGER synthetic_fail BEFORE DELETE ON connections BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;",
    )
    .run();
  await assert.rejects(() => store.disconnect(P, fresh.grant_id, beforeEpoch));
  assert.equal(await store.epoch(P), beforeEpoch);
  assert.equal((await store.get(P)).grant_id, fresh.grant_id);
  await db.prepare("DROP TRIGGER synthetic_fail").run();
  ok("D1 batch failure rolls back owner epoch and grant deletion together");
  const pending = await begin();
  await store.disconnect(P, fresh.grant_id, await store.epoch(P));
  assert.equal((await callback(pending)).status, 400);
  ok(
    "disconnect epoch prevents a pending callback from restoring authorization",
  );
  const refreshing = await grant();
  await db
    .prepare("UPDATE connections SET expires=? WHERE site=? AND user_id=?")
    .bind(Date.now() - 1, P.site, P.user)
    .run();
  const countBefore = provider.calls.filter((c) =>
    c.url.endsWith("/authen/v2/oauth/token"),
  ).length;
  const refreshResults = await Promise.all(
    Array.from({ length: 12 }, () => call()),
  );
  assert(refreshResults.some((r) => r.result.isError === false));
  assert.equal(
    provider.calls.filter((c) => c.url.endsWith("/authen/v2/oauth/token")).length,
    countBefore + 1,
  );
  assert.equal((await store.get(P)).lease, null);
  ok("parallel actual Worker requests redeem a provider refresh token once");
  await db
    .prepare("UPDATE connections SET expires=? WHERE site=? AND user_id=?")
    .bind(Date.now() - 1, P.site, P.user)
    .run();
  provider.hooks.token = () =>
    Response.json({ error: "invalid_grant" }, { status: 400 });
  assert.equal((await call()).result.isError, true);
  assert.equal((await store.get(P)).status, "reauthorization_required");
  ok("failed/uncertain provider refresh fails closed without retry");
  for (const [index, envelope] of [
    { error: "invalid_grant" },
    { code: 99991663 },
    { code: "99991663" },
  ].entries()) {
    const user = "synthetic-error-envelope-" + index;
    provider.hooks.token = () =>
      Response.json({
        access_token: "synthetic",
        refresh_token: "synthetic",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
        token_type: "Bearer",
        scope: SCOPES.join(" "),
        ...envelope,
      });
    const flow = await begin(user);
    const before = provider.calls.length;
    assert.equal((await callback(flow)).status, 401);
    assert.equal(await store.get({ ...P, user }), null);
    assert.equal(provider.calls.length, before + 1);
  }
  ok(
    "actual Worker rejects OAuth error envelopes even when token fields exist",
  );
  // Deployment-authorized mode is independently exercised without any secrets.
  await mf.dispose();
  mf = new Miniflare({
    ...options(),
    bindings: { APP_ORIGIN: P.site, FEISHU_DATA_MODE: "synthetic" },
  });
  db = await mf.getD1Database("DB");
  const callsBeforeDemo = provider.calls.length;
  const demo = (await call()).result.structuredContent;
  assert.equal(demo.source, "synthetic_fixture");
  assert.equal(demo.live_verified, false);
  assert.equal((await status()).connected, false);
  const fixture = demo.events[0].event_id;
  assert.notEqual(
    (await call(ARGS, "other-demo-owner")).result.structuredContent.events[0]
      .event_id,
    fixture,
  );
  ok(
    "actual synthetic Worker needs no secrets and partitions D1 fixtures by Sites identity",
  );
  await mf.dispose();
  mf = new Miniflare({
    ...options(),
    bindings: { APP_ORIGIN: P.site, FEISHU_DATA_MODE: "synthetic" },
  });
  assert.equal(
    (await call()).result.structuredContent.events[0].event_id,
    fixture,
  );
  assert.equal(provider.calls.length, callsBeforeDemo);
  ok(
    "synthetic D1 fixture persists across actual workerd restart without provider requests",
  );
  assert.equal(
    (
      await request("/mcp", {
        user: null,
        method: "POST",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_agenda", arguments: ARGS },
        },
      })
    ).status,
    401,
  );
  for (const path of [
    "/api/feishu/connect",
    "/api/feishu/disconnect",
    "/api/feishu/callback?state=x&code=y",
  ]) {
    const method = path.includes("callback") ? "GET" : "POST";
    assert.equal(
      (
        await request(path, {
          method,
          ...(method === "POST" ? { body: {} } : {}),
        })
      ).status,
      403,
    );
  }
  assert.equal(provider.calls.length, callsBeforeDemo);
  ok(
    "actual synthetic Worker rejects missing identity and every real OAuth route",
  );
  const browserDemo = await request("/api/demo/agenda", {
    method: "POST",
    body: ARGS,
  });
  assert.equal(browserDemo.status, 200);
  const browserFixture = await browserDemo.json();
  assert.equal(browserFixture.source, "synthetic_fixture");
  assert.equal(browserFixture.events[0].event_id, fixture);
  assert.equal(
    (
      await request("/api/demo/agenda", {
        user: null,
        method: "POST",
        body: ARGS,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/demo/agenda", {
        method: "POST",
        body: ARGS,
        headers: { Origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  assert.equal(provider.calls.length, callsBeforeDemo);
  ok(
    "browser synthetic API shares the owner-bound D1 fixture while requiring identity and exact origin",
  );
  await mf.dispose();
  mf = new Miniflare({
    ...options(),
    bindings: { ...bindings, FEISHU_DATA_MODE: "synthetci" },
  });
  const beforeInvalidMode = provider.calls.length;
  assert.equal((await request("/api/status")).status, 503);
  assert.equal((await call()).error, "invalid_data_mode");
  assert.equal(provider.calls.length, beforeInvalidMode);
  ok(
    "actual workerd rejects misspelled explicit data mode despite real-mode settings and stored grants",
  );
  console.log(
    JSON.stringify({
      passed: count,
      runtime: "official Miniflare/workerd and D1",
      real_feishu_requests: 0,
      sites_dispatcher_verified: false,
      site_registered: false,
      production_deployed: false,
    }),
  );
} finally {
  await mf.dispose();
  await rm(persistence, { recursive: true, force: true });
}
