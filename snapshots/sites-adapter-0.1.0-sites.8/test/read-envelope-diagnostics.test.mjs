import test from "node:test";
import assert from "node:assert/strict";
import { Feishu } from "../.test-build/module.mjs";
import { setup } from "./helpers.mjs";

async function recorded(run) {
  const original = console.warn,
    logs = [];
  console.warn = (line) => logs.push(JSON.parse(line));
  try {
    await run(logs);
  } finally {
    console.warn = original;
  }
}
const operations = [
  ["user_info", (api) => api.profile("SENSITIVE_access")],
  ["calendar_list", (api) => api.calendars("SENSITIVE_access")],
  [
    "calendar_instances",
    (api) => api.instances("SENSITIVE_access", "synthetic-calendar", 0, 1000),
  ],
];
for (const [operation, invoke] of operations) {
  test(`${operation}: HTTP 200 business failure retains only safe evidence, without retry`, () =>
    recorded(async (logs) => {
      const { env } = await setup();
      let calls = 0;
      const api = new Feishu(env, async () => {
        calls++;
        return Response.json(
          {
            code: 123456,
            msg: "SENSITIVE_message",
            access_token: "SENSITIVE_token",
            data: { name: "SENSITIVE_name" },
          },
          { headers: { "x-tt-logid": "synthetic_log_123" } },
        );
      });
      await assert.rejects(invoke(api), (error) => {
        assert.equal(error.code, "provider_invalid_response");
        assert.equal(error.status, 502);
        assert.equal(error.providerCode, 123456);
        assert.equal(error.providerLogId, "synthetic_log_123");
        assert(!JSON.stringify(error).includes("SENSITIVE"));
        return true;
      });
      assert.equal(calls, 1);
      assert.deepEqual(logs, [
        {
          event: "feishu_provider_failure",
          operation,
          kind: "invalid_response",
          http_status: 200,
          provider_log_id: "synthetic_log_123",
          provider_code: 123456,
        },
      ]);
    }));
}
test("malformed read envelopes reject with bounded diagnostics and invalid log IDs omitted", () =>
  recorded(async (logs) => {
    const { env } = await setup();
    for (const body of [
      null,
      [],
      "SENSITIVE_body",
      { code: 0, data: [] },
      { code: 0, data: null },
      { code: "SENSITIVE_code", data: {} },
    ]) {
      const api = new Feishu(env, async () =>
        Response.json(body, {
          headers: { "x-tt-logid": "https://sensitive.invalid/value" },
        }),
      );
      await assert.rejects(api.calendars("SENSITIVE_access"), {
        code: "provider_invalid_response",
        status: 502,
      });
    }
    assert.equal(logs.length, 6);
    assert(
      logs.every(
        (entry) =>
          entry.kind === "invalid_response" &&
          entry.provider_log_id === undefined,
      ),
    );
    assert(!JSON.stringify(logs).includes("SENSITIVE"));
    assert(!JSON.stringify(logs).includes("sensitive.invalid"));
  }));
test("valid read envelope remains successful without failure diagnostics", () =>
  recorded(async (logs) => {
    const { env } = await setup();
    const data = { calendar_list: [], has_more: false };
    const api = new Feishu(env, async () => Response.json({ code: 0, data }));
    assert.deepEqual(await api.calendars("SENSITIVE_access"), data);
    assert.deepEqual(logs, []);
  }));
test("read failure diagnostics validate provider codes and log identifiers", () =>
  recorded(async (logs) => {
    const { env } = await setup();
    for (const code of [
      -1,
      1.5,
      1000000000,
      "1234567890",
      "SENSITIVE_code",
      {},
      null,
    ]) {
      const api = new Feishu(env, async () =>
        Response.json(
          { code, msg: "SENSITIVE_message" },
          { headers: { "x-tt-logid": "a".repeat(129) } },
        ),
      );
      await assert.rejects(api.calendars("SENSITIVE_access"), (error) => {
        assert.equal(error.providerCode, undefined);
        assert.equal(error.providerLogId, undefined);
        return true;
      });
    }
    for (const value of [
      "short",
      "duplicate1, duplicate2",
      "bad log id",
      "<script>",
      "a".repeat(129),
    ]) {
      const api = new Feishu(env, async () =>
        Response.json({ code: "123456" }, { headers: { "x-tt-logid": value } }),
      );
      await assert.rejects(api.calendars("SENSITIVE_access"), (error) => {
        assert.equal(error.providerCode, 123456);
        assert.equal(error.providerLogId, undefined);
        return true;
      });
    }
    assert(!JSON.stringify(logs).includes("SENSITIVE"));
    assert(logs.every((entry) => entry.provider_log_id === undefined));
  }));
test("MCP failure receipt matches local correlation log and preserves the grant without retries", () =>
  recorded(async () => {
    const s = await setup();
    const grant = await s.grant();
    const before = s.mocked.calls.length;
    s.mocked.hooks.calendars = () =>
      Response.json(
        {
          code: 123456,
          msg: "SENSITIVE_message",
          data: { email: "SENSITIVE_email" },
        },
        { headers: { "x-tt-logid": "synthetic_log_123" } },
      );
    const original = console.info,
      info = [];
    console.info = (line) => info.push(JSON.parse(line));
    try {
      const response = await s.tool();
      assert.equal(response.result.isError, true);
      const receipt = response.result.structuredContent;
      assert.equal(receipt.error, "provider_invalid_response");
      assert.equal(receipt.provider_code, 123456);
      assert.equal(receipt.provider_log_id, "synthetic_log_123");
      assert.match(
        receipt.correlation_id,
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,
      );
      assert.deepEqual(info, [
        {
          event: "feishu_agenda_failure",
          error_code: receipt.error,
          correlation_id: receipt.correlation_id,
          provider_code: 123456,
          provider_log_id: "synthetic_log_123",
        },
      ]);
      assert(!JSON.stringify({ response, info }).includes("SENSITIVE"));
      assert.equal(s.mocked.calls.length, before + 1);
      assert.equal((await s.status()).grant_id, grant.grant_id);
    } finally {
      console.info = original;
    }
  }));
