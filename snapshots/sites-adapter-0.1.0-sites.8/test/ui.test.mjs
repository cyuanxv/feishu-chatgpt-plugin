import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { setup, P } from "./helpers.mjs";

async function browser(s, respond = () => null) {
  const ids = [
    "status",
    "detail",
    "connect",
    "connect-form",
    "connect-csrf",
    "disconnect",
    "demo",
    "demo-result",
  ];
  const nodes = Object.fromEntries(
    ids.map((id) => [
      "#" + id,
      {
        textContent: "",
        hidden: false,
        disabled: false,
        listeners: [],
        addEventListener(event, handler) {
          assert.equal(event, id === "connect-form" ? "submit" : "click");
          this.listeners.push(handler);
        },
      },
    ]),
  );
  const paths = [],
    redirects = [];
  let cookie;
  const windowEvents = new Map();
  const submissions = [];
  const context = {
    document: {
      querySelector(selector) {
        assert(nodes[selector]);
        return nodes[selector];
      },
    },
    URL,
    Date,
    window: {
      addEventListener: (event, handler) => windowEvents.set(event, handler),
    },
    location: {
      origin: P.site,
      assign(url) {
        throw new Error("JS must not navigate to a provider URL");
      },
    },
    fetch: async (path, init = {}) => {
      paths.push(path);
      const overridden = respond(path, init);
      if (overridden) return overridden;
      const response = await s.send(path, {
        method: init.method ?? "GET",
        ...(init.body
          ? { body: JSON.parse(init.body), headers: { Origin: P.site } }
          : {}),
      });
      if (response.headers.has("set-cookie"))
        cookie = response.headers.get("set-cookie").split(";")[0];
      return response;
    },
  };
  const js = await (await s.send("/ui.js")).text();
  await vm.runInNewContext(js, context, { timeout: 1000 });
  for (const id of ["connect-form", "disconnect", "demo"])
    assert.equal(nodes["#" + id].listeners.length, 1, "one handler for " + id);
  return {
    nodes,
    paths,
    redirects,
    submissions,
    pageshow: async () => {
      await windowEvents.get("pageshow")({ persisted: true });
      await new Promise((resolve) => setImmediate(resolve));
    },
    get cookie() {
      return cookie;
    },
    click: async (id) => {
      if (id !== "connect") return nodes["#" + id].listeners[0]();
      let prevented = false;
      nodes["#connect-form"].listeners[0]({
        preventDefault() {
          prevented = true;
        },
      });
      if (prevented) return;
      const payload = new URLSearchParams({
        csrf: nodes["#connect-csrf"].value,
      }).toString();
      submissions.push(payload);
      paths.push("/api/feishu/connect");
      const response = await s.send("/api/feishu/connect", {
        method: "POST",
        form: payload,
        headers: { Origin: P.site, Accept: "text/html" },
      });
      if (response.headers.has("set-cookie"))
        cookie = response.headers.get("set-cookie").split(";")[0];
      if (response.status === 303)
        redirects.push(response.headers.get("location"));
      return response;
    },
  };
}

test("served ui.js initializes and the demo button renders clearly fictional results", async () => {
  const s = await setup();
  s.env.FEISHU_DATA_MODE = "synthetic";
  delete s.env.APP_ENCRYPTION_KEY;
  delete s.env.FEISHU_APP_SECRET;
  const b = await browser(s);
  assert.deepEqual(b.paths, ["/api/status"]);
  assert.equal(b.nodes["#status"].textContent, "合成演示模式");
  assert.equal(b.nodes["#connect"].hidden, true);
  assert.equal(b.nodes["#disconnect"].hidden, true);
  await b.click("demo");
  assert.equal(b.paths.at(-1), "/api/demo/agenda");
  assert(!b.paths.includes("/mcp"));
  assert.match(b.nodes["#demo-result"].textContent, /虚构日程/);
  assert.equal(b.nodes["#demo"].disabled, false);
  assert.equal(s.mocked.calls.length, 0);
  await b.click("connect");
  await b.click("disconnect");
  assert(!b.paths.some((p) => p.startsWith("/api/feishu/")));
});

test("served ui.js connects with only the connect handler", async () => {
  const s = await setup();
  const b = await browser(s);
  await b.click("connect");
  assert.deepEqual(b.paths, ["/api/status", "/api/feishu/connect"]);
  assert.equal(b.redirects.length, 1);
  assert.equal(new URL(b.redirects[0]).origin, "https://accounts.feishu.cn");
  assert.equal(s.mocked.calls.length, 0);
});

test("served UI navigation is independently bound to the final token Request form", async () => {
  const s = await setup();
  const b = await browser(s);
  await b.click("connect");
  const authorization = new URL(b.redirects[0]);
  const code = "synthetic_code_+/%&=";
  let checked = false;
  s.mocked.hooks.token = async (url, init) => {
    const body = await new Request(url, init).formData();
    assert.equal(body.get("code"), code);
    assert.equal(
      createHash("sha256")
        .update(body.get("code_verifier"), "ascii")
        .digest("base64url"),
      authorization.searchParams.get("code_challenge"),
    );
    assert.equal(
      body.get("redirect_uri"),
      authorization.searchParams.get("redirect_uri"),
    );
    assert.equal(
      body.get("client_id"),
      authorization.searchParams.get("client_id"),
    );
    assert.equal(body.get("scope"), authorization.searchParams.get("scope"));
    checked = true;
    return Response.json({
      access_token: "synthetic-token",
      refresh_token: "synthetic-refresh",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token_expires_in: 86400,
      scope: body.get("scope"),
    });
  };
  const result = await s.send(
    "/api/feishu/callback?" +
      new URLSearchParams({
        state: authorization.searchParams.get("state"),
        code,
      }),
    { headers: { Cookie: b.cookie } },
  );
  assert.equal(result.status, 303);
  assert.equal(checked, true);
  assert.equal(s.mocked.calls.length, 2);
});

test("native form is same-origin POST, submit is locked, and BFcache refresh does not authorize", async () => {
  const s = await setup(),
    b = await browser(s);
  const page = await s.send("/");
  const html = await page.text();
  assert.match(
    html,
    /<form id="connect-form" method="post" action="\/api\/feishu\/connect" enctype="application\/x-www-form-urlencoded">/,
  );
  assert.match(html, /<input id="connect-csrf" type="hidden" name="csrf"/);
  assert.match(
    page.headers.get("content-security-policy"),
    /form-action 'self' https:\/\/accounts\.feishu\.cn;/,
  );
  await Promise.all([b.click("connect"), b.click("connect")]);
  assert.equal(b.submissions.length, 1);
  assert.equal(b.redirects.length, 1);
  assert.equal(
    s.db.sql.prepare("SELECT count(*) n FROM oauth_states").get().n,
    1,
  );
  assert.equal(
    s.db.sql.prepare("SELECT count(*) n FROM oauth_form_submissions").get().n,
    1,
  );
  const before = b.nodes["#connect-csrf"].value;
  await b.pageshow();
  assert.notEqual(b.nodes["#connect-csrf"].value, before);
  assert.equal(b.nodes["#connect"].disabled, false);
  assert.equal(b.submissions.length, 1);
  assert.equal(s.mocked.calls.length, 0);
  await b.click("connect");
  assert.equal(b.submissions.length, 2);
  assert.equal(b.redirects.length, 2);
});

test("served ui.js disconnect button removes only the current grant", async () => {
  const s = await setup();
  await s.grant();
  const b = await browser(s);
  assert.equal(b.nodes["#disconnect"].hidden, false);
  await b.click("disconnect");
  assert.deepEqual(b.paths, [
    "/api/status",
    "/api/feishu/disconnect",
    "/api/status",
  ]);
  assert.equal(await s.store.get(P), null);
  assert.equal(b.redirects.length, 0);
});

for (const [status, body, type] of [
  [401, "Unauthorized", "text/plain"],
  [403, "Forbidden", "text/plain"],
  [502, "<html>proxy failure</html>", "text/html"],
  [200, "<html>login</html>", "text/html"],
  [200, "invalid-json", "application/json"],
])
  test(
    "served UI handles non-JSON/status failure without leaking parser errors " +
      status +
      " " +
      type,
    async () => {
      const s = await setup();
      s.env.FEISHU_DATA_MODE = "synthetic";
      const b = await browser(s, (path) =>
        path === "/api/demo/agenda"
          ? new Response(body, { status, headers: { "Content-Type": type } })
          : null,
      );
      await b.click("demo");
      assert.match(
        b.nodes["#demo-result"].textContent,
        status === 401 || status === 403 ? /重新登录/ : /演示暂时不可用/,
      );
      assert.doesNotMatch(
        b.nodes["#demo-result"].textContent,
        /Unexpected token|Unauthorized|Forbidden|proxy failure|invalid-json/,
      );
      assert.equal(b.nodes["#demo"].disabled, false);
      assert.equal(s.mocked.calls.length, 0);
    },
  );

test("browser demo succeeds while the platform reserves /mcp for separate authorization", async () => {
  const s = await setup();
  s.env.FEISHU_DATA_MODE = "synthetic";
  const b = await browser(s, (path) =>
    path === "/mcp" ? new Response("Unauthorized", { status: 401 }) : null,
  );
  await b.click("demo");
  assert.match(b.nodes["#demo-result"].textContent, /虚构日程/);
  assert.deepEqual(b.paths, ["/api/status", "/api/demo/agenda"]);
});
