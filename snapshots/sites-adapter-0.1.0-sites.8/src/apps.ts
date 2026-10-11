import { z } from "zod";
import {
  assert,
  aad,
  hash,
  Vault,
  boundedText,
  object,
  type Env,
  type Principal,
} from "./security.ts";
import { Store, type Grant } from "./store.ts";
import { Feishu, SCOPES, DOCX_SCOPES, type Fetcher } from "./feishu.ts";
import { Linking } from "./linking.ts";
import { Agenda } from "./agenda.ts";
import { DocxCandidate, DocxCandidateProvider } from "./docx-candidate.ts";
import { createDocxD1Access } from "./docx-d1-access.ts";
const appIdSchema = z.string().regex(/^cli_[a-zA-Z0-9]{8,64}$/);
const capabilities = [...SCOPES, ...DOCX_SCOPES];
interface AppRow {
  app_id: string;
  label: string;
  secret: string;
  scopes: string;
}
export class Apps {
  readonly store: Store;
  readonly vault: Vault;
  constructor(
    private env: Env,
    private transport: Fetcher = globalThis.fetch.bind(globalThis),
    private now = Date.now,
  ) {
    this.store = new Store(env.DB);
    this.vault = new Vault(env.APP_ENCRYPTION_KEY);
  }
  private async provider(path: string, init: RequestInit) {
    const r = await this.transport("https://open.feishu.cn" + path, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    assert(r.status === 200, "app_permission_query_failed", 502);
    const data = JSON.parse(await boundedText(r, 262144));
    assert(data && data.code === 0, "app_permission_query_failed", 502);
    return data;
  }
  async discover(appId: string, secret: string) {
    const auth = await this.provider(
      "/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: appId, app_secret: secret }),
      },
    );
    assert(
      typeof auth.tenant_access_token === "string" &&
        auth.tenant_access_token.length < 8192,
      "app_permission_query_failed",
      502,
    );
    const raw = await this.provider("/open-apis/application/v6/scopes", {
      headers: { Authorization: "Bearer " + auth.tenant_access_token },
    });
    const parsed = z
      .object({
        scopes: z
          .array(
            z.object({
              scope_name: z.string().min(1).max(256),
              grant_status: z.number().int(),
            }),
          )
          .max(3000),
      })
      .safeParse(raw.data);
    assert(parsed.success, "app_permission_query_failed", 502);
    return [
      ...new Set(
        parsed.data.scopes
          .filter((s) => s.grant_status === 1)
          .map((s) => s.scope_name),
      ),
    ];
  }
  async rows(p: Principal) {
    return (
      await this.env.DB.prepare(
        "SELECT app_id,label,secret,scopes FROM app_registry WHERE site=? AND owner=? ORDER BY app_id",
      )
        .bind(p.site, p.user)
        .all<AppRow>()
    ).results;
  }
  async add(p: Principal, args: unknown) {
    const parsed = z
      .object({
        app_id: appIdSchema,
        label: z.string().trim().min(1).max(60),
        app_secret: z
          .string()
          .min(16)
          .max(256)
          .regex(/^[A-Za-z0-9_-]+$/),
      })
      .strict()
      .safeParse(args);
    assert(parsed.success);
    const input = parsed.data;
    assert(input.app_id !== this.env.FEISHU_APP_ID, "app_already_exists", 409);
    const rows = await this.rows(p);
    assert(rows.length < 8, "app_limit_reached", 422);
    assert(
      !rows.some((r) => r.app_id === input.app_id),
      "app_already_exists",
      409,
    );
    const scopes = await this.discover(input.app_id, input.app_secret);
    const secret = await this.vault.seal(
      { secret: input.app_secret },
      aad(p, "app-secret", input.app_id),
    );
    await this.env.DB.prepare(
      "INSERT INTO app_registry(site,owner,app_id,label,secret,scopes) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        p.site,
        p.user,
        input.app_id,
        input.label,
        secret,
        JSON.stringify(scopes),
      )
      .run();
    return {
      saved: true,
      app_id: input.app_id,
      permission_count: scopes.length,
      available_scopes: capabilities.filter((s) => scopes.includes(s)),
      permission_source: "feishu_application_scopes_api",
    };
  }
  async context(p: Principal, id = "primary") {
    assert(id === "primary" || appIdSchema.safeParse(id).success);
    let env = this.env,
      scoped = p;
    if (id !== "primary") {
      const row = (await this.rows(p)).find((r) => r.app_id === id);
      assert(row, "app_not_found", 404);
      const value = await this.vault.open<{ secret: string }>(
        row.secret,
        aad(p, "app-secret", id),
      );
      const available = JSON.parse(row.scopes) as string[];
      const scopes = capabilities.filter((s) => available.includes(s));
      assert(
        scopes.includes("offline_access"),
        "app_offline_scope_required",
        403,
      );
      env = {
        ...this.env,
        FEISHU_APP_ID: id,
        FEISHU_APP_SECRET: value.secret,
        FEISHU_OAUTH_SCOPES: scopes,
      };
      scoped = {
        site: p.site,
        user: "app:" + (await hash(aad(p, "app-principal", id))),
      };
    }
    const api = new Feishu(env, this.transport, this.now),
      link = new Linking(env, this.store, this.vault, api, this.now);
    return { id, env, p: scoped, api, link };
  }
  async list(p: Principal) {
    const rows = await this.rows(p);
    const output = [];
    for (const item of [
      { app_id: "primary", label: "原有飞书应用", scopes: "[]" },
      ...rows,
    ]) {
      const scoped =
        item.app_id === "primary"
          ? p
          : {
              site: p.site,
              user: "app:" + (await hash(aad(p, "app-principal", item.app_id))),
            };
      const row = await this.store.get(scoped);
      output.push({
        connection_id: item.app_id,
        label: item.label,
        connected: row?.status === "active",
        account_name: row?.display_name ?? null,
        granted_scopes: row ? JSON.parse(row.scopes) : [],
        available_scopes: JSON.parse(item.scopes),
        grant_id: row?.grant_id ?? null,
        epoch: await this.store.epoch(scoped),
      });
    }
    return output;
  }
  async read(p: Principal, name: string, args: unknown) {
    assert(args && typeof args === "object" && !Array.isArray(args));
    const { connection_id, ...input } = args as Record<string, unknown>;
    if (connection_id !== undefined) assert(typeof connection_id === "string");
    const rows = await this.rows(p);
    if(!rows.length && connection_id===undefined){
      const ctx=await this.context(p);
      const docs=new DocxCandidate(new DocxCandidateProvider(this.transport),createDocxD1Access(this.store,ctx.link),this.vault,this.now,'feishu_api');
      return name==='get_agenda'?new Agenda(this.store,ctx.link,ctx.api,this.vault,this.now).read(p,input):name==='search_docx'?docs.search(p,input):docs.fetch(p,input);
    }
    // Preserve the legacy contract when no additional apps exist.
    if (rows.length && (input.cursor || input.result_id))
      assert(connection_id, "connection_reference_required");
    const required =
      name === "get_agenda"
        ? SCOPES
        : name === "search_docx"
          ? [DOCX_SCOPES[0]]
          : [DOCX_SCOPES[1]];
    const active: { id: string; row: Grant }[] = [];
    for (const id of ["primary", ...rows.map((r) => r.app_id)]) {
      const scoped =
        id === "primary"
          ? p
          : {
              site: p.site,
              user: "app:" + (await hash(aad(p, "app-principal", id))),
            };
      const row = await this.store.get(scoped);
      if (row?.status === "active") active.push({ id, row });
    }
    if (!connection_id && active.length > 1) {
      assert(
        active.every(
          (v) =>
            v.row.union_id &&
            v.row.tenant_key === active[0]!.row.tenant_key &&
            v.row.union_id === active[0]!.row.union_id,
        ),
        "account_selection_required",
        409,
      );
    }
    const chosen = connection_id
      ? active.find((v) => v.id === connection_id)
      : active.find((v) =>
          required.every((s) => JSON.parse(v.row.scopes).includes(s)),
        );
    assert(
      chosen,
      active.length ? "insufficient_scope" : "connection_required",
      active.length ? 403 : 401,
    );
    assert(
      required.every((s) => JSON.parse(chosen.row.scopes).includes(s)),
      "insufficient_scope",
      403,
    );
    const ctx = await this.context(p, chosen.id);
    const docs = new DocxCandidate(
      new DocxCandidateProvider(this.transport),
      createDocxD1Access(this.store, ctx.link),
      this.vault,
      this.now,
      "feishu_api",
    );
    const result =
      name === "get_agenda"
        ? await new Agenda(
            this.store,
            ctx.link,
            ctx.api,
            this.vault,
            this.now,
          ).read(ctx.p, input)
        : name === "search_docx"
          ? await docs.search(ctx.p, input)
          : await docs.fetch(ctx.p, input);
    return rows.length ? { ...result, connection_id: chosen.id } : result;
  }
}
