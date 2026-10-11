import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { readdir, readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Store, SCOPES, random } from "../.test-build/module.mjs";
const { Miniflare } = createRequire(import.meta.url)(
  "../runtime-check/node_modules/miniflare",
);
const DOC_SCOPES = ["search:docs:read", "docx:document:readonly"];
const allScopes = [...SCOPES, ...DOC_SCOPES];
const origin = "https://synthetic.example.test";
const key = random();
const bundle = await build({
  stdin: {
    contents: `
import './src/runtime.ts';
import {DocxCandidate,DocxCandidateProvider} from './src/docx-candidate.ts';
import {createDocxD1Access} from './src/docx-d1-access.ts';
import {Store} from './src/store.ts';
import {Linking} from './src/linking.ts';
import {Feishu,SCOPES} from './src/feishu.ts';
import {Vault,aad,random} from './src/security.ts';
export default {async fetch(request,env){
 const {op,user,args,scopes,expires}=await request.json();
 const p={site:'https://synthetic.example.test',user};
 const store=new Store(env.DB),vault=new Vault(env.APP_ENCRYPTION_KEY);
 const providerFetch=(url,init)=>fetch(url,init);
 const linking=new Linking(env,store,vault,new Feishu(env,providerFetch));
 try {
  if(op==='seed'){
   const now=Date.now(),epoch=await store.epoch(p),grant=random();
   const grantScopes=scopes??[...SCOPES,'search:docs:read','docx:document:readonly'];
   const tokens={access_token:'synthetic-access',refresh_token:'synthetic-refresh',access_expires:expires??now+3600000,refresh_expires:now+86400000,scopes:grantScopes};
   await store.save(p,{grant_id:grant,tenant_key:'synthetic-tenant',open_id:'synthetic-open',display_name:'Synthetic',credentials:await vault.seal(tokens,aad(p,'credentials',grant)),scopes:JSON.stringify(grantScopes),expires:tokens.access_expires,refresh_expires:tokens.refresh_expires,status:'active'},epoch);
   return Response.json({ok:true,grant});
  }
  const service=new DocxCandidate(new DocxCandidateProvider(providerFetch),createDocxD1Access(store,linking),vault);
  const data=op==='search'?await service.search(p,args):await service.fetch(p,args);
  return Response.json({ok:true,data});
 }catch(e){return Response.json({ok:false,error:e.code,status:e.status});}
}};`,
    resolveDir: process.cwd(),
    sourcefile: "docx-d1-workerd-fixture.ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
await mkdir(".runtime-test", { recursive: true });
const persistence = await mkdtemp(resolve(".runtime-test/docx-d1-"));
let refreshBarrier = null,
  refreshScopeOverride = null;
let barrier = null,
  providerCalls = 0,
  refreshCalls = 0,
  count = 0;
const mf = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-07-30",
  cf: false,
  d1Databases: { DB: "synthetic-docx-d1" },
  d1Persist: persistence,
  bindings: {
    APP_ORIGIN: origin,
    APP_ENCRYPTION_KEY: key,
    FEISHU_APP_ID: "synthetic-app",
    FEISHU_APP_SECRET: "synthetic-secret",
    FEISHU_DATA_MODE: "feishu",
    FEISHU_READ_ENABLED: "true",
  },
  outboundService: async (req) => {
    if (req.url === "https://open.feishu.cn/open-apis/authen/v2/oauth/token") {
      refreshCalls++;
      if (refreshBarrier) {
        const b = refreshBarrier;
        refreshBarrier = null;
        b.enter();
        await b.wait;
      }
      assert.equal(req.method, "POST");
      return Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh-next",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
        scope: (refreshScopeOverride ?? allScopes).join(" "),
      });
    }
    assert.equal(req.headers.get("authorization"), "Bearer synthetic-access");
    assert(
      req.url ===
        "https://open.feishu.cn/open-apis/search/v2/doc_wiki/search" ||
        req.url ===
          "https://open.feishu.cn/open-apis/docx/v1/documents/doc1/raw_content",
    );
    providerCalls++;
    if (barrier) {
      const pending = barrier;
      barrier = null;
      pending.enter();
      await pending.wait;
    }
    return Response.json({
      code: 0,
      data:
        req.method === "POST"
          ? {
              res_units: [
                {
                  entity_type: "DOC",
                  result_meta: { token: "doc1", doc_types: "DOCX" },
                  title_highlighted: "Synthetic",
                },
              ],
              has_more: false,
            }
          : { content: "Sensitive synthetic document text" },
    });
  },
});
const send = async (op, user, args = {}, extra = {}) =>
  (
    await mf.dispatchFetch(origin, {
      method: "POST",
      body: JSON.stringify({ op, user, args, ...extra }),
    })
  ).json();
const ok = (message) => {
  count++;
  console.log("PASS " + message);
};
const gate = () => {
  let enter, release;
  const entered = new Promise((r) => (enter = r)),
    wait = new Promise((r) => (release = r));
  barrier = { enter, wait };
  return { entered, release };
};
let db, store;
try {
  db = await mf.getD1Database("DB");
  store = new Store(db);
  for (const file of (await readdir("drizzle"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    for (const sql of (await readFile("drizzle/" + file, "utf8"))
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  const seed = async (user, extra = {}) => {
    const r = await send("seed", user, {}, extra);
    assert.equal(r.ok, true);
    return r;
  };
  const search = async (user) => {
    const r = await send("search", user, { query: "x" });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.data.results[0].result_id;
  };
  await seed("happy");
  const reference = await search("happy");
  const first = await send("fetch", "happy", {
    result_id: reference,
    max_chars: 5,
  });
  assert.equal(first.ok, true);
  assert(first.data.next_cursor);
  const next = await send("fetch", "happy", {
    result_id: reference,
    max_chars: 5,
    cursor: first.data.next_cursor,
  });
  assert.equal(next.ok, true);
  ok(
    "actual Store + Linking + D1 bridge returns search/fetch and continuation",
  );
  await seed("missing", { scopes: SCOPES, expires: Date.now() - 1 });
  const callsBefore = providerCalls,
    refreshBefore = refreshCalls;
  const missing = await send("search", "missing", { query: "x" });
  assert.equal(missing.error, "insufficient_scope");
  assert.equal(providerCalls, callsBefore);
  assert.equal(refreshCalls, refreshBefore);
  ok(
    "missing document scope is denied before provider access or token refresh",
  );
  await seed("docx-only", { scopes: DOC_SCOPES });
  const docxOnlyProviderBefore = providerCalls,
    docxOnlyRefreshBefore = refreshCalls;
  const docxOnly = await send("search", "docx-only", { query: "x" });
  assert.equal(docxOnly.error, "provider_scope_changed");
  assert.equal(providerCalls, docxOnlyProviderBefore);
  assert.equal(refreshCalls, docxOnlyRefreshBefore);
  ok(
    "DOCX-only grant is explicitly unsupported by existing calendar Linking; no silent scope expansion",
  );
  for (const operation of ["search", "fetch"])
    for (const change of [
      "disconnect",
      "replace",
      "scope-remove",
      "scope-add",
      "scope-aba",
    ]) {
      const user = operation + "-" + change,
        p = { site: origin, user };
      await seed(user);
      const result_id = operation === "fetch" ? await search(user) : null;
      const wait = gate();
      const pending = send(
        operation,
        user,
        operation === "fetch" ? { result_id } : { query: "x" },
      );
      await wait.entered;
      try {
        if (change === "disconnect") {
          const row = await store.current(p);
          await store.disconnect(p, row.grant_id, await store.epoch(p));
        } else if (change === "replace") await seed(user);
        else {
          const changed =
            change === "scope-remove"
              ? SCOPES
              : [...allScopes, "synthetic:extra"];
          await db
            .prepare(
              "UPDATE connections SET scopes=?,version=version+1 WHERE site=? AND user_id=?",
            )
            .bind(JSON.stringify(changed), origin, user)
            .run();
          if (change === "scope-aba")
            await db
              .prepare(
                "UPDATE connections SET scopes=?,version=version+1 WHERE site=? AND user_id=?",
              )
              .bind(JSON.stringify(allScopes), origin, user)
              .run();
        }
      } finally {
        wait.release();
      }
      const result = await pending;
      assert.equal(result.ok, false, JSON.stringify(result));
      assert(!JSON.stringify(result).includes("Sensitive"));
      assert(!("data" in result));
      if (change === "scope-aba" || change === "scope-add")
        assert.equal(result.error, "docx_state_changed_restart");
      ok(operation + " suppresses in-flight " + change + " with native D1");
    }
  await seed("rotate");
  const old = await search("rotate");
  const oldRow = await store.current({ site: origin, user: "rotate" });
  await db
    .prepare("UPDATE connections SET expires=? WHERE site=? AND user_id=?")
    .bind(Date.now() - 1, origin, "rotate")
    .run();
  const rotateBefore = refreshCalls;
  const stale = await send("fetch", "rotate", { result_id: old });
  assert.equal(refreshCalls, rotateBefore + 1);
  assert.equal(stale.error, "invalid_reference");
  assert.equal(stale.status, 400);
  const rotated = await store.current({ site: origin, user: "rotate" });
  assert.equal(rotated.grant_id, oldRow.grant_id);
  assert.equal(rotated.version, oldRow.version + 1);
  assert.equal(rotated.status, "active");
  const fresh = await search("rotate");
  assert.equal((await send("fetch", "rotate", { result_id: fresh })).ok, true);
  ok(
    "normal refresh rotates version, stale reference requires new search, same grant remains active",
  );
  refreshScopeOverride = SCOPES;
  await seed("shrink-refresh", { expires: Date.now() - 1 });
  const shrinkBefore = providerCalls;
  const shrink = await send("search", "shrink-refresh", { query: "x" });
  assert.equal(shrink.error, "connection_changed");
  assert.equal(providerCalls, shrinkBefore);
  assert.equal(
    (await store.current({ site: origin, user: "shrink-refresh" })).status,
    "active",
  );
  assert.equal(
    (await send("search", "shrink-refresh", { query: "x" })).error,
    "insufficient_scope",
  );
  refreshScopeOverride = null;
  ok(
    "refresh dropping DOCX scopes suppresses document access and does not invalidate active calendar grant",
  );
  function refreshGate() {
    let enter, release;
    const entered = new Promise((r) => (enter = r)),
      wait = new Promise((r) => (release = r));
    refreshBarrier = { enter, wait };
    return { entered, release };
  }
  for (const change of ["parallel", "disconnect", "replace"]) {
    const user = "refresh-race-" + change,
      p = { site: origin, user };
    await seed(user, { expires: Date.now() - 1 });
    const original = await store.current(p),
      g = refreshGate(),
      priorCalls = providerCalls;
    const pending = send("search", user, { query: "x" });
    await g.entered;
    if (change === "parallel") {
      const second = await send("search", user, { query: "x" });
      assert.equal(second.error, "refresh_in_progress_or_reconnect");
    } else if (change === "disconnect")
      await store.disconnect(p, original.grant_id, await store.epoch(p));
    else await seed(user);
    g.release();
    const result = await pending;
    if (change === "parallel") {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal((await store.current(p)).status, "active");
    } else {
      assert.equal(result.error, "connection_required");
      assert.equal(providerCalls, priorCalls);
      if (change === "replace") {
        const current = await store.current(p);
        assert.notEqual(current.grant_id, original.grant_id);
        assert.equal(current.status, "active");
      } else assert.equal(await store.get(p), null);
    }
    ok("refresh await race: " + change);
  }

  console.log(
    JSON.stringify({
      runtime: "official Miniflare/workerd + temporary native D1",
      passed: count,
      real_provider_requests: 0,
      synthetic_refresh_calls: refreshCalls,
      production_schema_changes: false,
    }),
  );
} finally {
  await mf.dispose();
  await rm(persistence, { recursive: true, force: true });
}
