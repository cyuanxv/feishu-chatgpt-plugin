// Pure synthetic prototype. No HTTP client, credentials, routes, grants or token sink.
export const LIVE_DEVICE_FLOW_AVAILABLE = false;
const VERIFY = "https://verify.example.test/device";
const GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const safeErrors = new Set([
  "invalid_provider_response",
  "scope_mismatch",
  "binding_changed",
  "invalid_binding",
  "invalid_clock",
  "clock_regressed",
  "local_authorization_timeout",
]);
const safeFailure = (error) =>
  error instanceof DeviceFlowError && safeErrors.has(error.code)
    ? error.code
    : "provider_network_error";
const terminal = new Set([
  "completed",
  "cancelled",
  "expired",
  "denied",
  "failed",
]);
export class DeviceFlowError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const check = (value, code = "invalid_provider_response") => {
  if (!value) throw new DeviceFlowError(code);
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (v, low, high) =>
  Number.isSafeInteger(v) && v >= low && v <= high;
const text = (v, min, max) =>
  typeof v === "string" &&
  v.length >= min &&
  v.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v);
function keys(value, allowed) {
  check(object(value) && Object.keys(value).every((k) => allowed.includes(k)));
}
function scopeSet(scopes) {
  check(
    Array.isArray(scopes) &&
      scopes.length >= 1 &&
      scopes.length <= 30 &&
      scopes.every(
        (s) => typeof s === "string" && /^[A-Za-z0-9:._-]{1,100}$/.test(s),
      ),
    "invalid_binding",
  );
  return [...new Set(scopes)].sort();
}
function bindingKey(binding) {
  check(object(binding), "invalid_binding");
  check(
    text(binding.owner, 1, 128) &&
      text(binding.epoch, 1, 128) &&
      /^synthetic-[A-Za-z0-9_-]{1,100}$/.test(binding.app),
    "invalid_binding",
  );
  let url;
  try {
    url = new URL(binding.site);
  } catch {
    throw new DeviceFlowError("invalid_binding");
  }
  check(
    url.origin === binding.site &&
      url.protocol === "https:" &&
      url.hostname.endsWith(".example.test"),
    "invalid_binding",
  );
  return JSON.stringify({
    owner: binding.owner,
    site: binding.site,
    app: binding.app,
    scopes: scopeSet(binding.scopes),
    epoch: binding.epoch,
  });
}
function initiation(response, requestedAt) {
  keys(response, ["status", "body"]);
  check(response.status === 200);
  const b = response.body;
  keys(b, [
    "device_code",
    "user_code",
    "verification_uri",
    "verification_uri_complete",
    "expires_in",
    "interval",
  ]);
  check(
    typeof b.device_code === "string" &&
      /^synthetic-device-[A-Za-z0-9_-]{1,128}$/.test(b.device_code),
  );
  check(
    typeof b.user_code === "string" && /^[A-Z0-9-]{4,20}$/.test(b.user_code),
  );
  check(b.verification_uri === VERIFY && integer(b.expires_in, 1, 900));
  check(b.interval === undefined || integer(b.interval, 1, 60));
  if (b.verification_uri_complete !== undefined) {
    let u;
    try {
      u = new URL(b.verification_uri_complete);
    } catch {
      throw new DeviceFlowError("invalid_provider_response");
    }
    check(
      u.origin + u.pathname === VERIFY &&
        !u.hash &&
        !u.username &&
        !u.password &&
        [...u.searchParams.keys()].length === 1 &&
        u.searchParams.get("user_code") === b.user_code,
    );
  }
  const expiresAt = requestedAt + b.expires_in * 1000;
  check(Number.isSafeInteger(expiresAt));
  return {
    deviceCode: b.device_code,
    userCode: b.user_code,
    verificationUri: VERIFY,
    expiresAt,
    intervalMs: (b.interval ?? 5) * 1000,
  };
}
function tokenResult(response, requestedScopes) {
  keys(response, ["status", "body"]);
  const b = response.body;
  check(object(b));
  // Error envelope wins even when it also contains token-looking fields.
  if (Object.hasOwn(b, "error")) {
    check(response.status === 400);
    keys(b, ["error", "error_description", "error_uri"]);
    check(text(b.error, 1, 100));
    check(
      b.error_description === undefined ||
        (typeof b.error_description === "string" &&
          b.error_description.length <= 4096),
    );
    check(
      b.error_uri === undefined ||
        (typeof b.error_uri === "string" && b.error_uri.length <= 2048),
    );
    return [
      "authorization_pending",
      "slow_down",
      "access_denied",
      "expired_token",
    ].includes(b.error)
      ? b.error
      : "provider_rejected";
  }
  check(response.status === 200);
  keys(b, [
    "access_token",
    "refresh_token",
    "token_type",
    "expires_in",
    "refresh_token_expires_in",
    "scope",
    "code",
  ]);
  check(b.code === undefined || b.code === 0);
  check(
    typeof b.access_token === "string" &&
      /^synthetic-access-[A-Za-z0-9_-]{1,128}$/.test(b.access_token),
  );
  check(
    typeof b.refresh_token === "string" &&
      /^synthetic-refresh-[A-Za-z0-9_-]{1,128}$/.test(b.refresh_token),
  );
  check(
    typeof b.token_type === "string" && b.token_type.toLowerCase() === "bearer",
  );
  check(
    integer(b.expires_in, 1, 31536000) &&
      integer(b.refresh_token_expires_in, 1, 31536000),
  );
  check(typeof b.scope === "string" && b.scope.length <= 4096);
  check(
    JSON.stringify(scopeSet(b.scope.split(" "))) ===
      JSON.stringify(requestedScopes),
    "scope_mismatch",
  );
  return "success"; // Tokens intentionally discarded; never become a connection.
}
export class MemoryCASStore {
  #rows = new Map();
  #observed = new Map();
  create(row) {
    if (this.#rows.has(row.id)) return false;
    this.#rows.set(row.id, structuredClone(row));
    this.#observed.set(row.id, row.observedAt);
    return true;
  }
  get(id) {
    const row = this.#rows.get(id);
    return row ? structuredClone(row) : null;
  }
  observeTime(id, now) {
    const last = this.#observed.get(id);
    check(last !== undefined && now >= last, "clock_regressed");
    this.#observed.set(id, now);
  }
  compareAndSwap(id, version, next) {
    const row = this.#rows.get(id);
    if (!row || row.version !== version) return false;
    this.#rows.set(id, structuredClone({ ...next, id, version: version + 1 }));
    return true;
  }
}
export class SyntheticDeviceFlow {
  constructor({
    mode,
    store,
    provider,
    currentBinding,
    clock = Date.now,
    timers = globalThis,
  }) {
    check(mode === "synthetic", "live_device_flow_unavailable");
    check(
      provider &&
        typeof provider.authorize === "function" &&
        typeof provider.poll === "function",
      "synthetic_provider_required",
    );
    this.store = store;
    this.provider = provider;
    this.currentBinding = currentBinding;
    this.clock = clock;
    this.timers = timers;
  }
  #now(row) {
    const now = this.clock();
    check(Number.isSafeInteger(now) && now >= 0, "invalid_clock");
    if (row) this.store.observeTime(row.id, now);
    return now;
  }
  async #authorize(request, binding, key) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = this.timers.setTimeout(
        () => reject(new DeviceFlowError("local_authorization_timeout")),
        30000,
      );
    });
    try {
      return await Promise.race([
        Promise.resolve().then(async () => {
          const response = await this.provider.authorize(request);
          check((await this.#bound(binding)) === key, "binding_changed");
          return response;
        }),
        timeout,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }
  async #bound(binding) {
    const key = bindingKey(binding);
    check(
      bindingKey(await this.currentBinding(binding.owner, binding.site)) ===
        key,
      "binding_changed",
    );
    return key;
  }
  #finish(row, status, error = null) {
    return {
      ...row,
      status,
      error,
      deviceCode: null,
      userCode: null,
      verificationUri: null,
      lease: null,
    };
  }
  #view(row) {
    return {
      id: row.id,
      status: row.status,
      expires_at: row.expiresAt,
      next_poll_at: row.nextPollAt,
      interval_ms: row.intervalMs,
      error: row.error,
      live_available: false,
      ...(row.status === "pending"
        ? { verification_uri: row.verificationUri, user_code: row.userCode }
        : {}),
      ...(row.status === "completed"
        ? { synthetic_tokens_discarded: true }
        : {}),
    };
  }
  #expire(row) {
    const now = this.#now(row);
    if (
      !terminal.has(row.status) &&
      row.expiresAt !== null &&
      now >= row.expiresAt
    ) {
      this.store.compareAndSwap(
        row.id,
        row.version,
        this.#finish(
          row,
          row.status === "starting" ? "failed" : "expired",
          row.status === "starting"
            ? "local_authorization_timeout"
            : "expired_token",
        ),
      );
      return this.store.get(row.id);
    }
    return row;
  }
  async start(id, binding) {
    check(
      /^synthetic-session-[A-Za-z0-9_-]{1,64}$/.test(id),
      "invalid_session_id",
    );
    const key = await this.#bound(binding),
      frozen = JSON.parse(key),
      now = this.#now();
    const row = {
      id,
      version: 1,
      binding: key,
      status: "starting",
      createdAt: now,
      observedAt: now,
      expiresAt: now + 30000,
      nextPollAt: null,
      intervalMs: null,
      deviceCode: null,
      userCode: null,
      verificationUri: null,
      lease: null,
      attempts: 0,
      error: null,
    };
    check(this.store.create(row), "session_exists");
    try {
      const raw = await this.#authorize(
        {
          client_id: frozen.app,
          scope: frozen.scopes.join(" "),
        },
        frozen,
        key,
      );
      const fields = initiation(raw, now);
      const received = this.#now(row);
      check(received < row.expiresAt, "local_authorization_timeout");
      const next =
        received >= fields.expiresAt
          ? this.#finish({ ...row, ...fields }, "expired", "expired_token")
          : {
              ...row,
              ...fields,
              status: "pending",
              observedAt: received,
              nextPollAt: received + fields.intervalMs,
            };
      this.store.compareAndSwap(id, row.version, next);
    } catch (e) {
      this.store.compareAndSwap(
        id,
        row.version,
        this.#finish(row, "failed", safeFailure(e)),
      );
    }
    return this.#view(this.store.get(id));
  }
  async view(id, binding) {
    const key = await this.#bound(binding);
    const row = this.store.get(id);
    check(row && row.binding === key, "binding_mismatch");
    return this.#view(this.#expire(row));
  }
  async cancel(id, binding) {
    const key = await this.#bound(binding);
    let row = this.store.get(id);
    check(row && row.binding === key, "binding_mismatch");
    row = this.#expire(row);
    if (!terminal.has(row.status))
      this.store.compareAndSwap(
        id,
        row.version,
        this.#finish(row, "cancelled", "cancelled"),
      );
    return this.#view(this.store.get(id));
  }
  async pollOnce(id, binding) {
    const key = await this.#bound(binding);
    let row = this.store.get(id);
    check(row && row.binding === key, "binding_mismatch");
    row = this.#expire(row);
    if (
      terminal.has(row.status) ||
      row.status === "polling" ||
      row.status === "starting"
    )
      return this.#view(row);
    const now = this.#now(row);
    if (now < row.nextPollAt) return this.#view(row);
    if (row.attempts >= 120) {
      this.store.compareAndSwap(
        id,
        row.version,
        this.#finish(row, "failed", "poll_budget_exceeded"),
      );
      return this.#view(this.store.get(id));
    }
    const claim = {
      ...row,
      status: "polling",
      observedAt: now,
      lease: row.version + 1,
      attempts: row.attempts + 1,
    };
    if (!this.store.compareAndSwap(id, row.version, claim))
      return this.#view(this.store.get(id));
    const claimed = this.store.get(id),
      frozen = JSON.parse(key);
    try {
      const raw = await this.provider.poll({
        grant_type: GRANT,
        device_code: claimed.deviceCode,
        client_id: frozen.app,
      });
      const outcome = tokenResult(raw, frozen.scopes);
      check((await this.#bound(frozen)) === key, "binding_changed");
      const received = this.#now(claimed);
      let next;
      if (received >= claimed.expiresAt)
        next = this.#finish(claimed, "expired", "expired_token");
      else if (outcome === "success") next = this.#finish(claimed, "completed");
      else if (outcome === "authorization_pending" || outcome === "slow_down") {
        const intervalMs =
          claimed.intervalMs + (outcome === "slow_down" ? 5000 : 0);
        next = {
          ...claimed,
          status: "pending",
          lease: null,
          intervalMs,
          nextPollAt: received + intervalMs,
          observedAt: received,
        };
      } else
        next = this.#finish(
          claimed,
          outcome === "access_denied"
            ? "denied"
            : outcome === "expired_token"
              ? "expired"
              : "failed",
          outcome,
        );
      this.store.compareAndSwap(id, claimed.version, next);
    } catch (e) {
      this.store.compareAndSwap(
        id,
        claimed.version,
        this.#finish(claimed, "failed", safeFailure(e)),
      );
    }
    return this.#view(this.store.get(id));
  }
}
