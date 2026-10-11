import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Actual loopback HTTP -> workerd -> native D1. Headers here are explicit test
// vectors, not browser-generated evidence. Never follows the provider Location.
const { Miniflare } = createRequire(import.meta.url)(
  "../runtime-check/node_modules/miniflare",
);
const SITE = "https://feishu.example.test";
const persistence = await mkdtemp(join(tmpdir(), "feishu-form-http-"));
let outbound = 0;
const mf = new Miniflare({
  modules: true,
  script: await readFile("dist/server/index.js", "utf8"),
  compatibilityDate: "2026-07-30",
  host: "127.0.0.1",
  port: 0,
  upstream: SITE,
  cf: false,
  d1Databases: { DB: "synthetic-form-http" },
  d1Persist: persistence,
  bindings: {
    APP_ORIGIN: SITE,
    APP_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
    FEISHU_APP_ID: "synthetic-app",
    FEISHU_APP_SECRET: "synthetic-secret",
    FEISHU_READ_ENABLED: "true",
  },
  outboundService: () => {
    outbound++;
    throw Error("No outbound request is allowed in form HTTP regression");
  },
});
let count = 0;
const pass = (name) => console.log(`PASS ${++count}: ${name}`);
try {
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("drizzle"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    for (const sql of (await readFile("drizzle/" + file, "utf8"))
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  const base = await mf.ready;
  async function http(path, init = {}) {
    return fetch(new URL(path, base), {
      ...init,
      redirect: "manual",
      headers: {
        "oai-authenticated-user-id": "synthetic-owner",
        ...init.headers,
      },
    });
  }
  const home = await http("/");
  assert.equal(home.status, 200);
  assert.equal(home.headers.get("referrer-policy"), "same-origin");
  assert.match(
    await home.text(),
    /method="post" action="\/api\/feishu\/connect"/,
  );
  pass("actual HTTP homepage serves native form and same-origin policy");
  const status = await (await http("/api/status")).json();
  const post = (origin, csrf = status.csrf) =>
    http("/api/feishu/connect", {
      method: "POST",
      headers: {
        ...(origin === undefined ? {} : { Origin: origin }),
        Referer: SITE + "/",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(csrf === undefined ? {} : { csrf }).toString(),
    });
  for (const origin of ["null", undefined, "https://other.example.test"]) {
    const denied = await post(origin);
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /cross_origin_denied/);
    assert.equal(denied.headers.get("location"), null);
    assert.equal(denied.headers.get("set-cookie"), null);
    assert.equal(denied.headers.get("referrer-policy"), "no-referrer");
  }
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM oauth_states").first()).n,
    0,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) AS n FROM oauth_form_submissions")
        .first()
    ).n,
    0,
  );
  pass(
    "opaque, absent and foreign origins fail before state/claim despite same-origin metadata",
  );
  const missingCsrf = await post(SITE, "");
  assert.equal(missingCsrf.status, 400);
  assert.equal(missingCsrf.headers.get("location"), null);
  const forgedCsrf = await post(SITE, randomBytes(48).toString("base64url"));
  assert.equal(forgedCsrf.status, 400);
  assert.equal(forgedCsrf.headers.get("location"), null);
  assert.equal(forgedCsrf.headers.get("set-cookie"), null);
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) AS n FROM oauth_form_submissions")
        .first()
    ).n,
    0,
  );
  pass("matching Origin still requires valid owner-bound CSRF");
  const started = await post(SITE);
  assert.equal(started.status, 303);
  assert.equal(started.headers.get("referrer-policy"), "no-referrer");
  assert.equal(await started.text(), "");
  const target = new URL(started.headers.get("location"));
  assert.equal(
    target.origin + target.pathname,
    "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
  );
  assert.match(
    started.headers.get("set-cookie"),
    /; Secure; HttpOnly; SameSite=Lax;/,
  );
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM oauth_states").first()).n,
    1,
  );
  pass(
    "matching form receives fixed 303, no-referrer and protected cookie through real HTTP",
  );
  const replay = await post(SITE);
  assert.equal(replay.status, 409);
  assert.equal(replay.headers.get("location"), null);
  assert.equal(replay.headers.get("set-cookie"), null);
  const callback = await http(
    "/api/feishu/callback?code=synthetic-only&state=synthetic-only",
    { headers: { Accept: "text/html" } },
  );
  assert.equal(callback.status, 400);
  assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
  const callbackHtml = await callback.text();
  assert(!callbackHtml.includes("synthetic-only"));
  assert.match(callbackHtml, /回到连接页/);
  assert.equal(outbound, 0);
  pass("replay/error privacy remains enforced; zero provider requests");
  console.log(
    JSON.stringify({
      passed: count,
      native_http: true,
      browser_verified: false,
      real_provider_requests: outbound,
    }),
  );
} finally {
  await mf.dispose();
  await rm(persistence, { recursive: true, force: true });
}
