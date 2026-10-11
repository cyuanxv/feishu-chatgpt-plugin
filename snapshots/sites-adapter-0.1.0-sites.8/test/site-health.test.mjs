import test from "node:test";
import assert from "node:assert/strict";
import { checkSiteHealth } from "../scripts/check-site-health.mjs";
const origin = "https://example.invalid";
const health = () => Response.json({ status: "ok", data_mode: "feishu" });
test("health probe checks anonymous protection without following redirects or passing credentials", async () => {
  const calls = [];
  const result = await checkSiteHealth(origin, { fetcher: async (url, init) => {
    calls.push(url.pathname); assert.equal(init.redirect, "manual");
    assert.deepEqual(Object.keys(init.headers), ["Accept"]);
    return url.pathname === "/health" ? health() : new Response(null, {status:401});
  }});
  assert.equal(result.exit_code, 0); assert.equal(result.business_verified, false);
  assert.deepEqual(calls, ["/health", "/api/apps"]);
});
test("private login redirect is inconclusive, never green", async () => {
  const result = await checkSiteHealth(origin, { fetcher: async () => new Response(null, {status:302, headers:{location:"https://login.invalid/secret"}}) });
  assert.equal(result.exit_code, 2); assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes("secret"), false);
});
test("anonymous data access fails even with healthy status", async () => {
  assert.equal((await checkSiteHealth(origin, {fetcher:async()=>health()})).reason, "anonymous_guard_failed");
});
test("synthetic mode and login HTML cannot pass production monitor", async () => {
  for (const response of [Response.json({status:"ok",data_mode:"synthetic"}),new Response("login",{headers:{"content-type":"text/html"}})])
    assert.equal((await checkSiteHealth(origin,{fetcher:async()=>response})).exit_code,1);
});
test("network and malformed payload errors produce redacted failures", async () => {
  for (const fetcher of [async()=>{throw Error("private-token")},async()=>new Response("private-token",{headers:{"content-type":"application/json"}})]) {
    const result=await checkSiteHealth(origin,{fetcher}); assert.equal(result.exit_code,1); assert.equal(JSON.stringify(result).includes("private-token"),false);
  }
});
test("reject insecure origins and embedded credentials before transport", async () => {
  for (const url of ["http://example.invalid","https://user:secret@example.invalid","https://example.invalid?token=secret","https://example.invalid/other",undefined])
    assert.equal((await checkSiteHealth(url,{fetcher:()=>{throw Error("must not request")}})).reason,"invalid_https_origin");
});
