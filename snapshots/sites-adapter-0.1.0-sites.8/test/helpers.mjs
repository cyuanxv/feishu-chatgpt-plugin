import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  createWorker,
  Store,
  Vault,
  Feishu,
  Linking,
  random,
  SCOPES,
} from "../.test-build/module.mjs";
export const P = {
  site: "https://feishu.example.test",
  user: "synthetic-owner",
};
export const ARGS = {
  time_range: { start: "2026-10-05T00:00:00Z", end: "2026-10-06T00:00:00Z" },
  timezone: "UTC",
  page_size: 2,
};
export function database(clock = Date.now) {
  const sql = new DatabaseSync(":memory:");
  // Keep the unit SQLite clock aligned with the injected Worker clock. The
  // workerd harness separately exercises SQLite's native date implementation.
  sql.function("julianday", (value) => {
    assert.equal(value, "now");
    return clock() / 86400000 + 2440587.5;
  });
  for (const file of readdirSync("drizzle")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sql.exec(readFileSync("drizzle/" + file, "utf8"));
  const prepare = (q) => {
    const st = sql.prepare(q);
    const make = (args) => ({
      bind: (...v) => make(v),
      _all: () => st.all(...args),
      first: async () => st.get(...args) ?? null,
      all: async () => ({ results: st.all(...args) }),
      run: async () => st.run(...args),
    });
    return make([]);
  };
  return {
    sql,
    prepare,
    async batch(items) {
      sql.exec("BEGIN");
      try {
        const results = items.map((s) => ({ results: s._all() }));
        sql.exec("COMMIT");
        return results;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
export const instance = (i = 1) => ({
  event_id: "event_" + i,
  summary: "Synthetic " + i,
  status: "confirmed",
  start_time: { timestamp: String(1791190800 + i * 60) },
  end_time: { timestamp: String(1791194400 + i * 60) },
});
export function mock() {
  const calls = [];
  const hooks = {};
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    if (hooks.before) await hooks.before(url, init);
    if (url === "https://open.feishu.cn/open-apis/authen/v2/oauth/token") {
      assert.equal(init.method, "POST");
      assert.equal(
        init.headers["Content-Type"],
        "application/json; charset=utf-8",
      );
      assert(!init.headers.Authorization);
      const params = new URLSearchParams(JSON.parse(init.body));
      assert.equal(params.get("client_id"), "synthetic-app");
      assert.equal(params.get("client_secret"), "synthetic-app-secret");
      assert(
        ["authorization_code", "refresh_token"].includes(
          params.get("grant_type"),
        ),
      );
      if (hooks.token) return hooks.token(url, init);
      return Response.json({
        access_token: "synthetic-user-token",
        refresh_token: "synthetic-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
        scope: SCOPES.join(" "),
      });
    }
    if (url === "https://open.feishu.cn/open-apis/authen/v1/user_info") {
      if (hooks.profile) return hooks.profile(url, init);
      return Response.json({
        code: 0,
        data: {
          open_id: "ou_synthetic",
          tenant_key: "synthetic-tenant",
          name: "Synthetic Account",
          email: "not-stored@example.test",
        },
      });
    }
    if (
      url.startsWith("https://open.feishu.cn/open-apis/calendar/v4/calendars?")
    ) {
      if (hooks.calendars) return hooks.calendars(url, init);
      return Response.json({
        code: 0,
        data: { calendar_list: [{ calendar_id: "cal1" }], has_more: false },
      });
    }
    if (url.includes("/events/instance_view?")) {
      if (hooks.instances) return hooks.instances(url, init);
      return Response.json({
        code: 0,
        data: { items: [instance(1), instance(2), instance(3)] },
      });
    }
    throw Error("Unexpected synthetic request");
  };
  return { calls, hooks, fetcher };
}
export function request(path, options = {}) {
  const { user = P.user, method = "GET", body, form, headers = {} } = options;
  return new Request(P.site + path, {
    method,
    headers: {
      ...(user ? { "oai-authenticated-user-id": user } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(form !== undefined
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
      ...headers,
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
export async function setup() {
  let now = Date.now();
  const db = database(() => now),
    mocked = mock();
  const env = {
    DB: db,
    APP_ORIGIN: P.site,
    APP_ENCRYPTION_KEY: random(),
    FEISHU_APP_ID: "synthetic-app",
    FEISHU_APP_SECRET: "synthetic-app-secret",
    FEISHU_READ_ENABLED: "true",
  };
  const worker = createWorker({ fetcher: mocked.fetcher, now: () => now });
  const store = new Store(db),
    vault = new Vault(env.APP_ENCRYPTION_KEY),
    api = new Feishu(env, mocked.fetcher, () => now),
    link = new Linking(env, store, vault, api, () => now);
  const send = (path, options) => worker.fetch(request(path, options), env);
  const status = async (user = P.user) =>
    (await send("/api/status", { user })).json();
  async function begin(user = P.user, documents = false) {
    const current = await status(user);
    const r = await send(
      documents ? "/api/feishu/connect-documents" : "/api/feishu/connect",
      {
        method: "POST",
        user,
        form: { csrf: current.csrf },
        headers: { Origin: P.site },
      },
    );
    assert.equal(r.status, 303, await r.clone().text());
    return {
      response: r,
      url: new URL(r.headers.get("location")),
      cookie: r.headers.get("set-cookie").split(";")[0],
      user,
    };
  }
  async function callback(flow, overrides = {}) {
    return send(
      "/api/feishu/callback?" +
        new URLSearchParams({
          state: flow.url.searchParams.get("state"),
          code: "synthetic-code",
          ...overrides,
        }),
      { user: flow.user, headers: { Cookie: flow.cookie } },
    );
  }
  async function grant(user = P.user) {
    const flow = await begin(user);
    const response = await callback(flow);
    if (response.status !== 303)
      throw Error(JSON.stringify(await response.json()));
    return store.get({ ...P, user });
  }
  const tool = async (args = ARGS, user = P.user, name = "get_agenda") =>
    (
      await send("/mcp", {
        method: "POST",
        user,
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        },
      })
    ).json();
  const disconnect = async (snap, user = P.user) =>
    send("/api/feishu/disconnect", {
      method: "POST",
      user,
      body: { csrf: snap.csrf, epoch: snap.epoch, grant_id: snap.grant_id },
      headers: { Origin: P.site },
    });
  return {
    db,
    env,
    worker,
    store,
    vault,
    api,
    link,
    mocked,
    send,
    status,
    begin,
    callback,
    grant,
    tool,
    disconnect,
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}
