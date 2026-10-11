import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, request, P } from "./helpers.mjs";
import { createWorker, SCOPES, DOCX_SCOPES } from "../.test-build/module.mjs";
const all = [...SCOPES, ...DOCX_SCOPES];
function expanded(s) {
  s.env.FEISHU_DOCX_ENABLED = "true";
  s.mocked.hooks.token = async () =>
    Response.json({
      access_token: "synthetic-docx-token",
      refresh_token: "synthetic-docx-refresh",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token_expires_in: 86400,
      scope: all.join(" "),
    });
}
test("DOCX defaults off; synthetic mode cannot expose DOCX even when flag is true", async () => {
  const s = await setup();
  for (const env of [
    s.env,
    { ...s.env, FEISHU_DATA_MODE: "synthetic", FEISHU_DOCX_ENABLED: "true" },
  ]) {
    const r = await s.worker.fetch(
      request("/mcp", {
        method: "POST",
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      }),
      env,
    );
    assert.deepEqual(
      (await r.json()).result.tools.map((t) => t.name),
      ["get_agenda"],
    );
  }
  assert.equal(
    (await s.tool({ query: "test" }, P.user, "search_docx")).result
      .structuredContent.error,
    "write_or_unknown_tool_denied",
  );
});
test("enabling DOCX preserves old calendar grant and denies document transport without scopes", async () => {
  const s = await setup();
  await s.grant();
  s.env.FEISHU_DOCX_ENABLED = "true";
  assert.equal((await s.tool()).result.isError, false);
  const before = s.mocked.calls.length;
  assert.equal(
    (await s.tool({ query: "test" }, P.user, "search_docx")).result
      .structuredContent.error,
    "insufficient_scope",
  );
  assert.equal(s.mocked.calls.length, before);
  assert.equal((await s.status()).docx_authorized, false);
});
test("expanded scope is bound to OAuth flow, supports MCP search/fetch and refresh, retains agenda", async () => {
  const s = await setup();
  expanded(s);
  const flow = await s.begin(P.user, true);
  assert.deepEqual(flow.url.searchParams.get("scope").split(" "), all);
  assert.equal((await s.callback(flow)).status, 303);
  assert.equal((await s.status()).docx_authorized, true);
  const worker = createWorker({
    now: s.now,
    fetcher: async (url, init) => {
      if (url.includes("/doc_wiki/search"))
        return Response.json({
          code: 0,
          data: {
            res_units: [
              {
                entity_type: "DOC",
                result_meta: { token: "synthetic_doc", doc_types: "DOCX" },
                title_highlighted: "Synthetic document",
              },
            ],
            has_more: false,
          },
        });
      if (url.endsWith("/raw_content"))
        return Response.json({
          code: 0,
          data: { content: "Synthetic document text" },
        });
      return s.mocked.fetcher(url, init);
    },
  });
  const call = async (name, args) =>
    (
      await (
        await worker.fetch(
          request("/mcp", {
            method: "POST",
            body: {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args, _meta: { progressToken: 1 } },
            },
          }),
          s.env,
        )
      ).json()
    ).result;
  const result = await call("search_docx", { query: "test" });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.source, "feishu_api");
  const fetched = await call("fetch_docx", {
    result_id: result.structuredContent.results[0].result_id,
  });
  assert.equal(fetched.structuredContent.content, "Synthetic document text");
  assert.equal((await s.tool()).result.isError, false);
  s.advance(3600000);
  assert.equal((await s.tool()).result.isError, false);
  assert.equal(
    (
      await call("fetch_docx", {
        result_id: result.structuredContent.results[0].result_id,
      })
    ).isError,
    true,
  );
});
test("old pending OAuth stays calendar-only after enable; disable rejects expanded callback without replacing grant", async () => {
  const s = await setup();
  const old = await s.begin();
  s.env.FEISHU_DOCX_ENABLED = "true";
  assert.equal((await s.callback(old)).status, 303);
  const grant = (await s.status()).grant_id;
  expanded(s);
  const newer = await s.begin(P.user, true);
  s.env.FEISHU_DOCX_ENABLED = "false";
  assert.equal((await s.callback(newer)).status, 401);
  assert.equal((await s.status()).grant_id, grant);
  assert.equal((await s.tool()).result.isError, false);
});

test('manual renewal is same-origin, CSRF-bound and rotates only the current grant', async () => {
  const s = await setup(); await s.grant();
  const snap = await s.status();
  const before = s.mocked.calls.length;
  const payload = { csrf: snap.csrf, grant_id: snap.grant_id, epoch: snap.epoch };
  assert.equal((await s.send('/api/feishu/refresh', {method:'POST',body:payload})).status,403);
  assert.equal(s.mocked.calls.length,before);
  const row = await s.store.get(P);
  const response = await s.send('/api/feishu/refresh',{method:'POST',headers:{Origin:P.site},body:payload});
  assert.equal(response.status,200); assert.equal((await response.json()).refreshed,true);
  assert.equal((await s.store.get(P)).version,row.version+1);
  assert.equal((await s.tool()).result.isError,false);
});
