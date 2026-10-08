// Offline candidate only: not imported by worker.ts or registered as an MCP tool.
import { z } from "zod";
import {
  AppError,
  assert,
  aad,
  boundedText,
  hash,
  Vault,
  type Principal,
} from "./security.ts";
import { ProviderFailure, type Fetcher } from "./feishu.ts";
import { providerLogId } from "./provider-diagnostics.ts";
export const DOCX_CANDIDATE_SCOPES = {
  search: "search:docs:read",
  fetch: "docx:document:readonly",
} as const;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const opaque = z.string().min(1).max(4000);
// In Unicode mode, paired surrogates are one non-BMP codepoint; this range
// matches only isolated UTF-16 surrogate code units.
const unicodeText = z
  .string()
  .refine((value) => !/[\uD800-\uDFFF]/u.test(value));
function boundedPreview(value: string, maxUnits: number): string {
  let result = "";
  for (const point of value.replace(/<\/?h[b]?>/g, "")) {
    if (result.length + point.length > maxUnits) break;
    result += point;
  }
  return result;
}

const searchInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .refine((v) => Array.from(v).length <= 30),
    page_size: z.number().int().min(1).max(5).default(5),
    cursor: opaque.optional(),
  })
  .strict();
const fetchInput = z
  .object({
    result_id: opaque,
    max_chars: z.number().int().min(1).max(2000).default(2000),
    cursor: opaque.optional(),
  })
  .strict();
const resource = z
  .object({
    kind: z.literal("docx"),
    id,
    title: unicodeText.max(256),
    expires: z.number().finite(),
    scopes: z.string(),
  })
  .strict();
const searchCursor = z
  .object({
    fingerprint: z.string(),
    upstream: z.string().min(1).max(1000),
    seen: z.array(z.string()).max(20),
    expires: z.number().finite(),
  })
  .strict();
const fetchCursor = z
  .object({
    fingerprint: z.string(),
    version: z.string(),
    offset: z.number().int().min(1).max(60000),
    expires: z.number().finite(),
  })
  .strict();
export interface DocxGrant {
  grant: string;
  scopes: readonly string[];
  token: string;
  revision?: number;
}
// Integrators must resolve trusted principal + current grant on every call, and fence
// disconnect/relink races when expectedGrant is supplied. No token storage here.
export type DocxAccess = (
  principal: Principal,
  expectedGrant?: string,
  requiredScope?: string,
) => Promise<DocxGrant>;
export class DocxCandidateProvider {
  // Deliberately no global fetch default. Tests supply an intercepted transport.
  constructor(private transport: Fetcher) {}
  private async request(path: string, token: string, body?: unknown) {
    let response: Response;
    try {
      response = await this.transport("https://open.feishu.cn" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer " + token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new AppError("provider_network_error", 503);
    }
    const logId = providerLogId(response.headers);
    if (response.status !== 200) {
      // Do not parse or log an upstream error body. No automatic retries.
      await response.body?.cancel().catch(() => {});
      const status = [401, 403, 404, 429].includes(response.status)
        ? response.status
        : 502;
      throw new ProviderFailure(
        response.status >= 300 && response.status < 400
          ? "provider_redirect_denied"
          : "provider_read_failed",
        status,
        undefined,
        logId,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await boundedText(response, 262144));
    } catch {
      throw new ProviderFailure(
        "provider_invalid_response",
        502,
        undefined,
        logId,
      );
    }
    const parsed = z
      .object({ code: z.literal(0), data: z.record(z.string(), z.unknown()) })
      .safeParse(raw);
    if (!parsed.success)
      throw new ProviderFailure(
        "provider_invalid_response",
        502,
        undefined,
        logId,
      );
    return parsed.data.data;
  }
  async search(
    token: string,
    query: string,
    pageSize: number,
    upstream?: string,
  ) {
    return this.request("/open-apis/search/v2/doc_wiki/search", token, {
      query,
      page_size: pageSize,
      doc_filter: { doc_types: ["DOCX"] },
      ...(upstream ? { page_token: upstream } : {}),
    });
  }
  async content(token: string, documentId: string) {
    assert(id.safeParse(documentId).success);
    return this.request(
      "/open-apis/docx/v1/documents/" +
        encodeURIComponent(documentId) +
        "/raw_content",
      token,
    );
  }
}
export class DocxCandidate {
  constructor(
    private api: DocxCandidateProvider,
    private access: DocxAccess,
    private vault: Vault,
    private now = Date.now,
  ) {}
  private async auth(
    p: Principal,
    operation: keyof typeof DOCX_CANDIDATE_SCOPES,
    grant?: string,
  ) {
    const auth = await this.access(p, grant, DOCX_CANDIDATE_SCOPES[operation]);
    assert(!grant || auth.grant === grant, "connection_changed", 401);
    assert(
      auth.scopes.includes(DOCX_CANDIDATE_SCOPES[operation]),
      "insufficient_scope",
      403,
    );
    return auth;
  }
  private async scopeHash(auth: DocxGrant) {
    return hash(
      JSON.stringify({
        scopes: [...new Set(auth.scopes)].sort(),
        revision: auth.revision ?? null,
      }),
    );
  }
  private async seal(
    value: unknown,
    p: Principal,
    kind: string,
    grant: string,
  ) {
    const sealed = await this.vault.seal(value, aad(p, kind, grant));
    assert(sealed.length <= 4000, "cursor_budget_exceeded", 422);
    return sealed;
  }
  private async open(value: string, p: Principal, kind: string, grant: string) {
    try {
      return await this.vault.open(value, aad(p, kind, grant));
    } catch {
      throw new AppError("invalid_reference");
    }
  }
  private output<T>(value: T): T {
    assert(
      new TextEncoder().encode(JSON.stringify(value)).length <= 20000,
      "output_budget_exceeded",
      422,
    );
    return value;
  }
  async search(p: Principal, args: unknown) {
    const parsed = searchInput.safeParse(args);
    assert(parsed.success);
    const input = parsed.data,
      auth = await this.auth(p, "search");
    const scopes = await this.scopeHash(auth);
    const fingerprint = await hash(
      JSON.stringify({ query: input.query, size: input.page_size, scopes }),
    );
    let expires = this.now() + 600000,
      upstream: string | undefined,
      seen: string[] = [];
    if (input.cursor) {
      const previous = searchCursor.safeParse(
        await this.open(input.cursor, p, "docx-search", auth.grant),
      );
      assert(
        previous.success &&
          previous.data.expires > this.now() &&
          previous.data.fingerprint === fingerprint,
        "invalid_cursor",
      );
      ({ expires, upstream, seen } = previous.data);
    }
    const raw = await this.api.search(
      auth.token,
      input.query,
      input.page_size,
      upstream,
    );
    const page = z
      .object({
        res_units: z
          .array(
            z.object({
              entity_type: z.string(),
              result_meta: z.object({ token: id, doc_types: z.string() }),
              title_highlighted: unicodeText.max(1000).optional(),
              summary_highlighted: unicodeText.max(4000).optional(),
            }),
          )
          .max(input.page_size),
        has_more: z.boolean(),
        page_token: z.string().max(1000).optional(),
      })
      .safeParse(raw);
    assert(page.success, "provider_invalid_response", 502);
    // No Wiki resolution or alternate-resource fallback. A mixed-domain page is
    // rejected, rather than silently returning apparently complete DOCX results.
    assert(
      page.data.res_units.every(
        (v) => v.result_meta.doc_types === "DOCX" && v.entity_type === "DOC",
      ),
      "unsupported_resource_type",
      502,
    );
    assert(
      new Set(page.data.res_units.map((v) => v.result_meta.token)).size ===
        page.data.res_units.length,
      "provider_duplicate_result",
      502,
    );
    const results = [];
    for (const item of page.data.res_units) {
      const title = boundedPreview(item.title_highlighted ?? "", 256);
      results.push({
        result_id: await this.seal(
          { kind: "docx", id: item.result_meta.token, title, expires, scopes },
          p,
          "docx-resource",
          auth.grant,
        ),
        type: "docx",
        title,
        snippet: boundedPreview(item.summary_highlighted ?? "", 512),
      });
    }
    let next: string | null = null;
    if (page.data.has_more) {
      assert(page.data.page_token, "provider_invalid_pagination", 502);
      const tokenHash = await hash(page.data.page_token);
      assert(
        seen.length < 20 && !seen.includes(tokenHash),
        "provider_cursor_cycle",
        502,
      );
      next = await this.seal(
        {
          fingerprint,
          upstream: page.data.page_token,
          seen: [...seen, tokenHash],
          expires,
        },
        p,
        "docx-search",
        auth.grant,
      );
    }
    const current = await this.auth(p, "search", auth.grant);
    assert(
      current.revision === auth.revision,
      "docx_state_changed_restart",
      409,
    );
    assert((await this.scopeHash(current)) === scopes, "scope_changed", 401);
    return this.output({
      results,
      next_cursor: next,
      traversal_complete: next === null,
      partial: next !== null,
      coverage: "docx_only",
      source: "synthetic_candidate",
      live_verified: false,
      content_trust: "untrusted_source_data",
    });
  }
  async fetch(p: Principal, args: unknown) {
    const parsed = fetchInput.safeParse(args);
    assert(parsed.success);
    const input = parsed.data,
      auth = await this.auth(p, "fetch"),
      scopes = await this.scopeHash(auth);
    const ref = resource.safeParse(
      await this.open(input.result_id, p, "docx-resource", auth.grant),
    );
    assert(
      ref.success &&
        ref.data.expires > this.now() &&
        ref.data.scopes === scopes,
      "invalid_reference",
    );
    const fingerprint = await hash(
      JSON.stringify({
        result: input.result_id,
        chars: input.max_chars,
        scopes,
      }),
    );
    let offset = 0,
      version: string | null = null;
    if (input.cursor) {
      const cursor = fetchCursor.safeParse(
        await this.open(input.cursor, p, "docx-fetch", auth.grant),
      );
      assert(
        cursor.success &&
          cursor.data.expires > this.now() &&
          cursor.data.fingerprint === fingerprint,
        "invalid_cursor",
      );
      ({ offset, version } = cursor.data);
    }
    const raw = await this.api.content(auth.token, ref.data.id);
    const body = z.object({ content: z.string() }).safeParse(raw);
    assert(body.success, "provider_invalid_response", 502);
    const chars = Array.from(body.data.content);
    assert(chars.length <= 60000, "document_budget_exceeded", 422);
    const currentVersion = await hash(body.data.content);
    assert(
      version === null || version === currentVersion,
      "document_changed_restart",
      409,
    );
    assert(offset <= chars.length, "invalid_cursor");
    const end = Math.min(offset + input.max_chars, chars.length),
      truncated = end < chars.length;
    const next = truncated
      ? await this.seal(
          {
            fingerprint,
            version: currentVersion,
            offset: end,
            expires: ref.data.expires,
          },
          p,
          "docx-fetch",
          auth.grant,
        )
      : null;
    const current = await this.auth(p, "fetch", auth.grant);
    assert(
      current.revision === auth.revision,
      "docx_state_changed_restart",
      409,
    );
    assert((await this.scopeHash(current)) === scopes, "scope_changed", 401);
    return this.output({
      type: "docx",
      title: ref.data.title,
      content: chars.slice(offset, end).join(""),
      next_cursor: next,
      truncated,
      offset_codepoints: offset,
      total_codepoints: chars.length,
      coverage: "plain_text_only",
      title_basis: "search_snapshot",
      source: "synthetic_candidate",
      live_verified: false,
      content_trust: "untrusted_source_data",
    });
  }
}
