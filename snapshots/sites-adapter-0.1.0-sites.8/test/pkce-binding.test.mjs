import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setup, P } from "./helpers.mjs";
import { hash, aad, SCOPES } from "../.test-build/module.mjs";
async function pending(s, f) {
  const stateHash = await hash(f.url.searchParams.get("state"));
  const row = s.db.sql
    .prepare("SELECT * FROM oauth_states WHERE state_hash=?")
    .get(stateHash);
  return {
    stateHash,
    secret: await s.vault.open(row.verifier, aad(P, "oauth", stateHash)),
  };
}
test("sealed authorization bindings survive storage and independent S256 computation", async () => {
  const s = await setup(),
    f = await s.begin();
  const { secret } = await pending(s, f);
  assert.equal(secret.version, 2);
  assert.equal(secret.challenge, f.url.searchParams.get("code_challenge"));
  assert.equal(
    secret.challenge,
    createHash("sha256").update(secret.verifier, "ascii").digest("base64url"),
  );
  assert.equal(secret.redirectUri, f.url.searchParams.get("redirect_uri"));
  assert.equal(secret.clientId, f.url.searchParams.get("client_id"));
  assert.equal((await s.callback(f)).status, 303);
  const params = new URLSearchParams(JSON.parse(s.mocked.calls[0].init.body));
  assert.equal(params.get("code_verifier"), secret.verifier);
  assert.equal(params.get("scope"), SCOPES.join(" "));
});
for (const field of ["challenge", "redirectUri", "clientId", "version"]) {
  test(
    "changed sealed " +
      field +
      " fails before provider transport and cannot replay",
    async () => {
      const s = await setup(),
        f = await s.begin();
      const { secret, stateHash } = await pending(s, f);
      secret[field] = field === "version" ? 1 : "synthetic-mismatch";
      const cipher = await s.vault.seal(secret, aad(P, "oauth", stateHash));
      s.db.sql
        .prepare("UPDATE oauth_states SET verifier=? WHERE state_hash=?")
        .run(cipher, stateHash);
      const r = await s.callback(f);
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, "oauth_binding_mismatch");
      assert.equal((await s.callback(f)).status, 400);
      assert.equal(s.mocked.calls.length, 0);
      assert.equal(await s.store.get(P), null);
    },
  );
}
test("old pending record fails closed and requires a fresh authorization", async () => {
  const s = await setup(),
    f = await s.begin();
  const { secret, stateHash } = await pending(s, f);
  const cipher = await s.vault.seal(
    { verifier: secret.verifier },
    aad(P, "oauth", stateHash),
  );
  s.db.sql
    .prepare("UPDATE oauth_states SET verifier=? WHERE state_hash=?")
    .run(cipher, stateHash);
  assert.equal((await s.callback(f)).status, 400);
  assert.equal(s.mocked.calls.length, 0);
});
test("changed configured client ID fails before exchanging an old code", async () => {
  const s = await setup(),
    f = await s.begin();
  s.env.FEISHU_APP_ID = "synthetic-new-app";
  assert.equal((await s.callback(f)).status, 400);
  assert.equal(s.mocked.calls.length, 0);
});
test("cumulative grants can be narrowed but extra returned scopes still fail closed", async () => {
  for (const honorsRequestedScope of [true, false]) {
    const s = await setup(),
      f = await s.begin();
    s.mocked.hooks.token = (_url, init) => {
      const scope = new URLSearchParams(JSON.parse(init.body)).get("scope");
      assert.equal(scope, SCOPES.join(" "));
      return Response.json({
        access_token: "synthetic-token",
        refresh_token: "synthetic-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
        scope: honorsRequestedScope ? scope : scope + " auth:user.id:read",
      });
    };
    const r = await s.callback(f);
    assert.equal(r.status, honorsRequestedScope ? 303 : 401);
    if (!honorsRequestedScope)
      assert.equal((await r.json()).error, "provider_scope_changed");
  }
});
test("binding diagnostic has only fixed labels, booleans and bounded length", async () => {
  const logs = [],
    orig = console.info;
  console.info = (line) => logs.push(JSON.parse(line));
  try {
    const s = await setup(),
      f = await s.begin();
    assert.equal((await s.callback(f)).status, 303);
    const binding = logs.filter(
      (x) => x.event === "feishu_oauth_binding_check",
    );
    assert.deepEqual(binding, [
      {
        event: "feishu_oauth_binding_check",
        diagnostic_version: 1,
        endpoint: "feishu_oauth_v2_pkce",
        version_matches: true,
        challenge_matches: true,
        redirect_matches: true,
        client_matches: true,
        verifier_length: 43,
      },
    ]);
  } finally {
    console.info = orig;
  }
});

test("provider 20049 still fails closed without retry or endpoint fallback", async () => {
  const s = await setup(),
    f = await s.begin();
  s.mocked.hooks.token = () =>
    Response.json(
      {
        code: 20049,
        error: "invalid_grant",
        error_description: "PKCE code challenge failed.",
      },
      { status: 400 },
    );
  const r = await s.callback(f);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "provider_oauth_rejected");
  assert.equal(s.mocked.calls.length, 1);
  assert.equal(
    s.mocked.calls[0].url,
    "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
  );
  assert.equal(await s.store.get(P), null);
  assert.equal((await s.callback(f)).status, 400);
  assert.equal(s.mocked.calls.length, 1);
});
