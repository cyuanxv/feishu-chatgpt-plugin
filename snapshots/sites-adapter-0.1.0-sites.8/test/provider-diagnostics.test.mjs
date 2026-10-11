import test from "node:test";
import assert from "node:assert/strict";
import {
  Feishu,
  configurationChecks,
  providerDiagnostic,
  random,
} from "../.test-build/module.mjs";
import { setup, P } from "./helpers.mjs";

async function recorded(run) {
  const original = console.warn,
    logs = [];
  console.warn = (s) => logs.push(JSON.parse(s));
  try {
    await run(logs);
  } finally {
    console.warn = original;
  }
}
test("provider diagnostics retain only standard errors/numeric codes, never sensitive payload fields", () => {
  const d = providerDiagnostic(
    { operation: "oauth_token", kind: "http", http_status: 400 },
    {
      error: "invalid_client",
      code: "20011",
      error_description: "SENSITIVE_description",
      access_token: "SENSITIVE_access",
      refresh_token: "SENSITIVE_refresh",
      client_secret: "SENSITIVE_secret",
      code_verifier: "SENSITIVE_verifier",
      user: { name: "SENSITIVE_name" },
    },
  );
  assert.deepEqual(d, {
    operation: "oauth_token",
    kind: "http",
    http_status: 400,
    provider_error: "invalid_client",
    provider_code: 20011,
  });
  assert(!JSON.stringify(d).includes("SENSITIVE"));
  assert.deepEqual(
    providerDiagnostic(
      { operation: "oauth_token", kind: "http", http_status: 400 },
      { error: "SENSITIVE_unknown_error", code: "SENSITIVE_unknown_code" },
    ),
    { operation: "oauth_token", kind: "http", http_status: 400 },
  );
});
test("OAuth HTTP 400 is distinguishable from a provider outage and creates no grant", () =>
  recorded(async (logs) => {
    const s = await setup();
    const f = await s.begin();
    s.mocked.hooks.token = () =>
      Response.json(
        {
          error: "invalid_client",
          error_description: "SENSITIVE_secret",
          code: 20011,
        },
        { status: 400 },
      );
    const r = await s.callback(f);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, "provider_oauth_rejected");
    assert.equal(await s.store.get(P), null);
    assert.equal(s.mocked.calls.length, 1);
    assert(
      logs.some(
        (d) =>
          d.operation === "oauth_token" &&
          d.http_status === 400 &&
          d.provider_code === 20011 &&
          d.provider_error === "invalid_client",
      ),
    );
    assert(!JSON.stringify(logs).includes("SENSITIVE"));
  }));
test("network exception logs its class without exception message, URL, code or secret", () =>
  recorded(async (logs) => {
    const s = await setup();
    const api = new Feishu(s.env, async () => {
      throw new TypeError("SENSITIVE_secret code=SENSITIVE_code");
    });
    await assert.rejects(
      api.token({ grant_type: "authorization_code", code: "SENSITIVE_code" }),
      { code: "provider_network_error" },
    );
    assert.deepEqual(logs, [
      {
        event: "feishu_provider_failure",
        operation: "oauth_token",
        kind: "network",
        transport_error: "TypeError",
      },
    ]);
  }));
test("HTTP 5xx preserves unavailable error and identifies user_info separately", () =>
  recorded(async (logs) => {
    const s = await setup();
    const f = await s.begin();
    s.mocked.hooks.profile = () =>
      new Response("SENSITIVE_body", { status: 503 });
    assert.equal((await s.callback(f)).status, 503);
    assert.equal(await s.store.get(P), null);
    assert(
      logs.some((d) => d.operation === "user_info" && d.http_status === 503),
    );
    assert(!JSON.stringify(logs).includes("SENSITIVE"));
  }));
test("HTML/oversized non-success bodies do not get logged or hang diagnostics", () =>
  recorded(async (logs) => {
    const s = await setup();
    const api = new Feishu(
      s.env,
      async () => new Response("SENSITIVE_body".repeat(4000), { status: 400 }),
    );
    await assert.rejects(
      api.token({ grant_type: "authorization_code", code: "SENSITIVE_code" }),
      { code: "provider_oauth_rejected" },
    );
    assert.deepEqual(logs, [
      {
        event: "feishu_provider_failure",
        operation: "oauth_token",
        kind: "http",
        http_status: 400,
      },
    ]);
  }));
test("success-status OAuth failure envelope remains rejected with safe code evidence", () =>
  recorded(async (logs) => {
    const s = await setup();
    const f = await s.begin();
    s.mocked.hooks.token = () =>
      Response.json({
        error: "invalid_grant",
        code: 20037,
        error_description: "SENSITIVE_description",
      });
    assert.equal((await s.callback(f)).status, 401);
    assert.equal(await s.store.get(P), null);
    assert(
      logs.some(
        (d) => d.kind === "oauth_rejected" && d.provider_code === 20037,
      ),
    );
    assert(!JSON.stringify(logs).includes("SENSITIVE"));
  }));
test("configuration diagnostics return booleans and distinguish presence from key/secret shape", () => {
  const env = {
    FEISHU_APP_ID: "synthetic-app",
    FEISHU_APP_SECRET: "synthetic-app-secret",
    APP_ENCRYPTION_KEY: random(),
  };
  assert.deepEqual(configurationChecks(env), {
    app_id_present: true,
    app_secret_present: true,
    app_secret_shape_ok: true,
    encryption_key_valid: true,
  });
  for (const key of [undefined, "", "wrong-format", "SENSITIVE_key\n"]) {
    const checks = configurationChecks({ ...env, APP_ENCRYPTION_KEY: key });
    assert.equal(checks.encryption_key_valid, false);
    assert(Object.values(checks).every((v) => typeof v === "boolean"));
  }
  assert.equal(
    configurationChecks({ ...env, FEISHU_APP_SECRET: " synthetic-secret\n" })
      .app_secret_shape_ok,
    false,
  );
});
test("status exposes only boolean diagnostics to the authenticated owner", async () => {
  const s = await setup();
  const status = await s.status();
  assert(
    Object.values(status.configuration_checks).every(
      (v) => typeof v === "boolean",
    ),
  );
  assert(!JSON.stringify(status).includes(s.env.FEISHU_APP_SECRET));
  assert(!JSON.stringify(status).includes(s.env.APP_ENCRYPTION_KEY));
  assert.equal((await s.send("/api/status", { user: null })).status, 401);
});
