import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";
test("MCP discovery contains no private data and does not require manufactured user identity", async () => {
  const s = await setup();
  for (const method of ["initialize", "tools/list", "ping"]) {
    const r = await s.send("/mcp", {
      method: "POST",
      user: null,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method,
        params: { protocolVersion: "2025-11-25" },
      },
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert(data.result);
    assert(!JSON.stringify(data).includes("synthetic-owner"));
  }
  const denied = await s.send("/mcp", {
    method: "POST",
    user: null,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_agenda", arguments: {} },
    },
  });
  assert.equal(denied.status, 401);
  assert.equal(s.mocked.calls.length, 0);
});
test("changing upstream scope state before traversal fails without returning source data", async () => {
  const s = await setup();
  await s.grant();
  s.db.sql.prepare("UPDATE connections SET scopes=?").run("[]");
  const result = await s.tool();
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent.error, "provider_scope_changed");
});
