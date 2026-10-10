import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, P } from "./helpers.mjs";
import { SCOPES, aad, random } from "../.test-build/module.mjs";
test("refresh rotates credentials, expiry and scopes atomically", async () => {
  const s = await setup();
  const row = await s.grant();
  s.advance(3600000);
  const before = s.mocked.calls.length;
  const token = await s.link.access(P, row.grant_id);
  assert.equal(s.mocked.calls.length, before + 1);
  assert.equal(
    new URLSearchParams(JSON.parse(s.mocked.calls.at(-1).init.body)).get(
      "grant_type",
    ),
    "refresh_token",
  );
  assert.equal(token.row.version, row.version + 1);
  assert.equal(token.row.lease, null);
  assert(token.row.expires > s.now());
});
test("concurrent refresh holds one durable lease and makes only one provider request", async () => {
  const s = await setup();
  const row = await s.grant();
  s.advance(3600000);
  const before = s.mocked.calls.length;
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => s.link.access(P, row.grant_id)),
  );
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(s.mocked.calls.length, before + 1);
});
test("ambiguous refresh invalidates only the leased grant and cannot replay the old token", async () => {
  const s = await setup();
  const row = await s.grant();
  s.advance(3600000);
  s.mocked.hooks.token = () => {
    throw Error("unknown redemption outcome");
  };
  await assert.rejects(() => s.link.access(P, row.grant_id));
  assert.equal((await s.store.get(P)).status, "reauthorization_required");
  const calls = s.mocked.calls.length;
  await assert.rejects(() => s.link.access(P, row.grant_id));
  assert.equal(s.mocked.calls.length, calls);
});
test("expired uncertain lease requires reconnect instead of reusing a one-use refresh token", async () => {
  const s = await setup();
  const row = await s.grant();
  s.advance(3600000);
  await s.store.lease(P, row, s.now());
  s.advance(30001);
  const before = s.mocked.calls.length;
  await assert.rejects(() => s.link.access(P, row.grant_id));
  assert.equal((await s.store.get(P)).status, "reauthorization_required");
  assert.equal(s.mocked.calls.length, before);
});
for (const outcome of ["success", "failure"])
  test(
    "old refresh " +
      outcome +
      " cannot overwrite or revoke an explicit new grant",
    async () => {
      const s = await setup();
      const row = await s.grant();
      s.advance(3600000);
      let fresh;
      const oldTokenHook = s.mocked.hooks.token;
      s.mocked.hooks.token = async () => {
        s.mocked.hooks.token = oldTokenHook;
        fresh = await s.grant();
        if (outcome === "failure") throw Error("old refresh failed");
        return Response.json({
          access_token: "old-result",
          refresh_token: "old-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token_expires_in: 86400,
          scope: SCOPES.join(" "),
        });
      };
      await assert.rejects(() => s.link.access(P, row.grant_id));
      const current = await s.store.get(P);
      assert.equal(current.grant_id, fresh.grant_id);
      assert.equal(current.status, "active");
      assert(
        !JSON.stringify(
          await s.vault.open(
            current.credentials,
            aad(P, "credentials", current.grant_id),
          ),
        ).includes("old-result"),
      );
    },
  );
test("disconnect during refresh cannot resurrect credentials", async () => {
  const s = await setup();
  const row = await s.grant();
  const snap = await s.status();
  s.advance(3600000);
  s.mocked.hooks.token = async () => {
    await s.store.disconnect(P, row.grant_id, snap.epoch);
    return Response.json({
      access_token: "stale",
      refresh_token: "stale",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token_expires_in: 86400,
      scope: SCOPES.join(" "),
    });
  };
  await assert.rejects(() => s.link.access(P, row.grant_id));
  assert.equal(await s.store.get(P), null);
});
test("scope narrowing or malformed refresh does not leave a usable partial grant", async () => {
  const s = await setup();
  const row = await s.grant();
  s.advance(3600000);
  s.mocked.hooks.token = () =>
    Response.json({
      access_token: "x",
      refresh_token: "x",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token_expires_in: 86400,
      scope: "offline_access",
    });
  await assert.rejects(() => s.link.access(P, row.grant_id));
  assert.equal((await s.store.get(P)).credentials, null);
});
test("ABA delete/reinsert with version one cannot reuse a stale lease", async () => {
  const s = await setup();
  const row = await s.grant();
  await s.store.disconnect(P, row.grant_id, await s.store.epoch(P));
  const fresh = await s.grant();
  assert.equal(row.version, fresh.version);
  assert.notEqual(row.grant_id, fresh.grant_id);
  await assert.rejects(() => s.store.lease(P, row, s.now()));
  assert.equal((await s.store.get(P)).grant_id, fresh.grant_id);
});
