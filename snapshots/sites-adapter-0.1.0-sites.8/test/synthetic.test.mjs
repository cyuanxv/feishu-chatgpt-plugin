import test from "node:test";
import assert from "node:assert/strict";
import { setup, ARGS, P, request } from "./helpers.mjs";
for (const mode of ["Synthetic", "synthetic ", "synthetci", "invalid", ""])
  test(
    "unknown explicit data mode fails closed: " + JSON.stringify(mode),
    async () => {
      const s = await setup();
      await s.grant();
      const before = s.mocked.calls.length;
      s.env.FEISHU_DATA_MODE = mode;
      assert.equal((await s.send("/")).status, 503);
      assert.equal((await s.send("/api/status")).status, 503);
      assert.equal((await s.tool()).error, "invalid_data_mode");
      await assert.rejects(s.api.profile("synthetic-token"), {
        code: "invalid_data_mode",
      });
      assert.equal(s.mocked.calls.length, before);
    },
  );

test("synthetic mode works without credentials and labels every result as fictional", async () => {
  const s = await setup();
  s.env.FEISHU_DATA_MODE = "synthetic";
  delete s.env.FEISHU_APP_SECRET;
  delete s.env.FEISHU_APP_ID;
  delete s.env.APP_ENCRYPTION_KEY;
  delete s.env.FEISHU_READ_ENABLED;
  const result = (await s.tool()).result;
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.source, "synthetic_fixture");
  assert.equal(result.structuredContent.live_verified, false);
  assert.match(result.structuredContent.notice, /虚构/);
  assert.equal(result.structuredContent.coverage, "synthetic_fixture_only");
  assert.equal(result.structuredContent.next_cursor, null);
  assert.match(result.structuredContent.events[0].summary, /合成演示/);
  assert.equal(s.mocked.calls.length, 0);
  assert.equal(
    s.db.sql.prepare("SELECT count(*) AS n FROM connections").get().n,
    0,
  );
  assert.equal(
    s.db.sql.prepare("SELECT count(*) AS n FROM oauth_states").get().n,
    0,
  );
});

test("synthetic marker persists per owner and never returns another owner's fixture", async () => {
  const s = await setup();
  s.env.FEISHU_DATA_MODE = "synthetic";
  const a = (await s.tool()).result.structuredContent.events[0].event_id;
  const b = (await s.tool(ARGS, "second-owner")).result.structuredContent
    .events[0].event_id;
  assert.notEqual(a, b);
  assert.equal((await s.tool()).result.structuredContent.events[0].event_id, a);
  assert.equal(
    s.db.sql.prepare("SELECT count(*) AS n FROM synthetic_state").get().n,
    2,
  );
});

test("synthetic status hides an existing real-mode grant and never claims a connection", async () => {
  const s = await setup();
  await s.grant();
  const before = s.mocked.calls.length;
  s.env.FEISHU_DATA_MODE = "synthetic";
  const status = await s.status();
  assert.equal(status.data_mode, "synthetic");
  assert.equal(status.connected, false);
  assert.equal(status.configured, false);
  assert.equal(status.grant_id, null);
  assert.equal(status.csrf, null);
  assert.equal(status.account_name, null);
  assert.equal(
    (await s.tool()).result.structuredContent.source,
    "synthetic_fixture",
  );
  assert.equal(s.mocked.calls.length, before);
});

for (const [path, method] of [
  ["/api/feishu/connect", "POST"],
  ["/api/feishu/disconnect", "POST"],
  ["/api/feishu/callback?state=x&code=y", "GET"],
])
  test(
    "synthetic mode hard-disables " +
      path +
      " even when credential settings exist",
    async () => {
      const s = await setup();
      s.env.FEISHU_DATA_MODE = "synthetic";
      const r = await s.send(path, {
        method,
        ...(method === "POST"
          ? { body: { csrf: "x" }, headers: { Origin: P.site } }
          : {}),
      });
      assert.equal(r.status, 403);
      assert.equal((await r.json()).error, "synthetic_mode_oauth_disabled");
      assert.equal(s.mocked.calls.length, 0);
    },
  );

test("provider transport itself refuses synthetic mode", async () => {
  const s = await setup();
  s.env.FEISHU_DATA_MODE = "synthetic";
  await assert.rejects(s.api.profile("synthetic-token"), {
    code: "synthetic_mode_oauth_disabled",
  });
  await assert.rejects(
    s.api.token({
      grant_type: "refresh_token",
      refresh_token: "synthetic-token",
    }),
    { code: "synthetic_mode_oauth_disabled" },
  );
  assert.equal(s.mocked.calls.length, 0);
});

test("synthetic tool and page require trusted platform identity; metadata identifies demo mode", async () => {
  const s = await setup();
  s.env.FEISHU_DATA_MODE = "synthetic";
  assert.equal((await s.send("/", { user: null })).status, 401);
  assert.equal((await s.send("/api/status", { user: null })).status, 401);
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_agenda", arguments: ARGS },
  };
  assert.equal(
    (await s.send("/mcp", { user: null, method: "POST", body })).status,
    401,
  );
  const discovery = await (
    await s.send("/mcp", {
      user: null,
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    })
  ).json();
  assert.match(discovery.result.tools[0].description, /虚构/);
  assert.equal(discovery.result.tools[0].annotations.openWorldHint, false);
  const page = await (await s.send("/")).text();
  assert.match(page, /仅合成演示/);
  assert.match(page, /不会向飞书发送请求/);
  assert.equal(
    s.db.sql.prepare("SELECT count(*) AS n FROM synthetic_state").get().n,
    0,
  );
});

for (const args of [
  { ...ARGS, cursor: "x" },
  { ...ARGS, data_mode: "feishu" },
  { ...ARGS, user: "victim" },
  { ...ARGS, time_range: { start: "2026-10-05", end: "2026-10-06" } },
  { ...ARGS, page_size: 0 },
])
  test("synthetic strict input refuses " + JSON.stringify(args), async () => {
    const s = await setup();
    s.env.FEISHU_DATA_MODE = "synthetic";
    assert.equal((await s.tool(args)).result.isError, true);
    assert.equal(
      s.db.sql.prepare("SELECT count(*) AS n FROM synthetic_state").get().n,
      0,
    );
    assert.equal(s.mocked.calls.length, 0);
  });

test("synthetic mode retains write denial, cross-origin checks and default real-mode gate", async () => {
  const s = await setup();
  s.env.FEISHU_DATA_MODE = "synthetic";
  assert.equal(
    (await s.tool(ARGS, P.user, "create_event")).result.structuredContent.error,
    "write_or_unknown_tool_denied",
  );
  const r = await s.send("/mcp", {
    method: "POST",
    headers: { Origin: "https://evil.test" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.equal(r.status, 403);
  delete s.env.FEISHU_DATA_MODE;
  delete s.env.FEISHU_READ_ENABLED;
  assert.equal(
    (await s.tool()).result.structuredContent.error,
    "configuration_required",
  );
});

test("synthetic mode enforces the existing per-owner request budget", async () => {
  const s = await setup();
  s.env.FEISHU_DATA_MODE = "synthetic";
  for (let i = 0; i < 60; i++)
    assert.equal((await s.tool()).result.isError, false);
  assert.equal((await s.tool()).result.isError, true);
  assert.equal((await s.tool(ARGS, "other-owner")).result.isError, false);
});
