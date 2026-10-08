import test from "node:test";
import assert from "node:assert/strict";
import { setup, P } from "./helpers.mjs";
import {
  hash,
  providerLogId,
  safeProviderLogId,
  ProviderFailure,
  Store,
} from "../.test-build/module.mjs";

const TRACE = "20261008074938A1B2C3D4E5F6071829";
const post = (s, csrf, extra = {}) =>
  s.send("/api/feishu/connect", {
    method: "POST",
    form: { csrf },
    headers: { Origin: P.site, Accept: "text/html" },
    ...extra,
  });
test("only the connection homepage permits same-origin referrers; redirects, errors and assets do not", async () => {
  const s = await setup();
  const home = await s.send("/");
  assert.equal(home.headers.get("referrer-policy"), "same-origin");
  for (const path of [
    "/ui.js",
    "/style.css",
    "/api/status",
    "/oauth-error.js",
    "/api/feishu/callback",
    "/api/feishu/connect",
    "/?unexpected=private-query",
  ]) {
    assert.equal(
      (await s.send(path)).headers.get("referrer-policy"),
      "no-referrer",
      path,
    );
  }
  const status = await s.status();
  const result = await post(s, status.csrf);
  assert.equal(result.status, 303);
  assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  assert.equal(s.mocked.calls.length, 0);
});
test("CSRF expiring during the rate-limit await cannot acquire or renew a form claim", async () => {
  const s = await setup(),
    snapshot = await s.status();
  const originalRate = Store.prototype.rate;
  Store.prototype.rate = async function (...args) {
    await originalRate.apply(this, args);
    s.advance(600001);
  };
  let result;
  try {
    result = await post(s, snapshot.csrf);
  } finally {
    Store.prototype.rate = originalRate;
  }
  assert.equal(result.status, 400);
  assert.match(await result.text(), /csrf_expired/);
  assert.equal(result.headers.get("location"), null);
  assert.equal(
    s.db.sql.prepare("SELECT count(*) n FROM oauth_form_submissions").get().n,
    0,
  );
  assert.equal(
    s.db.sql.prepare("SELECT count(*) n FROM oauth_states").get().n,
    0,
  );
  assert.equal(s.mocked.calls.length, 0);
});
test("an old form paused before atomic INSERT cannot reclaim after a fresh request cleans its expired marker", async () => {
  const s = await setup(),
    old = await s.status();
  assert.equal((await post(s, old.csrf)).status, 303);
  const oldHash = await hash(old.csrf),
    originalPrepare = s.db.prepare;
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const paused = new Promise((resolve) => {
    entered = resolve;
  });
  s.db.prepare = (sql) => {
    const statement = originalPrepare(sql),
      originalBind = statement.bind;
    statement.bind = (...args) => {
      const bound = originalBind(...args),
        originalFirst = bound.first;
      if (
        sql.startsWith("INSERT INTO oauth_form_submissions") &&
        args[2] === oldHash
      )
        bound.first = async () => {
          entered();
          await gate;
          return originalFirst();
        };
      return bound;
    };
    return statement;
  };
  const delayed = post(s, old.csrf);
  try {
    await paused;
    s.advance(600001);
    const fresh = await s.status();
    assert.equal((await post(s, fresh.csrf)).status, 303);
    release();
    const replay = await delayed;
    assert.equal(replay.status, 400);
    assert.match(await replay.text(), /csrf_expired/);
    assert.equal(replay.headers.get("location"), null);
    assert.equal(replay.headers.get("set-cookie"), null);
    assert.equal(
      s.db.sql.prepare("SELECT count(*) n FROM oauth_form_submissions").get().n,
      1,
    );
    assert.equal(
      s.db.sql.prepare("SELECT count(*) n FROM oauth_states").get().n,
      2,
    );
    assert.equal(s.mocked.calls.length, 0);
  } finally {
    release();
    s.db.prepare = originalPrepare;
  }
});
test("protected form redirects once with no POST body or CSRF in the provider handoff", async () => {
  const s = await setup(),
    status = await s.status();
  const response = await post(s, status.csrf);
  assert.equal(response.status, 303);
  assert.equal(await response.clone().text(), "");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(
    response.headers.get("set-cookie"),
    /__Host-feishu-link=.*; Path=\/; Secure; HttpOnly; SameSite=Lax;/,
  );
  const url = new URL(response.headers.get("location"));
  assert.equal(
    url.origin + url.pathname,
    "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
  );
  assert(!url.href.includes(status.csrf));
  assert.equal(url.searchParams.has("csrf"), false);
  assert.equal(s.mocked.calls.length, 0);
  const claim = s.db.sql.prepare("SELECT * FROM oauth_form_submissions").get();
  assert.equal(claim.csrf_hash, await hash(status.csrf));
  assert(!JSON.stringify(claim).includes(status.csrf));
  const second = await post(s, status.csrf);
  assert.equal(second.status, 409);
  assert.equal(second.headers.get("set-cookie"), null);
  assert.equal(second.headers.get("location"), null);
  const html = await second.text();
  assert.match(html, /connection_already_started/);
  assert.match(html, /回到连接页/);
  assert(!html.includes(status.csrf));
  const flow = {
    url,
    cookie: response.headers.get("set-cookie").split(";")[0],
    user: P.user,
  };
  assert.equal((await s.callback(flow)).status, 303);
  assert.equal((await post(s, status.csrf)).status, 409);
  assert.equal((await s.callback(flow)).status, 400);
  assert.equal(s.mocked.calls.length, 2);
});
test("form claim expiry removes old replay hashes without storing original form values", async () => {
  const s = await setup();
  await s.begin();
  const old = s.db.sql
    .prepare("SELECT csrf_hash FROM oauth_form_submissions")
    .get().csrf_hash;
  s.advance(600001);
  await s.begin();
  const rows = s.db.sql.prepare("SELECT * FROM oauth_form_submissions").all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].csrf_hash, old);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "csrf_hash",
    "expires",
    "site",
    "user_id",
  ]);
});
for (const [name, options, expected] of [
  ["GET", { method: "GET", form: undefined }, 405],
  ["HEAD", { method: "HEAD", form: undefined }, 405],
  ["missing CSRF", { form: "" }, 400],
  [
    "plain text",
    {
      form: "csrf=SENSITIVE_form",
      headers: {
        Origin: P.site,
        Accept: "text/html",
        "Content-Type": "text/plain",
      },
    },
    415,
  ],
  [
    "cross-site Origin",
    { headers: { Origin: "https://evil.test", Accept: "text/html" } },
    403,
  ],
  ["no Origin", { headers: { Accept: "text/html" } }, 403],
  [
    "opaque Origin even with same-origin fetch metadata and Referer",
    {
      headers: {
        Origin: "null",
        Referer: P.site + "/",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        Accept: "text/html",
      },
    },
    403,
  ],
  ["no identity", { user: null }, 401],
  ["another identity", { user: "another-synthetic-owner" }, 400],
])
  test(
    "native form " +
      name +
      " has a safe error page and no state or provider request",
    async () => {
      const s = await setup(),
        status = await s.status();
      const r = await post(s, status.csrf, options);
      assert.equal(r.status, expected);
      assert.equal(r.headers.get("location"), null);
      assert.equal(r.headers.get("set-cookie"), null);
      const html = await r.text();
      assert.match(html, /飞书连接未完成/);
      assert.match(html, /回到连接页/);
      assert.match(html, /data-cleanup-path="\/api\/feishu\/connect"/);
      assert(!html.includes(status.csrf));
      assert(!html.includes("SENSITIVE_form"));
      assert.equal(
        s.db.sql.prepare("SELECT count(*) n FROM oauth_states").get().n,
        0,
      );
      assert.equal(
        s.db.sql.prepare("SELECT count(*) n FROM oauth_form_submissions").get()
          .n,
        0,
      );
      assert.equal(s.mocked.calls.length, 0);
    },
  );
test("expired CSRF and owner rate limit fail safely before another state is created", async () => {
  const s = await setup(),
    status = await s.status();
  s.advance(600001);
  const expired = await post(s, status.csrf);
  assert.equal(expired.status, 400);
  assert.match(await expired.text(), /csrf_expired/);
  for (let i = 0; i < 10; i++) await s.begin();
  const fresh = await s.status(),
    limited = await post(s, fresh.csrf);
  assert.equal(limited.status, 429);
  assert.match(await limited.text(), /rate_limited/);
  assert.equal(
    s.db.sql.prepare("SELECT count(*) n FROM oauth_form_submissions").get().n,
    10,
  );
  assert.equal(s.mocked.calls.length, 0);
});
test("only a bounded ASCII value from the fixed x-tt-logid header is eligible", () => {
  for (const value of ["A".repeat(8), TRACE, "z".repeat(128)])
    assert.equal(providerLogId(new Headers({ "X-Tt-Logid": value })), value);
  for (const value of [
    null,
    "",
    "short",
    "A".repeat(129),
    "id with spaces",
    "https://example.test/id",
    "<script>private</script>",
    "id,second",
    "中文编号编号编号编号",
  ]) {
    assert.equal(safeProviderLogId(value), undefined);
    if (value !== null && /^[\x00-\xff]*$/.test(value))
      assert.equal(
        providerLogId(new Headers({ "x-tt-logid": value })),
        undefined,
      );
  }
  assert.equal(safeProviderLogId("safe-id\nprivate"), undefined);
  assert.equal(
    providerLogId(new Headers({ "x-request-id": TRACE })),
    undefined,
  );
  const duplicate = new Headers();
  duplicate.append("x-tt-logid", TRACE);
  duplicate.append("x-tt-logid", TRACE);
  assert.equal(providerLogId(duplicate), undefined);
  assert.equal(
    new ProviderFailure(
      "provider_oauth_rejected",
      400,
      20049,
      "<script>private</script>",
    ).providerLogId,
    undefined,
  );
});

for (const afterState of [false, true])
  test(
    "a failed start " +
      (afterState ? "after" : "before") +
      " state persistence recovers with a new form without replaying the old one",
    async () => {
      const s = await setup(),
        first = await s.status();
      const originalSet = URLSearchParams.prototype.set;
      if (afterState) {
        URLSearchParams.prototype.set = function (key, value) {
          return originalSet.call(
            this,
            key,
            key === "code_challenge_method" ? "plain" : value,
          );
        };
      } else {
        s.db.sql.exec(
          "CREATE TRIGGER synthetic_start_failure BEFORE INSERT ON oauth_states BEGIN SELECT RAISE(ABORT,'synthetic state storage failure'); END;",
        );
      }
      let failure;
      try {
        failure = await post(s, first.csrf);
      } finally {
        URLSearchParams.prototype.set = originalSet;
        if (!afterState) s.db.sql.exec("DROP TRIGGER synthetic_start_failure");
      }
      assert.equal(failure.status, afterState ? 400 : 503);
      assert.equal(failure.headers.get("location"), null);
      assert.equal(failure.headers.get("set-cookie"), null);
      assert.match(await failure.text(), /回到连接页/);
      const pendingBefore = s.db.sql
        .prepare("SELECT count(*) n FROM oauth_states")
        .get().n;
      assert.equal(pendingBefore, afterState ? 1 : 0);
      assert.equal((await post(s, first.csrf)).status, 409);
      assert.equal(
        s.db.sql.prepare("SELECT count(*) n FROM oauth_states").get().n,
        pendingBefore,
      );
      const fresh = await s.status();
      assert.notEqual(fresh.csrf, first.csrf);
      const recovered = await post(s, fresh.csrf);
      assert.equal(recovered.status, 303);
      assert.equal(
        s.db.sql.prepare("SELECT count(*) n FROM oauth_states").get().n,
        pendingBefore + 1,
      );
      assert.equal(s.mocked.calls.length, 0);
    },
  );
for (const status of [400, 403, 200])
  test(
    "provider trace is separated from local correlation for HTTP " + status,
    async () => {
      const s = await setup(),
        flow = await s.begin(),
        original = console.warn,
        logs = [];
      s.mocked.hooks.token = () =>
        Response.json(
          {
            code: 20049,
            error: "invalid_grant",
            log_id: "SENSITIVE_body_trace",
            error_description: "SENSITIVE_description",
          },
          {
            status,
            headers: {
              "x-tt-logid": TRACE,
              "x-request-id": "SENSITIVE_other_header",
            },
          },
        );
      console.warn = (line) => logs.push(JSON.parse(line));
      let html;
      try {
        const r = await s.send(
          "/api/feishu/callback?" +
            new URLSearchParams({
              state: flow.url.searchParams.get("state"),
              code: "synthetic",
            }),
          { headers: { Cookie: flow.cookie, Accept: "text/html" } },
        );
        html = await r.text();
        assert(r.status >= 400);
      } finally {
        console.warn = original;
      }
      assert.match(html, new RegExp("飞书请求编号：" + TRACE));
      assert.match(html, /本站关联编号：[a-f0-9-]{36}/);
      assert(!html.includes("SENSITIVE"));
      assert(logs.some((x) => x.provider_log_id === TRACE));
      assert(!JSON.stringify(logs).includes("SENSITIVE"));
      assert.equal(s.mocked.calls.length, 1);
      assert.equal(await s.store.get(P), null);
    },
  );
test("missing or malformed provider trace never falls back to body or other headers", async () => {
  for (const value of [
    undefined,
    "<script>SENSITIVE</script>",
    "https://SENSITIVE.example/",
    "A".repeat(129),
  ]) {
    const s = await setup(),
      flow = await s.begin();
    s.mocked.hooks.token = () =>
      Response.json(
        { code: 20049, error: "invalid_grant", log_id: TRACE },
        {
          status: 400,
          headers: {
            ...(value === undefined ? {} : { "x-tt-logid": value }),
            "x-request-id": TRACE,
          },
        },
      );
    const r = await s.send(
      "/api/feishu/callback?" +
        new URLSearchParams({
          state: flow.url.searchParams.get("state"),
          code: "synthetic",
        }),
      { headers: { Cookie: flow.cookie, Accept: "text/html" } },
    );
    const html = await r.text();
    assert.match(html, /飞书请求编号：未提供/);
    assert(!html.includes(TRACE));
    assert(!html.includes("SENSITIVE"));
    assert(!html.includes("A".repeat(129)));
  }
});
