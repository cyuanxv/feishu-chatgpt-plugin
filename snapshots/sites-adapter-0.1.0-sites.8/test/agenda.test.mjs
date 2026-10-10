import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, P, ARGS, instance, request } from "./helpers.mjs";
test("single read tool, thirteen writes and generic executors rejected", async () => {
  const s = await setup();
  const list = await (
    await s.send("/mcp", {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    })
  ).json();
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ["get_agenda"],
  );
  for (const name of [
    "create_event",
    "update_event",
    "delete_event",
    "request",
    "fetch",
    "search",
    "send_message",
    "create_task",
    "update_task",
    "create_document",
    "reply_comment",
    "create_record",
    "update_record",
    "delete_record",
    "approve",
  ])
    assert.equal((await s.tool({}, P.user, name)).result.isError, true);
  assert.equal(s.mocked.calls.length, 0);
});
test("agenda uses only current user tokens and preserves explicit continuation", async () => {
  const s = await setup();
  await s.grant();
  const first = (await s.tool()).result.structuredContent;
  assert.equal(first.events.length, 2);
  assert.equal(first.partial, true);
  assert.equal(first.traversal_complete, false);
  const next = (await s.tool({ ...ARGS, cursor: first.next_cursor })).result
    .structuredContent;
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].event_id, "event_3");
  assert.equal(next.next_cursor, null);
  assert.equal(next.traversal_complete, true);
  assert(
    s.mocked.calls
      .filter((c) => c.url.includes("/calendar/"))
      .every(
        (c) => c.init.headers.Authorization === "Bearer synthetic-user-token",
      ),
  );
  assert(s.mocked.calls.every((c) => c.init.redirect === "manual"));
});
test("cursor rejects other owner, new grant, tampering or changed query", async () => {
  const s = await setup();
  await s.grant();
  await s.grant("other");
  const first = (await s.tool()).result.structuredContent;
  for (const [args, user] of [
    [{ ...ARGS, cursor: first.next_cursor }, "other"],
    [{ ...ARGS, cursor: first.next_cursor + "x" }, P.user],
    [{ ...ARGS, cursor: first.next_cursor, page_size: 1 }, P.user],
  ])
    assert.equal((await s.tool(args, user)).result.isError, true);
  await s.grant();
  assert.equal(
    (await s.tool({ ...ARGS, cursor: first.next_cursor })).result.isError,
    true,
  );
});
test("instance changes invalidate continuation instead of duplicating or skipping", async () => {
  const s = await setup();
  await s.grant();
  const first = (await s.tool()).result.structuredContent;
  s.mocked.hooks.instances = () =>
    Response.json({
      code: 0,
      data: {
        items: [
          instance(1),
          instance(2),
          { ...instance(3), summary: "Changed" },
        ],
      },
    });
  assert.equal(
    (await s.tool({ ...ARGS, cursor: first.next_cursor })).result
      .structuredContent.error,
    "agenda_changed_restart",
  );
});
for (const data of [
  {},
  { items: [], has_more: true },
  { items: Array.from({ length: 201 }, (_, i) => instance(i)) },
  { items: [instance(1), instance(1)] },
  { items: [{ ...instance(1), start_time: {} }] },
])
  test(
    "unknown/malformed/oversized instances cannot become complete " +
      JSON.stringify(data).slice(0, 50),
    async () => {
      const s = await setup();
      await s.grant();
      s.mocked.hooks.instances = () => Response.json({ code: 0, data });
      assert.equal((await s.tool()).result.isError, true);
    },
  );
test("explicit inaccessible calendar is retained as partial coverage", async () => {
  const s = await setup();
  await s.grant();
  s.mocked.hooks.instances = () =>
    Response.json({ error: "synthetic-private-error" }, { status: 403 });
  const result = (await s.tool()).result.structuredContent;
  assert.equal(result.partial, true);
  assert.equal(result.traversal_complete, true);
  assert.deepEqual(result.unavailable_calendar_ids, ["cal1"]);
  assert(!JSON.stringify(result).includes("synthetic-private-error"));
});
test("authorization loss between directory and events stops provider traversal", async () => {
  const s = await setup();
  await s.grant();
  const snap = await s.status();
  s.mocked.hooks.calendars = async () => {
    await s.store.disconnect(P, snap.grant_id, snap.epoch);
    return Response.json({
      code: 0,
      data: { calendar_list: [{ calendar_id: "cal1" }], has_more: false },
    });
  };
  const result = await s.tool();
  assert.equal(result.result.isError, true);
  assert.equal(
    s.mocked.calls.filter((c) => c.url.includes("/instance_view")).length,
    0,
  );
});
test("empty directory pages retain cursor and detect provider A-B-A loops", async () => {
  const s = await setup();
  await s.grant();
  let n = 0;
  s.mocked.hooks.calendars = () =>
    Response.json({
      code: 0,
      data: {
        calendar_list: [],
        has_more: true,
        page_token: ["A", "B", "A"][n++],
      },
    });
  const a = (await s.tool()).result.structuredContent;
  assert.equal(a.partial, true);
  const b = (await s.tool({ ...ARGS, cursor: a.next_cursor })).result
    .structuredContent;
  const c = await s.tool({ ...ARGS, cursor: b.next_cursor });
  assert.equal(c.result.structuredContent.error, "provider_cursor_cycle");
});
for (const patch of [
  { timezone: "Invalid/Zone" },
  {
    time_range: { start: "2026-01-01T00:00:00Z", end: "2026-03-01T00:00:00Z" },
  },
  { page_size: 21 },
  { subject: "other" },
  { time_range: { start: "2026-10-05T00:00:00", end: "2026-10-06T00:00:00" } },
])
  test(
    "input validation rejects unsupported or ambiguous arguments " +
      JSON.stringify(patch),
    async () => {
      const s = await setup();
      await s.grant();
      const count = s.mocked.calls.length;
      assert.equal((await s.tool({ ...ARGS, ...patch })).result.isError, true);
      assert.equal(s.mocked.calls.length, count);
    },
  );
test("public origin mismatches, query bearer and malformed bodies fail closed", async () => {
  const s = await setup();
  assert.equal(
    (await s.worker.fetch(new Request("https://evil.test/health"), s.env))
      .status,
    403,
  );
  assert.equal(
    (await s.send("/mcp?access_token=synthetic", { method: "POST" })).status,
    400,
  );
  const response = await s.worker.fetch(
    new Request(P.site + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "oai-authenticated-user-id": P.user,
      },
      body: "x".repeat(32769),
    }),
    s.env,
  );
  assert.equal(response.status, 413);
});

test("provider calendar listing uses the documented minimum page size",async()=>{
 const s=await setup();await s.grant();await s.tool(ARGS);
 const call=s.mocked.calls.find(c=>c.url.includes('/calendar/v4/calendars?'));
 assert.equal(new URL(call.url).searchParams.get('page_size'),'50');
});

test("standard MCP request metadata does not become tool arguments or identity",async()=>{
 const s=await setup();await s.grant();
 const response=await s.send('/mcp',{method:'POST',body:{jsonrpc:'2.0',id:99,method:'tools/call',params:{name:'get_agenda',arguments:ARGS,_meta:{progressToken:'safe',user:'different-user'}}}});
 const data=await response.json();assert.notEqual(data.result.isError,true);assert(data.result.structuredContent.events.length>0);
});
