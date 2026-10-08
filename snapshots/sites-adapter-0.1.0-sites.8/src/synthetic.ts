import { agendaInput } from "./agenda.ts";
import { assert, random, type Database, type Principal } from "./security.ts";

export const SYNTHETIC_NOTICE =
  "仅合成演示：以下日程为虚构测试数据，未连接或读取飞书账户。";

export async function syntheticAgenda(
  db: Database,
  p: Principal,
  args: unknown,
) {
  const parsed = agendaInput.safeParse(args);
  assert(parsed.success);
  assert(parsed.data.cursor === undefined, "synthetic_cursor_not_supported");
  const row = await db
    .prepare(
      "INSERT INTO synthetic_state(site,user_id,fixture_id) VALUES(?,?,?) ON CONFLICT(site,user_id) DO UPDATE SET fixture_id=synthetic_state.fixture_id RETURNING fixture_id",
    )
    .bind(p.site, p.user, random())
    .first<{ fixture_id: string }>();
  assert(row, "storage_unavailable", 503);
  const start = Date.parse(parsed.data.time_range.start);
  return {
    source: "synthetic_fixture",
    live_verified: false,
    notice: SYNTHETIC_NOTICE,
    events: [
      {
        event_id: "synthetic_" + row.fixture_id,
        summary: "[合成演示] 虚构日程",
        start: new Date(start).toISOString(),
        end: new Date(
          Math.min(Date.parse(parsed.data.time_range.end), start + 3600000),
        ).toISOString(),
        timezone: parsed.data.timezone,
      },
    ],
    partial: false,
    coverage: "synthetic_fixture_only",
    next_cursor: null,
  };
}
