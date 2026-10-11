import { z } from "zod";
import { Apps } from "./apps.ts";
import type { Grant } from "./store.ts";
import {
  assert,
  aad,
  hash,
  random,
  AppError,
  type Env,
  type Principal,
} from "./security.ts";
import { writeInput, writeRequirements } from "./write-contracts.ts";
import { WriteProvider } from "./write-provider.ts";
import type { Fetcher } from "./feishu.ts";
interface Intent {
  site: string;
  owner: string;
  intent_id: string;
  request_id: string;
  fingerprint: string;
  connection_id: string;
  scoped_user: string;
  grant_id: string;
  operation: string;
  payload: string;
  status: string;
  receipt: string | null;
  expires: number;
  created: number;
}
export class Writes {
  readonly apps: Apps;
  constructor(
    private env: Env,
    private transport: Fetcher = globalThis.fetch.bind(globalThis),
    private now = Date.now,
  ) {
    this.apps = new Apps(env, transport, now);
  }
  private enabled() {
    assert(
      this.env.FEISHU_WRITE_ENABLED === "true",
      "write_feature_disabled",
      403,
    );
  }
  private async row(p: Principal, id: string) {
    assert(/^[A-Za-z0-9_-]{10,100}$/.test(id));
    const r = await this.env.DB.prepare(
      "SELECT * FROM write_intents WHERE site=? AND owner=? AND intent_id=?",
    )
      .bind(p.site, p.user, id)
      .first<Intent>();
    assert(r, "intent_not_found", 404);
    return r;
  }
  private async payload(p: Principal, r: Intent) {
    const value = await this.apps.vault.open<Record<string, any>>(
      r.payload,
      aad(p, "write-intent", r.intent_id),
    );
    return value.parameters ?? value;
  }
  private async current(p: Principal, r: Intent, a: Record<string, any>) {
    const ctx = await this.apps.context(p, r.connection_id);
    const grant = await this.apps.store.get(ctx.p);
    assert(
      ctx.p.user === r.scoped_user &&
        grant?.status === "active" &&
        grant.grant_id === r.grant_id,
      "write_grant_changed",
      403,
    );
    const scopes = JSON.parse(grant.scopes);
    assert(
      writeRequirements(r.operation, a).every((g) =>
        g.some((s) => scopes.includes(s)),
      ),
      "insufficient_scope",
      403,
    );
    return ctx;
  }
  async prepare(p: Principal, operation: string, args: unknown) {
    this.enabled();
    const parsed = z
      .object({
        connection_id: z.string().max(80).optional(),
        request_id: z.uuid(),
        parameters: z.record(z.string(), z.unknown()),
      })
      .strict()
      .safeParse(args);
    assert(parsed.success);
    const a = writeInput(operation, parsed.data.parameters);
    const fingerprint = await hash(
      JSON.stringify({
        operation,
        a,
        connection_id: parsed.data.connection_id ?? null,
      }),
    );
    const previous = await this.env.DB.prepare(
      "SELECT * FROM write_intents WHERE site=? AND owner=? AND request_id=?",
    )
      .bind(p.site, p.user, parsed.data.request_id)
      .first<Intent>();
    if (previous) {
      assert(previous.fingerprint === fingerprint, "request_id_conflict", 409);
      return this.describe(p, previous);
    }
    const active: {
      ctx: Awaited<ReturnType<Apps["context"]>>;
      grant: Grant;
      label: string;
    }[] = [];
    for (const c of await this.apps.list(p)) {
      if (!c.connected) continue;
      const ctx = await this.apps.context(p, c.connection_id);
      const grant = await this.apps.store.get(ctx.p);
      if (grant?.status === "active")
        active.push({ ctx, grant, label: c.label });
    }
    if (!parsed.data.connection_id && active.length > 1)
      assert(
        active.every(
          (v) =>
            v.grant.union_id &&
            v.grant.union_id === active[0]!.grant.union_id &&
            v.grant.tenant_key === active[0]!.grant.tenant_key,
        ),
        "account_selection_required",
        409,
      );
    const required = writeRequirements(operation, a);
    const chosen = active.find(
      (v) =>
        (!parsed.data.connection_id ||
          v.ctx.id === parsed.data.connection_id) &&
        required.every((g) =>
          g.some((s) => JSON.parse(v.grant.scopes).includes(s)),
        ),
    );
    if (!chosen)
      return {
        error: active.length ? "insufficient_scope" : "connection_required",
        operation,
        required_scope_groups: required,
        connections: (await this.apps.list(p)).map((c) => ({
          connection_id: c.connection_id,
          label: c.label,
          connected: c.connected,
        })),
      };
    const { ctx, grant } = chosen;
    if (operation === "book_meeting_room") {
      const access = await ctx.link.access(ctx.p, grant.grant_id);
      await new WriteProvider(this.transport, this.now).inspectBooking(
        access.token,
        a,
      );
    }
    const id = random(),
      expires = this.now() + 15 * 60000,
      payload = await this.apps.vault.seal(
        {
          parameters: a,
          account: {
            name: grant.display_name,
            app_label: chosen.label,
            open_id: grant.open_id,
            tenant_key: grant.tenant_key,
          },
        },
        aad(p, "write-intent", id),
      );
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO write_intents(site,owner,intent_id,request_id,fingerprint,connection_id,scoped_user,grant_id,operation,payload,status,expires,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        p.site,
        p.user,
        id,
        parsed.data.request_id,
        fingerprint,
        ctx.id,
        ctx.p.user,
        grant.grant_id,
        operation,
        payload,
        "pending",
        expires,
        this.now(),
      )
      .run();
    const saved = await this.env.DB.prepare(
      "SELECT * FROM write_intents WHERE site=? AND owner=? AND request_id=?",
    )
      .bind(p.site, p.user, parsed.data.request_id)
      .first<Intent>();
    assert(
      saved && saved.fingerprint === fingerprint,
      "request_id_conflict",
      409,
    );
    return this.describe(p, saved);
  }
  private async describe(p: Principal, r: Intent) {
    const stored = await this.apps.vault.open<any>(
      r.payload,
      aad(p, "write-intent", r.intent_id),
    );
    return {
      account: stored.account ?? null,
      intent_id: r.intent_id,
      operation: r.operation,
      status:
        r.status === "executing"
          ? "unknown"
          : r.status === "pending" && r.expires <= this.now()
            ? "expired"
            : r.status,
      connection_id: r.connection_id,
      expires_at: new Date(r.expires).toISOString(),
      review_url: p.site + "/write-review/" + r.intent_id,
      ...(r.receipt
        ? {
            receipt: await this.apps.vault.open(
              r.receipt,
              aad(p, "write-receipt", r.intent_id),
            ),
          }
        : {}),
      executed: r.status !== "pending" && r.status !== "cancelled",
      hint: "用户在确认页面审核后提交。结果未知时请核查飞书，勿创建新请求重试。",
    };
  }
  async review(p: Principal, id: string) {
    this.enabled();
    const r = await this.row(p, id);
    return {
      ...(await this.describe(p, r)),
      parameters: await this.payload(p, r),
    };
  }
  async refresh(p: Principal, id: string) {
    this.enabled();
    const r = await this.row(p, id);
    if (
      r.operation !== "book_meeting_room" ||
      !["awaiting_approval", "unknown"].includes(r.status) ||
      !r.receipt
    )
      return this.describe(p, r);
    const receipt = await this.apps.vault.open<any>(
      r.receipt,
      aad(p, "write-receipt", id),
    );
    const event_id = receipt.effects?.find(
      (e: any) => typeof e.event_id === "string",
    )?.event_id;
    if (!event_id) return this.describe(p, r);
    const a = await this.payload(p, r),
      ctx = await this.current(p, r, a),
      access = await ctx.link.access(ctx.p, r.grant_id);
    const booking = await new WriteProvider(
      this.transport,
      this.now,
      async () => {
        await this.current(p, r, a);
      },
    ).bookingStatus(access.token, a, event_id);
    const status =
      booking === "reserved"
        ? "succeeded"
        : booking === "pending"
          ? "awaiting_approval"
          : booking === "unknown"
            ? "unknown"
            : "partial";
    receipt.effects = receipt.effects.filter(
      (e: any) => e.booking_status === undefined,
    );
    receipt.effects.push({
      event_id,
      room_id: a.room_id,
      booking_status: booking,
    });
    receipt.status = status === "awaiting_approval" ? "pending" : status;
    const sealed = await this.apps.vault.seal(
      receipt,
      aad(p, "write-receipt", id),
    );
    await this.env.DB.prepare(
      "UPDATE write_intents SET status=?,receipt=? WHERE site=? AND owner=? AND intent_id=? AND status=? AND receipt=?",
    )
      .bind(status, sealed, p.site, p.user, id, r.status, r.receipt)
      .run();
    return this.describe(p, await this.row(p, id));
  }
  async cancel(p: Principal, id: string) {
    this.enabled();
    await this.row(p, id);
    await this.env.DB.prepare(
      "UPDATE write_intents SET status='cancelled' WHERE site=? AND owner=? AND intent_id=? AND status='pending'",
    )
      .bind(p.site, p.user, id)
      .run();
    return this.describe(p, await this.row(p, id));
  }
  async execute(p: Principal, id: string) {
    this.enabled();
    const r = await this.row(p, id);
    if (r.status !== "pending") return this.describe(p, r);
    assert(r.expires > this.now(), "intent_expired", 409);
    const a = await this.payload(p, r),
      ctx = await this.current(p, r, a);
    const access = await ctx.link.access(ctx.p, r.grant_id);
    // Claim and active-grant check are one database statement. Competing confirms cannot send twice.
    const claim = await this.env.DB.prepare(
      "UPDATE write_intents SET status='executing' WHERE site=? AND owner=? AND intent_id=? AND status='pending' AND expires>? AND EXISTS(SELECT 1 FROM connections WHERE site=? AND user_id=? AND grant_id=? AND status='active') RETURNING intent_id",
    )
      .bind(p.site, p.user, id, this.now(), ctx.p.site, ctx.p.user, r.grant_id)
      .first();
    if (!claim) return this.describe(p, await this.row(p, id));
    let receipt;
    try {
      await this.current(p, r, a);
      receipt = await new WriteProvider(this.transport, this.now, async () => {
        await this.current(p, r, a);
      }).execute(access.token, r.operation, a, r.request_id);
    } catch (e) {
      receipt = {
        status: "failed",
        operation: r.operation,
        effects: [],
        error: e instanceof AppError ? e.code : "write_not_executed",
        retry_safe: false,
      };
    }
    const sealed = await this.apps.vault.seal(
      receipt,
      aad(p, "write-receipt", id),
    );
    await this.env.DB.prepare(
      "UPDATE write_intents SET status=?,receipt=? WHERE site=? AND owner=? AND intent_id=? AND status='executing'",
    )
      .bind(
        receipt.status === "pending" ? "awaiting_approval" : receipt.status,
        sealed,
        p.site,
        p.user,
        id,
      )
      .run();
    return this.describe(p, await this.row(p, id));
  }
}
