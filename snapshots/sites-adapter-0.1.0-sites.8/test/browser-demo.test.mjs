import test from "node:test";
import assert from "node:assert/strict";
import { setup, ARGS, P } from "./helpers.mjs";
const read = (s, options = {}) =>
  s.send("/api/demo/agenda", {
    method: "POST",
    body: ARGS,
    headers: { Origin: P.site },
    ...options,
  });

test("browser demo reuses fictional agenda, persistence and owner partitioning without provider requests", async () => {
  const s = await setup();
  s.env.FEISHU_DATA_MODE = "synthetic";
  delete s.env.FEISHU_APP_SECRET;
  delete s.env.APP_ENCRYPTION_KEY;
  const first = await read(s);
  assert.equal(first.status, 200);
  const a = await first.json();
  assert.equal(a.source, "synthetic_fixture");
  assert.equal(a.live_verified, false);
  assert.equal(
    (await (await read(s)).json()).events[0].event_id,
    a.events[0].event_id,
  );
  assert.notEqual(
    (await (await read(s, { user: "other" })).json()).events[0].event_id,
    a.events[0].event_id,
  );
  assert.equal(
    (await s.tool()).result.structuredContent.events[0].event_id,
    a.events[0].event_id,
  );
  assert.equal(s.mocked.calls.length, 0);
  assert.equal(
    s.db.sql.prepare("SELECT count(*) n FROM connections").get().n,
    0,
  );
  assert.equal(
    s.db.sql.prepare("SELECT count(*) n FROM oauth_states").get().n,
    0,
  );
});

for (const [options, status] of [
  [{ user: null }, 401],
  [{ headers: {} }, 403],
  [{ headers: { Origin: "https://evil.test" } }, 403],
  [{ method: "GET", body: undefined }, 405],
  [{ body: { ...ARGS, user: "victim" } }, 400],
  [{ body: { ...ARGS, cursor: "replay" } }, 400],
  [{ body: { method: "create_event", params: {} } }, 400],
])
  test(
    "browser demo denies invalid identity/origin/method/input " +
      JSON.stringify(options),
    async () => {
      const s = await setup();
      s.env.FEISHU_DATA_MODE = "synthetic";
      assert.equal((await read(s, options)).status, status);
      assert.equal(s.mocked.calls.length, 0);
      assert.equal(
        s.db.sql.prepare("SELECT count(*) n FROM synthetic_state").get().n,
        0,
      );
    },
  );

test("browser-only demo route cannot be used in real mode or unknown mode", async () => {
  const s = await setup();
  await s.grant();
  const before = s.mocked.calls.length;
  assert.equal((await read(s)).status, 404);
  s.env.FEISHU_DATA_MODE = "feishu";
  assert.equal((await read(s)).status, 404);
  s.env.FEISHU_DATA_MODE = "synthetci";
  assert.equal((await read(s)).status, 503);
  assert.equal(s.mocked.calls.length, before);
});

test("browser and MCP synthetic calls share the same per-owner budget", async () => {
  const s = await setup();
  s.env.FEISHU_DATA_MODE = "synthetic";
  for (let i = 0; i < 30; i++) {
    assert.equal((await read(s)).status, 200);
    assert.equal((await s.tool()).result.isError, false);
  }
  assert.equal((await read(s)).status, 429);
  assert.equal((await s.tool()).result.isError, true);
  assert.equal((await read(s, { user: "other" })).status, 200);
});
