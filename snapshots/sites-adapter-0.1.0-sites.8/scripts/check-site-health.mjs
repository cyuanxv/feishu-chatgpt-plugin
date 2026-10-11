import { pathToFileURL } from "node:url";

// No cookies, identity headers or Feishu API calls. Never follow redirects.
export async function checkSiteHealth(input, { fetcher = fetch, timeoutMs = 10000 } = {}) {
  let base;
  try {
    base = new URL(input);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw Error();
  } catch { return { ok: false, exit_code: 1, reason: "invalid_https_origin" }; }
  const request = (path) => fetcher(new URL(path, base), {
    method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json" },
  });
  try {
    const health = await request("/health");
    if ([301, 302, 303, 307, 308, 401, 403].includes(health.status))
      return { ok: false, exit_code: 2, reason: "health_authentication_required", transport_reachable: true, business_verified: false };
    if (health.status !== 200) return { ok: false, exit_code: 1, reason: "health_http_error", status: health.status };
    if (!(health.headers.get("content-type") ?? "").includes("application/json"))
      return { ok: false, exit_code: 1, reason: "health_not_json" };
    const body = await health.json();
    if (body.status !== "ok" || body.data_mode !== "feishu")
      return { ok: false, exit_code: 1, reason: "health_contract_mismatch" };
    const guard = await request("/api/apps");
    if (![401, 403, 301, 302, 303, 307, 308].includes(guard.status))
      return { ok: false, exit_code: 1, reason: "anonymous_guard_failed", status: guard.status };
    return { ok: true, exit_code: 0, reason: "health_and_anonymous_guard_passed", business_verified: false };
  } catch { return { ok: false, exit_code: 1, reason: "transport_or_response_error" }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkSiteHealth(process.env.FEISHU_SITE_ORIGIN);
  console.log(JSON.stringify({ checked_at: new Date().toISOString(), ...result }));
  process.exitCode = result.exit_code;
}
