import test from "node:test";
import assert from "node:assert/strict";
import {
  SyntheticDeviceFlow,
  MemoryCASStore,
  DeviceFlowError,
  LIVE_DEVICE_FLOW_AVAILABLE,
} from "./device-flow.mjs";
const id = "synthetic-session-one";
const startResponse = () => ({
  status: 200,
  body: {
    device_code: "synthetic-device-one",
    user_code: "ABCD-EFGH",
    verification_uri: "https://verify.example.test/device",
    expires_in: 120,
    interval: 5,
  },
});
const success = () => ({
  status: 200,
  body: {
    access_token: "synthetic-access-one",
    refresh_token: "synthetic-refresh-one",
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token_expires_in: 86400,
    scope: "read offline_access",
  },
});
const error = (code) => ({
  status: 400,
  body: {
    error: code,
    error_description: "SENSITIVE raw error",
    error_uri: "https://evil.invalid/SENSITIVE",
  },
});
const gate = () => {
  let release, enter;
  return {
    entered: new Promise((r) => (enter = r)),
    wait: new Promise((r) => (release = r)),
    get release() {
      return release;
    },
    get enter() {
      return enter;
    },
  };
};
function fixture() {
  let now = 100000,
    timerId = 0;
  const scheduled = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = ++timerId;
      scheduled.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      scheduled.delete(id);
    },
  };
  const move = (next) => {
    now = next;
    for (const [id, timer] of [...scheduled])
      if (now >= timer.at) {
        scheduled.delete(id);
        timer.fn();
      }
  };
  const binding = {
    owner: "owner1",
    site: "https://site.example.test",
    app: "synthetic-app",
    scopes: ["read", "offline_access"],
    epoch: "epoch1",
  };
  let current = structuredClone(binding),
    authorize = startResponse,
    poll = () => error("authorization_pending");
  const store = new MemoryCASStore(),
    calls = [];
  const options = {
    mode: "synthetic",
    store,
    clock: () => now,
    timers,
    currentBinding: async () => structuredClone(current),
    provider: {
      authorize: async (request) => {
        calls.push({ op: "authorize", request });
        return authorize(request);
      },
      poll: async (request) => {
        calls.push({ op: "poll", request });
        return poll(request);
      },
    },
  };
  const service = new SyntheticDeviceFlow(options);
  return {
    service,
    store,
    binding,
    calls,
    options,
    setNow: (n) => move(n),
    advance: (n) => move(now + n),
    setCurrent: (b) => (current = structuredClone(b)),
    setAuthorize: (f) => (authorize = f),
    setPoll: (f) => (poll = f),
  };
}
function noSecrets(value) {
  const s = JSON.stringify(value);
  for (const word of [
    "synthetic-device-",
    "synthetic-access-",
    "synthetic-refresh-",
    "SENSITIVE",
    "device_code",
    "access_token",
    "refresh_token",
  ])
    assert(!s.includes(word), word);
}
test("live mode is unavailable and synthetic prototype needs an injected provider", () => {
  assert.equal(LIVE_DEVICE_FLOW_AVAILABLE, false);
  assert.throws(() => new SyntheticDeviceFlow({ mode: "live" }), {
    code: "live_device_flow_unavailable",
  });
  assert.throws(() => new SyntheticDeviceFlow({ mode: "synthetic" }), {
    code: "synthetic_provider_required",
  });
});
test("strict initiation exposes only verification URI/user code; no secret in browser projection", async () => {
  const s = fixture(),
    view = await s.service.start(id, s.binding);
  assert.equal(view.status, "pending");
  assert.equal(view.expires_at, 220000);
  assert.equal(view.next_poll_at, 105000);
  noSecrets(view);
  assert.deepEqual(s.calls[0].request, {
    client_id: "synthetic-app",
    scope: "offline_access read",
  });
});
test("absolute deadline starts before authorize I/O and is not reset when controller resumes", async () => {
  const s = fixture();
  s.setAuthorize(() => {
    s.advance(20000);
    return startResponse();
  });
  const first = await s.service.start(id, s.binding);
  assert.equal(first.expires_at, 220000);
  const resumed = new SyntheticDeviceFlow(s.options);
  s.setNow(219999);
  const last = await resumed.pollOnce(id, s.binding);
  assert.equal(last.expires_at, 220000);
  s.setNow(220000);
  assert.equal((await resumed.pollOnce(id, s.binding)).status, "expired");
});
test("delayed initiation past original deadline becomes expired without a verification handoff", async () => {
  const s = fixture();
  s.setAuthorize(() => {
    s.advance(2000);
    const response = startResponse();
    response.body.expires_in = 1;
    return response;
  });
  const view = await s.service.start(id, s.binding);
  assert.equal(view.status, "expired");
  assert(!("user_code" in view));
  noSecrets(view);
});
test("omitted interval defaults to five seconds, but invalid expiry or interval is rejected", async () => {
  const s = fixture();
  s.setAuthorize(() => {
    const r = startResponse();
    delete r.body.interval;
    return r;
  });
  assert.equal((await s.service.start(id, s.binding)).interval_ms, 5000);
  for (const patch of [
    { expires_in: 0 },
    { expires_in: 1.5 },
    { expires_in: 901 },
    { expires_in: "120" },
    { interval: 0 },
    { interval: -1 },
    { interval: 61 },
    { interval: "5" },
    { device_code: "" },
  ]) {
    const f = fixture();
    f.setAuthorize(() => ({
      status: 200,
      body: { ...startResponse().body, ...patch },
    }));
    assert.equal(
      (await f.service.start(id, f.binding)).error,
      "invalid_provider_response",
    );
  }
});
test("malicious verification URLs and device-code-bearing complete links are rejected", async () => {
  for (const patch of [
    { verification_uri: "https://evil.invalid/device" },
    { verification_uri: "http://verify.example.test/device" },
    {
      verification_uri_complete:
        "https://verify.example.test/device?device_code=synthetic-device-one",
    },
    {
      verification_uri_complete:
        "https://verify.example.test/device?user_code=ABCD-EFGH&user_code=ABCD-EFGH",
    },
  ]) {
    const s = fixture();
    s.setAuthorize(() => ({
      status: 200,
      body: { ...startResponse().body, ...patch },
    }));
    const view = await s.service.start(id, s.binding);
    assert.equal(view.status, "failed");
    noSecrets(view);
  }
});
test("valid complete URL is validated but not surfaced", async () => {
  const s = fixture();
  s.setAuthorize(() => ({
    status: 200,
    body: {
      ...startResponse().body,
      verification_uri_complete:
        "https://verify.example.test/device?user_code=ABCD-EFGH",
    },
  }));
  const view = await s.service.start(id, s.binding);
  assert.equal(view.status, "pending");
  assert(!("verification_uri_complete" in view));
});
test("interval gates requests and slow_down permanently adds five seconds without extending expiry", async () => {
  const s = fixture();
  await s.service.start(id, s.binding);
  await s.service.pollOnce(id, s.binding);
  assert.equal(s.calls.length, 1);
  s.setPoll(() => error("slow_down"));
  s.advance(5000);
  const first = await s.service.pollOnce(id, s.binding);
  assert.equal(first.interval_ms, 10000);
  assert.equal(first.next_poll_at, 115000);
  assert.equal(first.expires_at, 220000);
  s.advance(9999);
  await s.service.pollOnce(id, s.binding);
  assert.equal(s.calls.length, 2);
  s.advance(1);
  const second = await s.service.pollOnce(id, s.binding);
  assert.equal(second.interval_ms, 15000);
  assert.equal(second.expires_at, 220000);
  s.setPoll(() => error("authorization_pending"));
  s.advance(15000);
  const third = await s.service.pollOnce(id, s.binding);
  assert.equal(third.interval_ms, 15000);
  noSecrets(third);
});
test("poll requests contain only fixed device grant fields and synthetic identifiers", async () => {
  const s = fixture();
  await s.service.start(id, s.binding);
  s.advance(5000);
  await s.service.pollOnce(id, s.binding);
  assert.deepEqual(s.calls[1].request, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: "synthetic-device-one",
    client_id: "synthetic-app",
  });
});
test("concurrent callers acquire only one CAS poll claim", async () => {
  const s = fixture(),
    g = gate();
  await s.service.start(id, s.binding);
  s.advance(5000);
  s.setPoll(async () => {
    g.enter();
    await g.wait;
    return error("authorization_pending");
  });
  const pending = s.service.pollOnce(id, s.binding);
  await g.entered;
  const other = await s.service.pollOnce(id, s.binding);
  assert.equal(other.status, "polling");
  assert.equal(s.calls.length, 2);
  g.release();
  assert.equal((await pending).status, "pending");
});
test("cancel during poll discards a late valid success and clears device code", async () => {
  const s = fixture(),
    g = gate();
  await s.service.start(id, s.binding);
  s.advance(5000);
  s.setPoll(async () => {
    g.enter();
    await g.wait;
    return success();
  });
  const pending = s.service.pollOnce(id, s.binding);
  await g.entered;
  assert.equal((await s.service.cancel(id, s.binding)).status, "cancelled");
  g.release();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  noSecrets(result);
  assert.equal(s.store.get(id).deviceCode, null);
  assert(!JSON.stringify(s.store.get(id)).includes("synthetic-access-"));
});
test("cancel during initiation cannot be undone by late provider response", async () => {
  const s = fixture(),
    g = gate();
  s.setAuthorize(async () => {
    g.enter();
    await g.wait;
    return startResponse();
  });
  const pending = s.service.start(id, s.binding);
  await g.entered;
  await s.service.cancel(id, s.binding);
  g.release();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  noSecrets(result);
  assert.equal(s.store.get(id).deviceCode, null);
});
test("late success after absolute expiry is never accepted", async () => {
  const s = fixture();
  await s.service.start(id, s.binding);
  s.advance(5000);
  s.setPoll(() => {
    s.setNow(220000);
    return success();
  });
  const result = await s.service.pollOnce(id, s.binding);
  assert.equal(result.status, "expired");
  noSecrets(result);
  assert.equal(s.store.get(id).deviceCode, null);
});
for (const field of ["owner", "site", "app", "scopes", "epoch"])
  test(
    "binding change in " + field + " blocks pending completion",
    async () => {
      const s = fixture();
      await s.service.start(id, s.binding);
      s.advance(5000);
      s.setPoll(() => {
        const next = {
          ...s.binding,
          [field]:
            field === "scopes"
              ? ["read"]
              : field === "site"
                ? "https://other.example.test"
                : field === "app"
                  ? "synthetic-other"
                  : "other",
        };
        s.setCurrent(next);
        return success();
      });
      const result = await s.service.pollOnce(id, s.binding);
      assert.equal(result.status, "failed");
      assert.equal(result.error, "binding_changed");
      noSecrets(result);
    },
  );
test("mutation of caller binding object cannot rebind an already-started session", async () => {
  const s = fixture(),
    g = gate();
  s.setAuthorize(async () => {
    g.enter();
    await g.wait;
    return startResponse();
  });
  const pending = s.service.start(id, s.binding);
  await g.entered;
  s.binding.epoch = "epoch2";
  s.setCurrent(s.binding);
  g.release();
  assert.equal((await pending).error, "binding_changed");
});
test("cross-owner requests cannot read or cancel another session", async () => {
  const s = fixture();
  await s.service.start(id, s.binding);
  const other = { ...s.binding, owner: "owner2" };
  s.setCurrent(other);
  await assert.rejects(s.service.view(id, other), { code: "binding_mismatch" });
  await assert.rejects(s.service.cancel(id, other), {
    code: "binding_mismatch",
  });
  assert.equal(s.store.get(id).status, "pending");
});
test("success validates exact scopes and Bearer type then discards all tokens instead of creating a grant", async () => {
  const s = fixture();
  await s.service.start(id, s.binding);
  s.advance(5000);
  s.setPoll(success);
  const result = await s.service.pollOnce(id, s.binding);
  assert.equal(result.status, "completed");
  assert.equal(result.synthetic_tokens_discarded, true);
  noSecrets(result);
  noSecrets(s.store.get(id));
});
test("malformed, over-scoped, non-Bearer, and ambiguous token envelopes fail closed", async () => {
  for (const response of [
    { status: 200, body: { ...success().body, error: "invalid_grant" } },
    { status: 201, body: success().body },
    { status: 200, body: { ...success().body, code: 20049 } },
    {
      status: 200,
      body: { ...success().body, scope: "read offline_access write" },
    },
    { status: 200, body: { ...success().body, token_type: "DPoP" } },
    { status: 200, body: { ...success().body, expires_in: "3600" } },
    { status: 200, body: [] },
  ]) {
    const s = fixture();
    await s.service.start(id, s.binding);
    s.advance(5000);
    s.setPoll(() => response);
    const result = await s.service.pollOnce(id, s.binding);
    assert.equal(result.status, "failed");
    noSecrets(result);
  }
});
for (const [code, status] of [
  ["access_denied", "denied"],
  ["expired_token", "expired"],
  ["SENSITIVE_error", "failed"],
])
  test("terminal error " + status + " drops provider prose", async () => {
    const s = fixture();
    await s.service.start(id, s.binding);
    s.advance(5000);
    s.setPoll(() => error(code));
    const result = await s.service.pollOnce(id, s.binding);
    assert.equal(result.status, status);
    noSecrets(result);
    await s.service.pollOnce(id, s.binding);
    assert.equal(s.calls.length, 2);
  });
test("exceptions never echo provider text, even a thrown exported error class", async () => {
  const s = fixture();
  await s.service.start(id, s.binding);
  s.advance(5000);
  s.setPoll(() => {
    throw new DeviceFlowError("SENSITIVE_secret");
  });
  const result = await s.service.pollOnce(id, s.binding);
  assert.equal(result.error, "provider_network_error");
  noSecrets(result);
  await s.service.pollOnce(id, s.binding);
  assert.equal(s.calls.length, 2);
});
test("clock rollback fails closed and resuming cannot reset expiry", async () => {
  const s = fixture();
  await s.service.start(id, s.binding);
  s.setNow(99999);
  await assert.rejects(s.service.pollOnce(id, s.binding), {
    code: "clock_regressed",
  });
});
test("a later view observation prevents rollback polling even after a controller resumes", async () => {
  const s = fixture();
  await s.service.start(id, s.binding);
  s.setNow(219000);
  await s.service.view(id, s.binding);
  s.setNow(110000);
  const resumed = new SyntheticDeviceFlow(s.options);
  await assert.rejects(resumed.pollOnce(id, s.binding), {
    code: "clock_regressed",
  });
  assert.equal(s.calls.length, 1);
});
test("too-early poll observations also advance the shared monotonic clock high-water mark", async () => {
  const s = fixture();
  await s.service.start(id, s.binding);
  s.setNow(104000);
  await s.service.pollOnce(id, s.binding);
  s.setNow(103000);
  await assert.rejects(s.service.view(id, s.binding), {
    code: "clock_regressed",
  });
  assert.equal(s.calls.length, 1);
});
for (const rollback of [false, true])
  test(
    "view during claimed poll preserves CAS lease; rollback=" + rollback,
    async () => {
      const s = fixture(),
        g = gate();
      await s.service.start(id, s.binding);
      s.advance(5000);
      s.setPoll(async () => {
        g.enter();
        await g.wait;
        return success();
      });
      const pending = s.service.pollOnce(id, s.binding);
      await g.entered;
      s.setNow(110000);
      await s.service.view(id, s.binding);
      if (rollback) s.setNow(106000);
      g.release();
      const result = await pending;
      assert.equal(result.status, rollback ? "failed" : "completed");
      if (rollback) assert.equal(result.error, "clock_regressed");
      noSecrets(result);
    },
  );
test("never-resolving authorize reaches local timeout without staying starting or revoking remotely", async () => {
  const s = fixture(),
    g = gate();
  s.setAuthorize(() => {
    g.enter();
    return new Promise(() => {});
  });
  const pending = s.service.start(id, s.binding);
  await g.entered;
  s.advance(30000);
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.error, "local_authorization_timeout");
  assert.equal(s.calls.length, 1);
  noSecrets(result);
  assert.equal(s.store.get(id).deviceCode, null);
});
test("cancelled never-resolving authorize remains cancelled at its bounded local timeout", async () => {
  const s = fixture(),
    g = gate();
  s.setAuthorize(() => {
    g.enter();
    return new Promise(() => {});
  });
  const pending = s.service.start(id, s.binding);
  await g.entered;
  assert.equal((await s.service.cancel(id, s.binding)).status, "cancelled");
  s.advance(30000);
  assert.equal((await pending).status, "cancelled");
  assert.equal(s.calls.length, 1);
});
test("late authorize completion after local timeout cannot reopen the session", async () => {
  const s = fixture(),
    g = gate();
  s.setAuthorize(async () => {
    g.enter();
    await g.wait;
    return startResponse();
  });
  const pending = s.service.start(id, s.binding);
  await g.entered;
  s.advance(30000);
  assert.equal((await pending).status, "failed");
  g.release();
  await Promise.resolve();
  assert.equal((await s.service.view(id, s.binding)).status, "failed");
  noSecrets(s.store.get(id));
});
test("response receipt enforces local authorization deadline even if timer callback is delayed", async () => {
  const s = fixture();
  const service = new SyntheticDeviceFlow({
    ...s.options,
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  s.setAuthorize(() => {
    s.advance(30000);
    return startResponse();
  });
  const result = await service.start(id, s.binding);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "local_authorization_timeout");
  noSecrets(result);
});
test("post-provider binding check shares the original deadline even when timer callback is delayed", async () => {
  const s = fixture();
  let reads = 0;
  const service = new SyntheticDeviceFlow({
    ...s.options,
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    currentBinding: async () => {
      if (++reads === 2) s.advance(31000);
      return structuredClone(s.binding);
    },
  });
  const result = await service.start(id, s.binding);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "local_authorization_timeout");
  noSecrets(result);
});
test("post-provider binding resolver that never completes is bounded by local startup timer", async () => {
  const s = fixture(),
    g = gate();
  let reads = 0;
  const service = new SyntheticDeviceFlow({
    ...s.options,
    currentBinding: async () => {
      if (++reads === 2) {
        g.enter();
        return new Promise(() => {});
      }
      return structuredClone(s.binding);
    },
  });
  const pending = service.start(id, s.binding);
  await g.entered;
  s.advance(30000);
  const result = await pending;
  assert.equal(result.error, "local_authorization_timeout");
  assert.equal(result.status, "failed");
  assert.equal(s.calls.length, 1);
  noSecrets(result);
});
test("timer winning during binding validation prevents a late valid resolver from committing", async () => {
  const s = fixture(),
    g = gate();
  let reads = 0;
  const service = new SyntheticDeviceFlow({
    ...s.options,
    currentBinding: async () => {
      if (++reads === 2) {
        g.enter();
        await g.wait;
      }
      return structuredClone(s.binding);
    },
  });
  const pending = service.start(id, s.binding);
  await g.entered;
  s.advance(30000);
  assert.equal((await pending).status, "failed");
  g.release();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(s.store.get(id).status, "failed");
  noSecrets(s.store.get(id));
});
