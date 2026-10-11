import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  readFile,
  readdir,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

// Standalone synthetic test. Never uses a real account, credential, provider, or Site.
// Usage: node scripts/check-oauth-wire.mjs [source-checkout]
// Executes served UI scripts in Node VM; this is not a real-browser test.
// Build the intended source first. The exact loaded bundle digest is in report.json.
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(
  process.argv.find((arg, index) => index > 1 && !arg.startsWith("--")) ??
    resolve(here, ".."),
);
const output = resolve(
  process.env.FEISHU_WIRE_REPORT_DIR ??
    resolve(source, ".runtime-test/oauth-wire"),
);
await mkdir(output, { recursive: true });
const { Miniflare } = require(
  process.env.MINIFLARE_MODULE ??
    resolve(source, "runtime-check/node_modules/miniflare"),
);
const SITE = "https://feishu.example.test";
const AUTHORIZE = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const TOKEN = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const PROFILE = "https://open.feishu.cn/open-apis/authen/v1/user_info";
const SCOPE =
  "calendar:calendar:read calendar:calendar.event:read offline_access";
const APP = "synthetic-app";
const SECRET = "synthetic-app-secret";
const PROVIDER_TRACE = "20261008074938A1B2C3D4E5F6071829";
const CALLBACK = SITE + "/api/feishu/callback";
const script = await readFile(resolve(source, "dist/server/index.js"), "utf8");
const report = {
  source,
  bundle_sha256: createHash("sha256").update(script).digest("hex"),
  created_at: new Date().toISOString(),
  synthetic_only: true,
  runtime: "official Miniflare/workerd with D1",
  browser_verified: false,
  browser_blocked: null,
  checks: [],
  screenshots: [],
  real_feishu_requests: 0,
  sites_dispatcher_verified: false,
  production_deployed: false,
};
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS " + name);
};
const persistence = await mkdtemp(resolve(output, "synthetic-d1-"));
const codes = new Map();
const tokenCalls = [];
const outboundErrors = [];
const unknownRequests = [];
let profileCalls = 0;
const safeCode = () => "synthetic-code-" + randomBytes(16).toString("hex");
function authorize(url, mode = "success") {
  // Model the HTTP 303 follow-up as a new GET: original form body/cookies stay local.
  const navigation = new Request(url, { method: "GET" });
  assert.equal(navigation.method, "GET");
  assert.equal(navigation.body, null);
  assert.equal(navigation.headers.get("cookie"), null);
  assert.equal(navigation.headers.get("authorization"), null);
  const parsed = new URL(navigation.url),
    p = parsed.searchParams;
  assert.equal(parsed.origin + parsed.pathname, AUTHORIZE);
  const keys = [
    "client_id",
    "response_type",
    "redirect_uri",
    "state",
    "scope",
    "code_challenge",
    "code_challenge_method",
  ];
  assert.equal([...p.keys()].length, keys.length);
  for (const key of keys) assert.equal(p.getAll(key).length, 1, key);
  assert.equal(p.get("client_id"), APP);
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("redirect_uri"), CALLBACK);
  assert.equal(p.get("scope"), SCOPE);
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.match(p.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(p.get("state"), /^[A-Za-z0-9_-]{43}$/);
  const code = safeCode();
  codes.set(code, {
    challenge: p.get("code_challenge"),
    redirect: p.get("redirect_uri"),
    mode,
    used: false,
    state: p.get("state"),
  });
  return CALLBACK + "?" + new URLSearchParams({ code, state: p.get("state") });
}
function rejection(code = 20049, description = "synthetic-provider-rejection") {
  return Response.json(
    { code, error: "invalid_grant", error_description: description },
    { status: 400, headers: { "x-tt-logid": PROVIDER_TRACE } },
  );
}
async function provider(req) {
  if (req.url === TOKEN) {
    report.token_request_headers = {
      content_type: req.headers.get("content-type"),
      accept: req.headers.get("accept"),
    };
    const body = await req.text();
    const p = new URLSearchParams(JSON.parse(body)),
      record = codes.get(p.get("code"));
    const call = {
      valid: false,
      outcome: null,
      verifier: p.get("code_verifier"),
      code: p.get("code"),
      state: record?.state,
    };
    tokenCalls.push(call);
    try {
      assert.equal(req.method, "POST");
      assert.equal(
        req.headers.get("content-type"),
        "application/json; charset=utf-8",
      );
      assert.equal(req.headers.get("authorization"), null);
      const keys = [
        "client_id",
        "client_secret",
        "grant_type",
        "code",
        "redirect_uri",
        "code_verifier",
        "scope",
      ];
      assert.equal([...p.keys()].length, keys.length);
      for (const key of keys) assert.equal(p.getAll(key).length, 1, key);
      assert.equal(p.get("client_id"), APP);
      assert.equal(p.get("client_secret"), SECRET);
      assert.equal(p.get("grant_type"), "authorization_code");
      assert.equal(p.get("scope"), SCOPE);
      assert(record, "one-use synthetic code must exist");
      if (record.used) {
        call.outcome = "replay_rejected";
        return rejection();
      }
      record.used = true;
      assert.equal(p.get("redirect_uri"), record.redirect);
      assert.match(p.get("code_verifier"), /^[A-Za-z0-9_-]{43}$/);
      // Independent Node crypto, evaluated only against the final observed authorize URL.
      const actual = createHash("sha256")
        .update(p.get("code_verifier"), "ascii")
        .digest("base64url");
      if (actual !== record.challenge) {
        call.outcome = "challenge_mismatch_rejected";
        return rejection();
      }
      call.valid = true;
      if (record.mode === "20049") {
        call.outcome = "provider_20049";
        return rejection(
          20049,
          [
            "synthetic-private-provider-detail",
            call.code,
            call.state,
            call.verifier,
            SECRET,
          ].join("|"),
        );
      }
      call.outcome = "accepted";
      return Response.json({
        access_token: "synthetic-user-token",
        refresh_token: "synthetic-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
        scope: SCOPE,
      });
    } catch (error) {
      outboundErrors.push(error.message);
      call.outcome = "invalid_wire_rejected";
      return rejection();
    }
  }
  if (req.url === PROFILE) {
    profileCalls++;
    assert.equal(
      req.headers.get("authorization"),
      "Bearer synthetic-user-token",
    );
    return Response.json({
      code: 0,
      data: {
        open_id: "ou_synthetic",
        tenant_key: "synthetic-tenant",
        name: "Synthetic Account",
      },
    });
  }
  unknownRequests.push(req.url);
  return Response.json(
    { error: "synthetic_test_blocked_outbound" },
    { status: 502 },
  );
}
const mf = new Miniflare({
  modules: true,
  script,
  compatibilityDate: "2026-07-30",
  host: "127.0.0.1",
  port: 0,
  cf: false,
  d1Databases: { DB: "synthetic-feishu-browser-d1" },
  d1Persist: persistence,
  bindings: {
    APP_ORIGIN: SITE,
    APP_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
    FEISHU_APP_ID: APP,
    FEISHU_APP_SECRET: SECRET,
    FEISHU_READ_ENABLED: "true",
  },
  outboundService: provider,
});
async function dispatch(
  path,
  {
    user = "synthetic-owner",
    method = "GET",
    body,
    form,
    origin = SITE,
    cookie,
    accept = "application/json",
  } = {},
) {
  return mf.dispatchFetch(new URL(path, SITE).href, {
    method,
    redirect: "manual",
    headers: {
      ...(user ? { "oai-authenticated-user-id": user } : {}),
      Accept: accept,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json", Origin: origin } : {}),
      ...(form !== undefined
        ? {
            "Content-Type": "application/x-www-form-urlencoded",
            ...(origin ? { Origin: origin } : {}),
          }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(form !== undefined
      ? {
          body:
            typeof form === "string"
              ? form
              : new URLSearchParams(form).toString(),
        }
      : {}),
  });
}
async function begin(user) {
  const status = await (await dispatch("/api/status", { user })).json();
  const response = await dispatch("/api/feishu/connect", {
    user,
    method: "POST",
    form: { csrf: status.csrf },
  });
  assert.equal(response.status, 303);
  assert.equal(await response.clone().text(), "");
  return {
    user,
    url: response.headers.get("location"),
    cookie: response.headers.get("set-cookie").split(";")[0],
  };
}
async function checkFailure(response, call) {
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const html = await response.text();
  assert.match(html, /飞书连接未完成/);
  assert.match(html, /先不要重复授权/);
  assert.match(html, /飞书错误码：20049/);
  assert(html.includes("飞书请求编号：" + PROVIDER_TRACE));
  assert.match(html, /本站关联编号：[a-f0-9-]{36}/);
  assert.match(html, /关联编号：[a-f0-9-]{36}/);
  assert.match(html, /id="error-receipt" readonly/);
  assert.match(html, /id="copy-error"/);
  for (const secret of [
    call.code,
    call.state,
    call.verifier,
    SECRET,
    "synthetic-private-provider-detail",
  ])
    assert(!html.includes(secret), "callback HTML must omit synthetic secret");
  return html;
}
async function uiVM(user) {
  const nodes = Object.fromEntries(
    [
      "status",
      "detail",
      "connect",
      "connect-form",
      "connect-csrf",
      "connect-documents",
      "disconnect",
      "demo",
      "demo-result",
      "refresh-token",
      "documents",
      "doc-search",
      "doc-query",
      "doc-results",
      "doc-content",
      "doc-more",
      "doc-next", "apps", "app-list", "app-add", "app-id", "app-label", "app-secret", "app-message",
    ].map((id) => [
      "#" + id,
      {
        replaceChildren() {}, append() {},
        textContent: "",
        hidden: false,
        disabled: false,
        listeners: [],
        addEventListener(event, handler) {
          assert.equal(
            event,
            ["connect-form", "doc-search", "app-add"].includes(id) ? "submit" : "click",
          );
          this.listeners.push(handler);
        },
      },
    ]),
  );
  const destinations = [],
    paths = [];
  let cookie;
  const context = {
    document: {
      createElement() { return {append(){},addEventListener(){}}; },
      querySelector(selector) {
        assert(nodes[selector]);
        return nodes[selector];
      },
    },
    URL,
    Date,
    window: { addEventListener() {} },
    location: {
      origin: SITE,
      assign(url) {
        throw Error("No provider URL navigation from JavaScript is allowed");
      },
    },
    fetch: async (path, init = {}) => {
      paths.push(path);
      const response = await dispatch(path, {
        user,
        cookie,
        method: init.method ?? "GET",
        ...(init.body ? { body: JSON.parse(init.body) } : {}),
      });
      if (response.headers.has("set-cookie"))
        cookie = response.headers.get("set-cookie").split(";")[0];
      return response;
    },
  };
  await vm.runInNewContext(await (await dispatch("/ui.js")).text(), context, {
    timeout: 1000,
  });
  return {
    nodes,
    destinations,
    paths,
    get cookie() {
      return cookie;
    },
    async click() {
      let prevented = false;
      nodes["#connect-form"].listeners[0]({
        preventDefault() {
          prevented = true;
        },
      });
      if (prevented) return;
      paths.push("native-form-post");
      const response = await dispatch("/api/feishu/connect", {
        user,
        method: "POST",
        form: { csrf: nodes["#connect-csrf"].value },
        accept: "text/html",
      });
      assert.equal(response.status, 303);
      assert.equal(await response.text(), "");
      cookie = response.headers.get("set-cookie").split(";")[0];
      destinations.push(response.headers.get("location"));
      return response;
    },
  };
}
try {
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir(resolve(source, "drizzle")))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    for (const sql of (await readFile(resolve(source, "drizzle", file), "utf8"))
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  }
  pass("actual workerd D1 schema initialized");
  const flow = await begin("synthetic-wire-success");
  const callback = authorize(flow.url);
  const before = tokenCalls.length;
  const response = await dispatch(callback, flow);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  assert.equal(tokenCalls.length, before + 1);
  assert.equal(tokenCalls.at(-1).outcome, "accepted");
  assert.equal(profileCalls, 1);
  assert.equal(
    (await (await dispatch("/api/status", flow)).json()).connected,
    true,
  );
  pass(
    "Node/workerd final authorize serialization and actual outbound token form agree by independent S256",
  );
  assert.equal((await dispatch(callback, flow)).status, 400);
  assert.equal(tokenCalls.length, before + 1);
  pass("actual workerd callback replay rejected before a second token request");

  const mismatch = await begin("synthetic-wire-mismatch");
  const changed = new URL(mismatch.url);
  changed.searchParams.set(
    "code_challenge",
    randomBytes(32).toString("base64url"),
  );
  const mismatchCallback = authorize(changed.href);
  const mismatchBefore = tokenCalls.length;
  await checkFailure(
    await dispatch(mismatchCallback, { ...mismatch, accept: "text/html" }),
    tokenCalls.at(-1),
  );
  assert.equal(tokenCalls.length, mismatchBefore + 1);
  assert.equal(tokenCalls.at(-1).outcome, "challenge_mismatch_rejected");
  assert.equal(
    (await (await dispatch("/api/status", mismatch)).json()).connected,
    false,
  );
  pass(
    "independent provider rejects a mutated final authorize challenge despite internally matching Worker bindings",
  );

  const omitted = new URL((await begin("synthetic-wire-omitted")).url);
  omitted.searchParams.delete("code_challenge");
  const codeCount = codes.size;
  assert.throws(() => authorize(omitted.href));
  assert.equal(codes.size, codeCount);
  pass(
    "independent synthetic authorize endpoint refuses missing challenge without minting a code",
  );

  const failed = await begin("synthetic-wire-20049");
  const failedCallback = authorize(failed.url, "20049");
  const failedBefore = tokenCalls.length;
  const failureHTML = await checkFailure(
    await dispatch(failedCallback, { ...failed, accept: "text/html" }),
    tokenCalls.at(-1),
  );
  assert.equal(tokenCalls.length, failedBefore + 1);
  assert.equal(tokenCalls.at(-1).valid, true);
  assert.equal(
    (await (await dispatch("/api/status", failed)).json()).connected,
    false,
  );
  assert.equal((await dispatch(failedCallback, failed)).status, 400);
  assert.equal(tokenCalls.length, failedBefore + 1);
  const errorScript = await (await dispatch("/oauth-error.js")).text();
  assert.match(errorScript, /history\.replaceState\(null,'',cleanupPath\)/);
  assert.match(
    errorScript,
    /navigator\.clipboard\.writeText\(receipt\.value\)/,
  );
  assert.match(errorScript, /receipt\.select\(\)/);
  assert(!/fetch\(|location\.assign|setTimeout|setInterval/.test(errorScript));
  pass(
    "actual workerd 20049 HTML has safe copyable receipt, no secret interpolation, no token retry; URL-cleaning/copy script is served",
  );

  const ui = await uiVM("synthetic-ui-wire-success");
  await ui.click();
  assert.equal(ui.destinations.length, 1);
  const uiCallback = authorize(ui.destinations[0]);
  assert.equal(
    (
      await dispatch(uiCallback, {
        user: "synthetic-ui-wire-success",
        cookie: ui.cookie,
      })
    ).status,
    303,
  );
  assert.equal(tokenCalls.at(-1).outcome, "accepted");
  pass(
    "served form submit guard models native POST and server 303-to-GET; independent provider verifies actual workerd token transport",
  );

  await ui.click();
  assert.equal(ui.destinations.length, 1);
  assert.equal(ui.paths.filter((x) => x === "native-form-post").length, 1);
  pass(
    "served UI submit handler locks a repeated native form submission without JS provider navigation",
  );

  const formUser = "synthetic-form-race";
  const formStatus = await (
    await dispatch("/api/status", { user: formUser })
  ).json();
  const repeated = await Promise.all(
    Array.from({ length: 10 }, () =>
      dispatch("/api/feishu/connect", {
        user: formUser,
        method: "POST",
        form: { csrf: formStatus.csrf },
        accept: "text/html",
      }),
    ),
  );
  assert.equal(repeated.filter((r) => r.status === 303).length, 1);
  assert.equal(repeated.filter((r) => r.status === 409).length, 9);
  for (const rejected of repeated.filter((r) => r.status === 409)) {
    assert.equal(rejected.headers.get("location"), null);
    assert.equal(rejected.headers.get("set-cookie"), null);
    const html = await rejected.text();
    assert.match(html, /connection_already_started/);
    assert.match(html, /回到连接页/);
    assert(!html.includes(formStatus.csrf));
  }
  const claims = await db
    .prepare(
      "SELECT count(*) n FROM oauth_form_submissions WHERE site=? AND user_id=?",
    )
    .bind(SITE, formUser)
    .first();
  assert.equal(claims.n, 1);
  pass(
    "actual D1 permits one concurrent form claim; nine repeated POSTs receive safe errors without another cookie or redirect",
  );

  const protectedUser = "synthetic-form-protected";
  const protectedStatus = await (
    await dispatch("/api/status", { user: protectedUser })
  ).json();
  const beforeProtected = tokenCalls.length;
  for (const opts of [
    { method: "GET" },
    { method: "POST", form: "" },
    { method: "POST", body: { csrf: protectedStatus.csrf } },
    {
      method: "POST",
      form: { csrf: protectedStatus.csrf },
      origin: "https://evil.example.test",
    },
    { method: "POST", form: { csrf: protectedStatus.csrf }, origin: null },
    { method: "POST", form: { csrf: protectedStatus.csrf }, user: null },
    {
      method: "POST",
      form: {
        csrf: protectedStatus.csrf,
        redirect_uri: "https://evil.example.test",
      },
    },
    {
      method: "POST",
      form:
        new URLSearchParams({ csrf: protectedStatus.csrf }).toString() +
        "&csrf=duplicate",
    },
  ]) {
    const denial = await dispatch("/api/feishu/connect", {
      user: protectedUser,
      accept: "text/html",
      ...opts,
    });
    assert(denial.status >= 400);
    assert.equal(denial.headers.get("location"), null);
    assert.equal(denial.headers.get("set-cookie"), null);
    const html = await denial.text();
    assert.match(html, /飞书连接未完成/);
    assert(!html.includes(protectedStatus.csrf));
  }
  assert.equal(tokenCalls.length, beforeProtected);
  pass(
    "actual Worker rejects GET, missing/duplicate CSRF, JSON starts, wrong Origin, missing identity and redirect injection before authorization",
  );

  for (const phase of ["before", "after"]) {
    const recoveryUser = "synthetic-form-recovery-" + phase;
    const snapshot = await (
      await dispatch("/api/status", { user: recoveryUser })
    ).json();
    const trigger =
      phase === "before"
        ? "CREATE TRIGGER synthetic_form_failure BEFORE INSERT ON oauth_states WHEN NEW.user_id='synthetic-form-recovery-before' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;"
        : "CREATE TRIGGER synthetic_form_failure AFTER INSERT ON oauth_states WHEN NEW.user_id='synthetic-form-recovery-after' BEGIN SELECT RAISE(FAIL,'synthetic uncertain failure'); END;";
    await db.prepare(trigger).run();
    const failedStart = await dispatch("/api/feishu/connect", {
      user: recoveryUser,
      method: "POST",
      form: { csrf: snapshot.csrf },
      accept: "text/html",
    });
    assert.equal(failedStart.status, 503);
    assert.equal(failedStart.headers.get("location"), null);
    assert.equal(failedStart.headers.get("set-cookie"), null);
    assert.match(await failedStart.text(), /回到连接页/);
    await db.prepare("DROP TRIGGER synthetic_form_failure").run();
    const count = async () =>
      (
        await db
          .prepare(
            "SELECT count(*) n FROM oauth_states WHERE site=? AND user_id=?",
          )
          .bind(SITE, recoveryUser)
          .first()
      ).n;
    const afterFailure = await count();
    assert.equal(
      (
        await dispatch("/api/feishu/connect", {
          user: recoveryUser,
          method: "POST",
          form: { csrf: snapshot.csrf },
          accept: "text/html",
        })
      ).status,
      409,
    );
    assert.equal(await count(), afterFailure);
    const renewed = await (
      await dispatch("/api/status", { user: recoveryUser })
    ).json();
    assert.notEqual(renewed.csrf, snapshot.csrf);
    assert.equal(
      (
        await dispatch("/api/feishu/connect", {
          user: recoveryUser,
          method: "POST",
          form: { csrf: renewed.csrf },
        })
      ).status,
      303,
    );
    assert.equal(await count(), afterFailure + 1);
  }
  pass(
    "actual D1 start-write failures before/after insert reject old form replay and recover immediately through a fresh homepage CSRF",
  );

  const { Store } = await import(
    pathToFileURL(resolve(source, ".test-build/module.mjs")).href
  );
  const clockSQL =
    "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now";
  const atomicUser = { site: SITE, user: "synthetic-atomic-expiry" };
  const enteredAt = (await db.prepare(clockSQL).first()).now;
  const oldExpiry = enteredAt + 200;
  const oldHash = "synthetic-old-form-hash";
  await db
    .prepare(
      "INSERT INTO oauth_form_submissions(site,user_id,csrf_hash,expires) VALUES(?,?,?,?)",
    )
    .bind(SITE, atomicUser.user, oldHash, oldExpiry)
    .run();
  let releaseOld, signalOld;
  const gateOld = new Promise((resolve) => {
    releaseOld = resolve;
  });
  const pausedOld = new Promise((resolve) => {
    signalOld = resolve;
  });
  function wrapped(sql, args = []) {
    return {
      bind(...values) {
        return wrapped(sql, values);
      },
      async run() {
        return db
          .prepare(sql)
          .bind(...args)
          .run();
      },
      async first() {
        if (
          sql.startsWith("INSERT INTO oauth_form_submissions") &&
          args[2] === oldHash
        ) {
          signalOld();
          await gateOld;
        }
        return db
          .prepare(sql)
          .bind(...args)
          .first();
      },
    };
  }
  const delayedStore = new Store({ prepare: wrapped });
  const oldOutcome = delayedStore
    .claimForm(atomicUser, oldHash, oldExpiry, enteredAt)
    .then(
      () => "accepted",
      (error) => error.code,
    );
  try {
    await pausedOld;
    const currentDB = (await db.prepare(clockSQL).first()).now;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, oldExpiry - currentDB + 30)),
    );
    const laterDB = (await db.prepare(clockSQL).first()).now;
    assert(laterDB > oldExpiry);
    await new Store(db).claimForm(
      atomicUser,
      "synthetic-fresh-form-hash",
      laterDB + 60000,
      laterDB,
    );
    releaseOld();
    assert.equal(await oldOutcome, "csrf_expired");
    const survivors = await db
      .prepare(
        "SELECT csrf_hash FROM oauth_form_submissions WHERE site=? AND user_id=?",
      )
      .bind(SITE, atomicUser.user)
      .all();
    assert.deepEqual(
      survivors.results.map((row) => row.csrf_hash),
      ["synthetic-fresh-form-hash"],
    );
  } finally {
    releaseOld();
  }
  pass(
    "native workerd D1 clock rejects a delayed expired INSERT after a fresh claim cleans the old marker; no stale Worker timestamp can reauthorize it",
  );

  const receiptText = failureHTML.match(
    /<textarea[^>]*>([\s\S]*?)<\/textarea>/,
  )[1];
  for (const clipboardWorks of [true, false]) {
    const receipt = {
      value: receiptText,
      focused: false,
      selected: false,
      focus() {
        this.focused = true;
      },
      select() {
        this.selected = true;
      },
    };
    const status = { textContent: "" },
      button = {
        addEventListener(type, fn) {
          assert.equal(type, "click");
          this.click = fn;
        },
      };
    const replacements = [],
      copies = [];
    await vm.runInNewContext(
      errorScript,
      {
        history: {
          replaceState(...args) {
            replacements.push(args);
          },
        },
        document: {
      createElement() { return {append(){},addEventListener(){}}; },
          querySelector(selector) {
            return {
              "#error-receipt": receipt,
              "#copy-status": status,
              "#copy-error": button,
            }[selector];
          },
        },
        navigator: {
          clipboard: {
            async writeText(text) {
              if (!clipboardWorks)
                throw new Error("synthetic clipboard unavailable");
              copies.push(text);
            },
          },
        },
      },
      { timeout: 1000 },
    );
    assert.deepEqual(replacements, [[null, "", "/api/feishu/callback"]]);
    await button.click();
    if (clipboardWorks) {
      assert.deepEqual(copies, [receiptText]);
      assert.equal(status.textContent, "已复制");
    } else {
      assert.equal(receipt.focused, true);
      assert.equal(receipt.selected, true);
      assert.equal(status.textContent, "请复制已选中的错误信息");
    }
  }
  pass(
    "served callback script executes safe URL replacement and both clipboard/manual-select paths in Node VM",
  );

  report.browser_blocked =
    "Not attempted: this script verifies actual workerd and served scripts in Node VM, not a browser";
  assert.deepEqual(outboundErrors, []);
  assert.deepEqual(unknownRequests, []);
  report.token_requests = tokenCalls.length;
  report.profile_requests = profileCalls;
  report.node_workerd_verified = true;
  console.log(
    JSON.stringify({
      node_workerd_verified: true,
      browser_verified: report.browser_verified,
      passed: report.checks.length,
      bundle_sha256: report.bundle_sha256,
      real_feishu_requests: 0,
      token_request_headers: report.token_request_headers,
    }),
  );
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
  console.error(error);
} finally {
  await mf.dispose();
  await rm(persistence, { recursive: true, force: true });
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
