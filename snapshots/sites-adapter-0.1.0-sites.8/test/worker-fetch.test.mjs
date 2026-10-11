import { test } from "node:test";
import assert from "node:assert/strict";
import { Feishu } from "../.test-build/module.mjs";
import { setup } from "./helpers.mjs";
test("native Workers fetch keeps its global receiver", async () => {
  const s = await setup();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = function (url, options) {
    assert.equal(this, globalThis);
    calls++;
    return s.mocked.fetcher(url, options);
  };
  try {
    const client = new Feishu(s.env);
    await client.token({
      grant_type: "authorization_code",
      code: "synthetic",
      redirect_uri: s.env.APP_ORIGIN + "/api/feishu/callback",
      code_verifier: "V".repeat(43),
    });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("token and resource redirects never forward code, secret or bearer to a new URL", async () => {
  const s = await setup();
  let calls = 0;
  const client = new Feishu(s.env, async (_url, options) => {
    calls++;
    assert.equal(options.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { Location: "https://evil.example.test/token" },
    });
  });
  await assert.rejects(
    () => client.token({ grant_type: "authorization_code", code: "synthetic" }),
    { code: "provider_redirect_denied" },
  );
  await assert.rejects(() => client.calendars("synthetic-token"), {
    code: "provider_redirect_denied",
  });
  assert.equal(calls, 2);
});
