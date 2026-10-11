import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, P } from "./helpers.mjs";
import { SCOPES } from "../.test-build/module.mjs";
const fields = {
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  expires_in: 3600,
  refresh_token_expires_in: 86400,
  token_type: "Bearer",
  scope: SCOPES.join(" "),
};
for (const patch of [
  { error: "invalid_grant" },
  { code: 99991663 },
  { code: "99991663" },
  { code: null },
  { error: { message: "failure" } },
]) {
  test(
    "exchange rejects error envelope despite complete token fields " +
      JSON.stringify(patch),
    async () => {
      const s = await setup();
      const flow = await s.begin();
      s.mocked.hooks.token = () => Response.json({ ...fields, ...patch });
      assert.equal((await s.callback(flow)).status, 401);
      assert.equal(await s.store.get(P), null);
      assert.equal(s.mocked.calls.length, 1);
    },
  );
  test(
    "refresh rejects error envelope and invalidates only its lease " +
      JSON.stringify(patch),
    async () => {
      const s = await setup();
      const row = await s.grant();
      s.advance(3600000);
      s.mocked.hooks.token = () => Response.json({ ...fields, ...patch });
      await assert.rejects(() => s.link.access(P, row.grant_id));
      assert.equal((await s.store.get(P)).status, "reauthorization_required");
      assert.equal((await s.store.get(P)).credentials, null);
    },
  );
}
test("non-200 token response is not accepted just because it has token fields", async () => {
  const s = await setup();
  const flow = await s.begin();
  s.mocked.hooks.token = () => Response.json(fields, { status: 201 });
  assert.equal((await s.callback(flow)).status, 503);
  assert.equal(await s.store.get(P), null);
});
for (const code of [0, "0", ""])
  test(
    "official success code representation " + JSON.stringify(code),
    async () => {
      const s = await setup();
      const flow = await s.begin();
      s.mocked.hooks.token = () => Response.json({ ...fields, code });
      assert.equal((await s.callback(flow)).status, 303);
    },
  );
