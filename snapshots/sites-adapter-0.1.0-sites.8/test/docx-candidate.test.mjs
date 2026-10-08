import test from "node:test";
import assert from "node:assert/strict";
import {
  DocxCandidate,
  DocxCandidateProvider,
  Vault,
  random,
  AppError,
} from "../.test-build/module.mjs";
import { P, setup as agendaSetup } from "./helpers.mjs";
const scopes = ["search:docs:read", "docx:document:readonly"];
const hit = (token = "doc1", patch = {}) => ({
  entity_type: "DOC",
  result_meta: {
    token,
    doc_types: "DOCX",
    url: "https://evil.invalid/private",
  },
  title_highlighted: "<h>Synthetic</h>",
  summary_highlighted: "SYNTHETIC snippet",
  ...patch,
});
function setup() {
  const calls = [];
  let grant = "grant1",
    allowed = [...scopes],
    now = 100000,
    active = true;
  const hooks = {};
  const provider = new DocxCandidateProvider(async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.Authorization, "Bearer synthetic-access");
    if (hooks.transport) return hooks.transport(url, init);
    if (url.endsWith("/search/v2/doc_wiki/search"))
      return Response.json({
        code: 0,
        data: hooks.search ?? { res_units: [hit()], has_more: false },
      });
    return Response.json({
      code: 0,
      data: hooks.content ?? { content: "甲😀乙丙" },
    });
  });
  const vault = new Vault(random());
  const access = async (p, expected) => {
    if (!active) throw new AppError("authorization_required", 401);
    assert.deepEqual(p, P);
    if (expected && expected !== grant)
      throw new AppError("connection_changed", 401);
    return { grant, scopes: allowed, token: "synthetic-access" };
  };
  const service = new DocxCandidate(provider, access, vault, () => now);
  return {
    service,
    provider,
    vault,
    calls,
    hooks,
    access,
    changeGrant: () => (grant = "grant2"),
    changeScopes: (v) => (allowed = v),
    expire: () => (now += 600001),
    disconnect: () => (active = false),
  };
}
async function reference(s) {
  return (await s.service.search(P, { query: "synthetic" })).results[0]
    .result_id;
}
test("DOCX search sends fixed read endpoint/filter and emits opaque owner-bound references without provider URLs", async () => {
  const s = setup(),
    found = await s.service.search(P, { query: " synthetic " });
  assert.equal(
    s.calls[0].url,
    "https://open.feishu.cn/open-apis/search/v2/doc_wiki/search",
  );
  assert.equal(s.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(s.calls[0].init.body), {
    query: "synthetic",
    page_size: 5,
    doc_filter: { doc_types: ["DOCX"] },
  });
  assert.equal(found.results[0].title, "Synthetic");
  assert.equal(found.results[0].type, "docx");
  assert.equal(found.coverage, "docx_only");
  assert.equal(found.live_verified, false);
  assert.equal(found.next_cursor, null);
  assert(!JSON.stringify(found).includes("evil.invalid"));
  assert(!JSON.stringify(found).includes("synthetic-access"));
  assert(!found.results[0].result_id.includes("doc1"));
});
test("DOCX fetch pages Unicode codepoints, never splits astral characters, and terminates precisely", async () => {
  const s = setup(),
    result_id = await reference(s);
  const one = await s.service.fetch(P, { result_id, max_chars: 2 });
  assert.equal(one.content, "甲😀");
  assert.equal(one.truncated, true);
  assert.equal(one.offset_codepoints, 0);
  const two = await s.service.fetch(P, {
    result_id,
    max_chars: 2,
    cursor: one.next_cursor,
  });
  assert.equal(two.content, "乙丙");
  assert.equal(two.truncated, false);
  assert.equal(two.next_cursor, null);
  assert.equal(two.total_codepoints, 4);
  assert.equal(
    s.calls[1].url,
    "https://open.feishu.cn/open-apis/docx/v1/documents/doc1/raw_content",
  );
  assert.equal(s.calls[1].init.method, "GET");
});
test("empty content is a complete page", async () => {
  const s = setup(),
    result_id = await reference(s);
  s.hooks.content = { content: "" };
  const r = await s.service.fetch(P, { result_id });
  assert.equal(r.content, "");
  assert.equal(r.truncated, false);
  assert.equal(r.next_cursor, null);
});
test("missing scopes fail before transport; calendar scopes cannot read documents", async () => {
  const s = setup();
  s.changeScopes([
    "calendar:calendar:read",
    "calendar:calendar.event:read",
    "offline_access",
  ]);
  await assert.rejects(s.service.search(P, { query: "x" }), {
    code: "insufficient_scope",
  });
  assert.equal(s.calls.length, 0);
  s.changeScopes(["search:docs:read"]);
  const result_id = await reference(s),
    before = s.calls.length;
  await assert.rejects(s.service.fetch(P, { result_id }), {
    code: "insufficient_scope",
  });
  assert.equal(s.calls.length, before);
});
test("result references reject tampering, raw IDs and URLs before any provider call", async () => {
  const s = setup(),
    result_id = await reference(s),
    before = s.calls.length;
  for (const value of [
    "doc1",
    "https://evil.invalid/docx/doc1",
    result_id.slice(0, -5) + "xxxxx",
  ])
    await assert.rejects(s.service.fetch(P, { result_id: value }), {
      code: "invalid_reference",
    });
  assert.equal(s.calls.length, before);
});
test("result references bind owner, Site, grant and permissions and expire", async () => {
  const s = setup(),
    result_id = await reference(s),
    before = s.calls.length;
  for (const p of [
    { ...P, user: "other" },
    { ...P, site: "https://other.example.test" },
  ]) {
    const service = new DocxCandidate(
      s.provider,
      async () => ({ grant: "grant1", scopes, token: "synthetic-access" }),
      s.vault,
      () => 100000,
    );
    await assert.rejects(service.fetch(p, { result_id }), {
      code: "invalid_reference",
    });
  }
  s.changeScopes([...scopes, "extra"]);
  await assert.rejects(s.service.fetch(P, { result_id }), {
    code: "invalid_reference",
  });
  s.changeScopes(scopes);
  s.expire();
  await assert.rejects(s.service.fetch(P, { result_id }), {
    code: "invalid_reference",
  });
  s.changeGrant();
  await assert.rejects(s.service.fetch(P, { result_id }), {
    code: "invalid_reference",
  });
  assert.equal(s.calls.length, before);
});
test("fetch cursors bind exact result and page size; changed content requires restart", async () => {
  const s = setup(),
    result_id = await reference(s),
    first = await s.service.fetch(P, { result_id, max_chars: 1 });
  await assert.rejects(
    s.service.fetch(P, { result_id, max_chars: 2, cursor: first.next_cursor }),
    { code: "invalid_cursor" },
  );
  const second = await reference(s);
  await assert.rejects(
    s.service.fetch(P, {
      result_id: second,
      max_chars: 1,
      cursor: first.next_cursor,
    }),
    { code: "invalid_cursor" },
  );
  s.hooks.content = { content: "changed" };
  await assert.rejects(
    s.service.fetch(P, { result_id, max_chars: 1, cursor: first.next_cursor }),
    { code: "document_changed_restart" },
  );
});
test("search continuation preserves page token and query binding; repeated cursor is rejected", async () => {
  const s = setup();
  s.hooks.search = {
    res_units: [hit()],
    has_more: true,
    page_token: "synthetic-page1",
  };
  const first = await s.service.search(P, { query: "x", page_size: 1 });
  assert.equal(first.partial, true);
  assert.equal(first.traversal_complete, false);
  await assert.rejects(
    s.service.search(P, {
      query: "y",
      page_size: 1,
      cursor: first.next_cursor,
    }),
    { code: "invalid_cursor" },
  );
  await assert.rejects(
    s.service.search(P, {
      query: "x",
      page_size: 2,
      cursor: first.next_cursor,
    }),
    { code: "invalid_cursor" },
  );
  await assert.rejects(
    s.service.search(P, {
      query: "x",
      page_size: 1,
      cursor: first.next_cursor,
    }),
    { code: "provider_cursor_cycle" },
  );
  assert.equal(
    JSON.parse(s.calls.at(-1).init.body).page_token,
    "synthetic-page1",
  );
});
test("empty search page with continuation is explicit, not a false complete result", async () => {
  const s = setup();
  s.hooks.search = { res_units: [], has_more: true, page_token: "next" };
  const r = await s.service.search(P, { query: "x" });
  assert.deepEqual(r.results, []);
  assert(r.next_cursor);
  assert.equal(r.partial, true);
});
for (const patch of [
  { entity_type: "WIKI" },
  { result_meta: { token: "file1", doc_types: "FILE" } },
  { result_meta: { token: "../escape", doc_types: "DOCX" } },
])
  test(
    "mixed or invalid resource type is not fetched: " + JSON.stringify(patch),
    async () => {
      const s = setup();
      s.hooks.search = { res_units: [hit("doc1", patch)], has_more: false };
      await assert.rejects(s.service.search(P, { query: "x" }));
      assert.equal(s.calls.length, 1);
    },
  );
test("malformed provider pagination and duplicate document IDs fail explicitly", async () => {
  for (const page of [
    { res_units: [], has_more: true },
    { res_units: [hit(), hit()], has_more: false },
    { res_units: [], has_more: "yes" },
  ]) {
    const s = setup();
    s.hooks.search = page;
    await assert.rejects(s.service.search(P, { query: "x" }));
  }
});
for (const status of [302, 401, 403, 404, 429, 503])
  test("provider " + status + " neither leaks body nor retries", async () => {
    const s = setup();
    s.hooks.transport = () =>
      new Response("SENSITIVE_body", {
        status,
        headers: {
          Location: "https://evil.invalid/token",
          "x-tt-logid": "invalid id",
        },
      });
    await assert.rejects(s.service.search(P, { query: "x" }), (e) => {
      assert(!JSON.stringify(e).includes("SENSITIVE"));
      assert.equal(e.providerLogId, undefined);
      return true;
    });
    assert.equal(s.calls.length, 1);
  });
test("HTTP200 malformed/error envelopes and network exceptions fail without body/error-text disclosure", async () => {
  for (const value of [
    null,
    [],
    { code: 123, msg: "SENSITIVE" },
    { code: 0, data: [] },
  ]) {
    const s = setup();
    s.hooks.transport = () => Response.json(value);
    await assert.rejects(s.service.search(P, { query: "x" }), {
      code: "provider_invalid_response",
    });
  }
  const s = setup();
  s.hooks.transport = () => {
    throw new Error("SENSITIVE token url");
  };
  await assert.rejects(s.service.search(P, { query: "x" }), {
    code: "provider_network_error",
  });
});
test("document and response budgets reject oversized data rather than silently truncating it", async () => {
  const s = setup(),
    result_id = await reference(s);
  s.hooks.content = { content: "x".repeat(60001) };
  await assert.rejects(s.service.fetch(P, { result_id }), {
    code: "document_budget_exceeded",
  });
  s.hooks.transport = () => new Response("x".repeat(262145));
  await assert.rejects(s.service.fetch(P, { result_id }), {
    code: "provider_invalid_response",
  });
});
test("disconnect and scope changes while a read is in flight suppress output", async () => {
  for (const mode of ["disconnect", "scope"]) {
    const s = setup();
    s.hooks.transport = () => {
      mode === "disconnect"
        ? s.disconnect()
        : s.changeScopes([...scopes, "extra"]);
      return Response.json({
        code: 0,
        data: { res_units: [hit()], has_more: false },
      });
    };
    await assert.rejects(s.service.search(P, { query: "x" }), {
      code: mode === "disconnect" ? "authorization_required" : "scope_changed",
    });
  }
});
test("strict inputs reject arbitrary URL/identity controls and unsupported domains", async () => {
  const s = setup();
  for (const args of [
    { query: "x", url: "https://evil.invalid" },
    { query: "x", types: ["wiki"] },
    { query: "x", user: "other" },
    { query: "😀".repeat(31) },
    { query: "x", page_size: 6 },
  ])
    await assert.rejects(s.service.search(P, args), {
      code: "invalid_argument",
    });
  assert.equal(s.calls.length, 0);
});
test("production worker still lists only get_agenda and denies candidate tool names", async () => {
  const s = await agendaSetup();
  for (const name of ["search", "fetch"])
    assert.equal(
      (await s.tool({}, P.user, name)).result.structuredContent.error,
      "write_or_unknown_tool_denied",
    );
  assert.equal(s.mocked.calls.length, 0);
});
for (const [title, summary, expectedTitle, expectedSummary] of [
  [
    "a".repeat(255) + "😀",
    "b".repeat(511) + "😀",
    "a".repeat(255),
    "b".repeat(511),
  ],
  [
    "a".repeat(254) + "😀",
    "b".repeat(510) + "😀",
    "a".repeat(254) + "😀",
    "b".repeat(510) + "😀",
  ],
  ["😀".repeat(129), "😀".repeat(257), "😀".repeat(128), "😀".repeat(256)],
  [
    "<h>" + "a".repeat(255) + "😀</h>",
    "<hb>" + "b".repeat(511) + "😀</hb>",
    "a".repeat(255),
    "b".repeat(511),
  ],
])
  test(
    "search previews preserve surrogate pairs within UTF-16 budgets: " +
      title.length +
      "/" +
      summary.length,
    async () => {
      const s = setup();
      s.hooks.search = {
        res_units: [
          hit("doc1", {
            title_highlighted: title,
            summary_highlighted: summary,
          }),
        ],
        has_more: false,
      };
      const found = await s.service.search(P, { query: "x" }),
        result = found.results[0];
      assert.equal(result.title, expectedTitle);
      assert.equal(result.snippet, expectedSummary);
      assert(result.title.length <= 256);
      assert(result.snippet.length <= 512);
      assert(result.title.isWellFormed());
      assert(result.snippet.isWellFormed());
      const document = await s.service.fetch(P, {
        result_id: result.result_id,
      });
      assert.equal(document.title, expectedTitle);
      assert(document.title.isWellFormed());
    },
  );
test("search rejects provider title and summary containing isolated surrogates", async () => {
  for (const patch of [
    { title_highlighted: "bad\ud83d" },
    { summary_highlighted: "bad\ude00" },
  ]) {
    const s = setup();
    s.hooks.search = { res_units: [hit("doc1", patch)], has_more: false };
    await assert.rejects(s.service.search(P, { query: "x" }), {
      code: "provider_invalid_response",
    });
  }
});
for (const operation of ["search", "fetch"])
  for (const race of ["disconnect", "grant", "scope"])
    test(`${operation} suppresses output after in-flight ${race} change`, async () => {
      const s = setup(),
        result_id = operation === "fetch" ? await reference(s) : null;
      s.hooks.transport = () => {
        if (race === "disconnect") s.disconnect();
        else if (race === "grant") s.changeGrant();
        else s.changeScopes([...scopes, "additional"]);
        return Response.json({
          code: 0,
          data:
            operation === "search"
              ? { res_units: [hit()], has_more: false }
              : { content: "Synthetic content" },
        });
      };
      await assert.rejects(
        operation === "search"
          ? s.service.search(P, { query: "x" })
          : s.service.fetch(P, { result_id }),
        {
          code: {
            disconnect: "authorization_required",
            grant: "connection_changed",
            scope: "scope_changed",
          }[race],
        },
      );
    });
for (const [label, p] of [
  ["owner", { ...P, user: "other" }],
  ["Site", { ...P, site: "https://other.example.test" }],
])
  test(`search cursor rejects another ${label} before transport`, async () => {
    const s = setup();
    s.hooks.search = {
      res_units: [],
      has_more: true,
      page_token: "synthetic-next",
    };
    const found = await s.service.search(P, { query: "x" }),
      before = s.calls.length;
    const service = new DocxCandidate(
      s.provider,
      async () => ({ grant: "grant1", scopes, token: "synthetic-access" }),
      s.vault,
      () => 100000,
    );
    await assert.rejects(
      service.search(p, { query: "x", cursor: found.next_cursor }),
      { code: "invalid_reference" },
    );
    assert.equal(s.calls.length, before);
  });
