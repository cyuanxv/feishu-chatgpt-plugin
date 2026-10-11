import { z } from "zod";
import {
  assert,
  AppError,
  aad,
  hash,
  Vault,
  type Principal,
} from "./security.ts";
import { Store } from "./store.ts";
import { Linking } from "./linking.ts";
import { Feishu, SCOPES } from "./feishu.ts";
const id = z
  .string()
  .regex(/^[A-Za-z0-9_.@+-]{1,256}$/)
  .refine((v) => v !== "." && v !== "..");
const range = z
  .object({
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.end) > Date.parse(v.start) &&
      Date.parse(v.end) - Date.parse(v.start) <= 31 * 86400000,
  );
export const agendaInput = z
  .object({
    time_range: range,
    timezone: z
      .string()
      .max(100)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }),
    page_size: z.number().int().min(1).max(20).default(20),
    cursor: z.string().max(6000).optional(),
  })
  .strict();
const time = z
  .object({
    timestamp: z.string().regex(/^\d+$/).optional(),
    date: z.iso.date().optional(),
    timezone: z.string().max(100).optional(),
  })
  .refine((v) => Boolean(v.timestamp) !== Boolean(v.date));
const event = z.object({
  event_id: id,
  summary: z.string().max(4000).optional(),
  start_time: time,
  end_time: time,
  status: z.enum(["cancelled", "confirmed", "tentative"]).optional(),
});
const millis = (t: z.infer<typeof time>) =>
  t.date ? Date.parse(t.date + "T00:00:00Z") : Number(t.timestamp) * 1000;
interface State {
  fingerprint: string;
  grant: string;
  calendars: string[];
  directory: string | null;
  started: boolean;
  seen: string[];
  pages: string[];
  offset: number;
  version: string | null;
  unavailable: string[];
  expires: number;
}
const stateSchema = z.object({
  fingerprint: z.string(),
  grant: z.string(),
  calendars: z.array(id).max(20),
  directory: z.string().max(2000).nullable(),
  started: z.boolean(),
  seen: z.array(z.string()).max(20),
  pages: z.array(z.string()).max(20),
  offset: z.number().int().min(0).max(200),
  version: z.string().nullable(),
  unavailable: z.array(id).max(20),
  expires: z.number().finite(),
});
export class Agenda {
  constructor(
    private store: Store,
    private link: Linking,
    private api: Feishu,
    private vault: Vault,
    private now = Date.now,
  ) {}
  async read(p: Principal, args: unknown) {
    const parsed = agendaInput.safeParse(args);
    assert(parsed.success);
    const input = parsed.data;
    const connection = await this.store.current(p);
    assert(SCOPES.every(s => JSON.parse(connection.scopes).includes(s)), "provider_scope_changed", 401);
    const fingerprint = await hash(
      JSON.stringify({
        time_range: input.time_range,
        timezone: input.timezone,
        page_size: input.page_size,
        scopes: connection.scopes,
      }),
    );
    let state: State = {
      fingerprint,
      grant: connection.grant_id,
      calendars: [],
      directory: null,
      started: false,
      seen: [],
      pages: [],
      offset: 0,
      version: null,
      unavailable: [],
      expires: this.now() + 600000,
    };
    if (input.cursor) {
      const decoded = stateSchema.safeParse(
        await this.vault.open(
          input.cursor,
          aad(p, "agenda-cursor", connection.grant_id),
        ),
      );
      assert(
        decoded.success &&
          decoded.data.expires > this.now() &&
          decoded.data.fingerprint === fingerprint &&
          decoded.data.grant === connection.grant_id,
        "invalid_cursor",
      );
      state = decoded.data;
    }
    const start = Date.parse(input.time_range.start),
      end = Date.parse(input.time_range.end);
    let directoryReads = 0,
      eventReads = 0;
    const errors: { calendar_id: string; error: string }[] = [];
    let events: Record<string, unknown>[] = [];
    while (eventReads < 5) {
      if (!state.calendars.length) {
        if (state.started && !state.directory) break;
        if (directoryReads >= 1) break;
        const auth = await this.link.access(p, state.grant);
        const raw = await this.api.calendars(
          auth.token,
          state.directory ?? undefined,
        );
        directoryReads++;
        const directory = z
          .object({
            calendar_list: z.array(z.object({ calendar_id: id })).max(50),
            has_more: z.boolean(),
            page_token: z.string().max(2000).optional(),
          })
          .safeParse(raw);
        assert(directory.success, "provider_invalid_response", 502);
        if (directory.data.has_more) {
          assert(directory.data.page_token, "provider_invalid_response", 502);
          const pageHash = await hash(directory.data.page_token);
          assert(
            !state.pages.includes(pageHash) && state.pages.length < 20,
            "provider_cursor_cycle",
            502,
          );
          state.pages.push(pageHash);
          state.directory = directory.data.page_token;
        } else state.directory = null;
        for (const calendar of directory.data.calendar_list) {
          const calendarHash = await hash(calendar.calendar_id);
          assert(
            !state.seen.includes(calendarHash),
            "provider_duplicate_calendar",
            502,
          );
          assert(state.seen.length < 20, "calendar_budget_exceeded", 422);
          state.seen.push(calendarHash);
          state.calendars.push(calendar.calendar_id);
        }
        state.started = true;
        await this.store.current(p, state.grant);
        if (!state.calendars.length) break;
      }
      const calendar = state.calendars[0]!;
      eventReads++;
      try {
        const auth = await this.link.access(p, state.grant);
        const raw = await this.api.instances(auth.token, calendar, start, end);
        assert(
          (raw.has_more === undefined || raw.has_more === false) &&
            (raw.page_token === undefined || raw.page_token === ""),
          "provider_unexpected_pagination",
          502,
        );
        assert(
          Array.isArray(raw.items) && raw.items.length <= 200,
          "instance_budget_exceeded",
          422,
        );
        const items = z
          .array(event)
          .safeParse(
            raw.items.filter(
              (v: unknown) =>
                !(
                  v &&
                  typeof v === "object" &&
                  "status" in v &&
                  v.status === "cancelled"
                ),
            ),
          );
        assert(items.success, "provider_invalid_response", 502);
        const normalized = items.data
          .map((item) => {
            const from = millis(item.start_time),
              to = millis(item.end_time);
            assert(
              Number.isSafeInteger(from) &&
                Number.isSafeInteger(to) &&
                to > from,
              "provider_invalid_time",
              502,
            );
            return {
              calendar_id: calendar,
              event_id: item.event_id,
              summary: item.summary ?? "",
              start: item.start_time,
              end: item.end_time,
              status: item.status ?? null,
            };
          })
          .filter(
            (item) => millis(item.start) < end && millis(item.end) > start,
          );
        assert(
          new Set(normalized.map((item) => item.event_id)).size ===
            normalized.length,
          "provider_duplicate_instance",
          502,
        );
        const version = await hash(JSON.stringify(normalized));
        assert(
          state.version === null || state.version === version,
          "agenda_changed_restart",
          409,
        );
        assert(state.offset <= normalized.length, "invalid_cursor");
        events = normalized.slice(state.offset, state.offset + input.page_size);
        state.offset += events.length;
        state.version = version;
        if (state.offset >= normalized.length) {
          state.calendars.shift();
          state.offset = 0;
          state.version = null;
        }
        await this.store.current(p, state.grant);
        if (events.length) break;
      } catch (e) {
        if (!(e instanceof AppError) || ![403, 404].includes(e.status)) throw e;
        state.unavailable.push(calendar);
        errors.push({ calendar_id: calendar, error: e.code });
        state.calendars.shift();
        state.offset = 0;
        state.version = null;
      }
    }
    await this.store.current(p, state.grant);
    const more = Boolean(
      state.calendars.length || state.directory || !state.started,
    );
    const cursor = more
      ? await this.vault.seal(state, aad(p, "agenda-cursor", state.grant))
      : null;
    assert(!cursor || cursor.length <= 6000, "cursor_budget_exceeded", 422);
    const result = {
      events,
      timezone: input.timezone,
      next_cursor: cursor,
      partial: more || state.unavailable.length > 0,
      traversal_complete: !more,
      unavailable_calendar_ids: state.unavailable,
      errors,
      ordering: "calendar_then_provider_order",
      time_encoding: "provider_timestamp_or_all_day_date",
      all_day_filter_basis: "UTC",
      source: "feishu_api",
      live_verified: false,
      content_trust: "untrusted_source_data",
    };
    assert(
      new TextEncoder().encode(JSON.stringify(result)).length <= 40000,
      "output_budget_exceeded",
      422,
    );
    return result;
  }
}
