import test from "node:test";
import assert from "node:assert/strict";
import { createDocxD1Access, SCOPES } from "../.test-build/module.mjs";
import { setup, P } from "./helpers.mjs";
const readScopes = [...SCOPES, "search:docs:read", "docx:document:readonly"];
async function fixture() {
  const s = await setup();
  const row = await s.grant();
  s.db.sql
    .prepare(
      "UPDATE connections SET scopes=?,version=version+1 WHERE site=? AND user_id=?",
    )
    .run(JSON.stringify(readScopes), P.site, P.user);
  return { s, row };
}
test("D1 access bridge awaits actual Linking and exposes the current persisted revision", async () => {
  const { s, row } = await fixture();
  const access = createDocxD1Access(s.store, s.link);
  const result = await access(P, row.grant_id, "search:docs:read");
  assert.equal(result.token, "synthetic-user-token");
  assert.equal(result.grant, row.grant_id);
  assert.deepEqual(result.scopes, [...readScopes].sort());
  assert.equal(result.revision, (await s.store.current(P)).version);
});
test("D1 bridge rejects missing scope before an expired token could refresh", async () => {
  const s = await setup();
  const row = await s.grant();
  s.advance(3600000);
  const before = s.mocked.calls.length;
  await assert.rejects(
    createDocxD1Access(s.store, s.link)(P, row.grant_id, "search:docs:read"),
    { code: "insufficient_scope" },
  );
  assert.equal(s.mocked.calls.length, before);
});
test("D1 bridge rejects mutation after asynchronous Linking resolves but before final Store reread", async () => {
  const { s, row } = await fixture();
  const linked = {
    access: async (...args) => {
      const result = await s.link.access(...args);
      await Promise.resolve();
      s.db.sql
        .prepare(
          "UPDATE connections SET version=version+1 WHERE site=? AND user_id=?",
        )
        .run(P.site, P.user);
      return result;
    },
  };
  await assert.rejects(
    createDocxD1Access(s.store, linked)(P, row.grant_id, "search:docs:read"),
    { code: "docx_state_changed_restart", status: 409 },
  );
  assert.equal((await s.store.current(P)).status, "active");
  assert.equal((await s.store.current(P)).grant_id, row.grant_id);
});
test("D1 bridge rejects malformed persisted scopes and undeclared scope requests", async () => {
  const { s, row } = await fixture(),
    access = createDocxD1Access(s.store, s.link),
    before = s.mocked.calls.length;
  await assert.rejects(access(P, row.grant_id, "arbitrary:write"), {
    code: "invalid_argument",
  });
  for (const value of ["not-json", "[123]", "{}"]) {
    s.db.sql
      .prepare("UPDATE connections SET scopes=? WHERE site=? AND user_id=?")
      .run(value, P.site, P.user);
    await assert.rejects(access(P, row.grant_id, "search:docs:read"), {
      code: "provider_scope_changed",
    });
  }
  assert.equal(s.mocked.calls.length, before);
});
test("existing calendar Linking rejects DOCX-only grants without expanding consent or calling providers", async () => {
  const { s, row } = await fixture();
  s.db.sql
    .prepare(
      "UPDATE connections SET scopes=?,version=version+1 WHERE site=? AND user_id=?",
    )
    .run(
      JSON.stringify(["search:docs:read", "docx:document:readonly"]),
      P.site,
      P.user,
    );
  const before = s.mocked.calls.length;
  await assert.rejects(
    createDocxD1Access(s.store, s.link)(P, row.grant_id, "search:docs:read"),
    { code: "provider_scope_changed" },
  );
  assert.equal(s.mocked.calls.length, before);
});
