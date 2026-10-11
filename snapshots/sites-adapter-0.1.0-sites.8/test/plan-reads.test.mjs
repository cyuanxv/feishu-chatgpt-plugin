import test from "node:test";
import assert from "node:assert/strict";
import {
  Apps,
  PlanReads,
  UnifiedSearch,
  SCOPES,
  READ_SCOPES,
  DOCX_SCOPES,
  WRITE_SCOPES,
  READ_TOOL,
} from "../.test-build/module.mjs";
import { setup, P } from "./helpers.mjs";
async function ready() {
  const s = await setup();
  await s.grant();
  s.db.sql
    .prepare("UPDATE connections SET scopes=?")
    .run(
      JSON.stringify([
        ...SCOPES,
        ...READ_SCOPES,
        ...DOCX_SCOPES,
        ...WRITE_SCOPES,
      ]),
    );
  return s;
}
test("all original 30 tool names and the new booking tool are exposed only through explicit feature gates", async () => {
  const s = await ready();
  s.env.FEISHU_DOCX_ENABLED = "true";
  s.env.FEISHU_WRITE_ENABLED = "true";
  const r = await s.send("/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  const names = (await r.json()).result.tools.map((t) => t.name);
  const original = [
    "get_profile",
    "search",
    "fetch",
    "search_people",
    "list_chats",
    "search_messages",
    "get_message_thread",
    "list_doc_comments",
    "list_bases",
    "get_base_schema",
    "query_base_records",
    "get_agenda",
    "get_free_busy",
    "suggest_meeting_times",
    "list_meeting_rooms",
    "list_tasks",
    "get_task",
    "send_message",
    "reply_message",
    "create_doc",
    "update_doc",
    "add_doc_comment",
    "create_base_record",
    "update_base_record",
    "create_event",
    "update_event",
    "respond_event",
    "create_task",
    "update_task",
    "complete_task",
  ];
  for (const name of [...original, "book_meeting_room"])
    assert(names.includes(name), name);
  assert.equal(new Set(names).size, names.length);
});
test("unified search signs owner/grant-bound references and pages into the message domain", async () => {
  const s = await ready();
  let content = "first content";
  const apps = new Apps(
    s.env,
    async (url) => {
      if (url.includes("doc_wiki"))
        return Response.json({
          code: 0,
          data: {
            res_units: [
              {
                entity_type: "DOC",
                title_highlighted: "<b>Plan</b>",
                result_meta: { doc_types: "DOCX", token: "doc1" },
              },
            ],
            has_more: false,
          },
        });
      if (url.includes("/raw_content"))
        return Response.json({ code: 0, data: { content } });
      return Response.json({
        code: 0,
        data: {
          items: [{ meta_data: { message_id: "om_1" } }],
          has_more: false,
        },
      });
    },
    s.now,
  );
  const u = new UnifiedSearch(apps, s.now);
  const a = { query: "Plan", types: ["doc", "message"] },
    first = await u.search(P, a);
  assert.equal(first.results[0].title, "Plan");
  assert(first.next_cursor);
  assert.equal(first.partial, true);
  const second = await u.search(P, { ...a, cursor: first.next_cursor });
  assert.equal(second.results[0].type, "message");
  assert.equal(second.next_cursor, null);
  const fetched = await u.fetch(P, { result_id: first.results[0].result_id });
  assert.equal(fetched.data.content, "first content");
  await assert.rejects(() =>
    u.fetch({ ...P, user: "other" }, { result_id: first.results[0].result_id }),
  );
  s.db.sql.prepare("UPDATE connections SET grant_id='reconnected'").run();
  await assert.rejects(
    () => u.fetch(P, { result_id: first.results[0].result_id }),
    { code: "connection_changed" },
  );
});
test("Base filters resolve real field IDs and reject typed mismatches before record reads", async () => {
  const s = await ready();
  let recordCalls = 0,
    body;
  const apps = new Apps(
    s.env,
    async (url, init) => {
      if (url.includes("/fields"))
        return Response.json({
          code: 0,
          data: {
            items: [
              { field_id: "fld_n", field_name: "Amount", type: 2 },
              { field_id: "fld_t", field_name: "Name", type: 1 },
            ],
            has_more: false,
          },
        });
      recordCalls++;
      body = JSON.parse(init.body);
      return Response.json({ code: 0, data: { items: [], has_more: false } });
    },
    s.now,
  );
  const p = new PlanReads(apps);
  const input = {
    base_id: "base1",
    table_id: "tbl1",
    filter: { field_id: "fld_n", operator: "gt", value: 3 },
    sort: { field_id: "fld_n", direction: "desc" },
  };
  await p.run(P, "query_base_records", input);
  assert.equal(body.filter.conditions[0].field_name, "Amount");
  assert.equal(body.sort[0].desc, true);
  assert.equal(body.filter.conditions[0].value[0], "3");
  await assert.rejects(
    () =>
      p.run(P, "query_base_records", {
        ...input,
        filter: { ...input.filter, value: "3" },
      }),
    { code: "filter_type_mismatch" },
  );
  assert.equal(recordCalls, 1);
});
test("assignee search rechecks detail membership and reports inaccessible or changed tasks as partial", async () => {
  const s = await ready();
  const apps = new Apps(
    s.env,
    async (url) =>
      url.includes("/search")
        ? Response.json({
            code: 0,
            data: {
              items: [{ id: "task1" }, { id: "task2" }],
              has_more: false,
            },
          })
        : Response.json({
            code: 0,
            data: {
              task: {
                guid: url.includes("task1") ? "task1" : "task2",
                completed_at: "0",
                members: [
                  {
                    id: url.includes("task1") ? "ou_one" : "ou_other",
                    type: "user",
                    role: "assignee",
                  },
                ],
              },
            },
          }),
    s.now,
  );
  const r = await new PlanReads(apps).run(P, "list_tasks", {
    assignee_id: "ou_one",
    status: "todo",
  });
  assert.equal(r.data.items.length, 1);
  assert.equal(r.omitted[0].task_id, "task2");
  assert.equal(r.partial, true);
  assert.equal(r.coverage, "visible_tasks_for_explicit_assignee");
});
test("changing DOCX content invalidates continuation instead of joining revisions", async () => {
  const s = await ready();
  let content = "a".repeat(13000);
  const apps = new Apps(
    s.env,
    async () => Response.json({ code: 0, data: { content } }),
    s.now,
  );
  const args = { operation: "docx_text", parameters: { token: "doc1" } };
  const r = await apps.query(P, args);
  content = "b".repeat(13000);
  await assert.rejects(
    () =>
      apps.query(P, {
        ...args,
        connection_id: r.connection_id,
        cursor: r.next_cursor,
      }),
    { code: "document_changed_restart" },
  );
});
