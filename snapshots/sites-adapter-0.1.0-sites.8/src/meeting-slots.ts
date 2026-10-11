import { assert } from "./security.ts";
/** Half-open intervals; an omitted or malformed person's availability never means free. */
export function meetingSlots(
  start: string,
  end: string,
  durationMinutes: number,
  stepMinutes: number,
  people: {
    user_id: string;
    busy: { start_time: string; end_time: string }[];
  }[],
  limit = 10,
) {
  const from = Date.parse(start),
    to = Date.parse(end),
    duration = durationMinutes * 60000,
    step = stepMinutes * 60000;
  assert(
    Number.isFinite(from) &&
      Number.isFinite(to) &&
      to > from &&
      to - from <= 31 * 86400000,
  );
  assert(
    Number.isInteger(durationMinutes) &&
      durationMinutes >= 5 &&
      durationMinutes <= 480 &&
      Number.isInteger(stepMinutes) &&
      stepMinutes >= 5 &&
      stepMinutes <= 120,
  );
  assert(
    people.length > 0 &&
      people.length <= 20 &&
      new Set(people.map((p) => p.user_id)).size === people.length,
  );
  const busy = people.flatMap((p) => {
    assert(Array.isArray(p.busy), "availability_unknown", 422);
    return p.busy.map((b) => {
      const s = Date.parse(b.start_time),
        e = Date.parse(b.end_time);
      assert(
        Number.isFinite(s) && Number.isFinite(e) && e > s,
        "availability_unknown",
        422,
      );
      return [s, e] as const;
    });
  });
  const slots = [];
  for (let t = from; t + duration <= to && slots.length < limit; t += step) {
    if (!busy.some(([s, e]) => s < t + duration && e > t))
      slots.push({
        start: new Date(t).toISOString(),
        end: new Date(t + duration).toISOString(),
      });
  }
  return {
    slots,
    coverage: "requested_people_primary_calendars",
    selection_required: true,
  };
}
