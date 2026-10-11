import { assert, AppError, boundedText } from "./security.ts";
import type { Fetcher } from "./feishu.ts";
import { timeRange } from "./extended-reads.ts";
class WriteFailure extends AppError {
  constructor(
    code: string,
    readonly uncertain: boolean,
    readonly provider_code?: number,
  ) {
    super(code, 502);
  }
}
export type WriteReceipt = {
  status: "succeeded" | "pending" | "failed" | "partial" | "unknown";
  operation: string;
  effects: Record<string, unknown>[];
  error?: string;
  provider_code?: number;
  retry_safe: false;
  source: "feishu_api";
};
export class WriteProvider {
  constructor(
    private transport: Fetcher,
    private now = Date.now,
    private beforeCall: () => Promise<void> = async () => {},
  ) {}
  private async call(
    token: string,
    path: string,
    method = "GET",
    body?: unknown,
  ) {
    await this.beforeCall();
    let r: Response;
    try {
      r = await this.transport("https://open.feishu.cn/open-apis" + path, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new WriteFailure("provider_result_unknown", method !== "GET");
    }
    let raw: any;
    try {
      raw = JSON.parse(await boundedText(r, 1048576));
    } catch {
      throw new WriteFailure("provider_result_unknown", method !== "GET");
    }
    if (!r.ok || raw?.code !== 0)
      throw new WriteFailure(
        r.status >= 500
          ? "provider_result_unknown"
          : "provider_operation_rejected",
        r.status >= 500 || (r.status >= 300 && r.status < 400),
        typeof raw?.code === "number" ? raw.code : undefined,
      );
    if (!raw.data || typeof raw.data !== "object" || Array.isArray(raw.data))
      throw new WriteFailure("provider_result_unknown", method !== "GET");
    return raw.data;
  }
  private eventPath(a: Record<string, any>, eventId?: string) {
    return (
      `/calendar/v4/calendars/${encodeURIComponent(a.calendar_id)}/events` +
      (eventId ? "/" + encodeURIComponent(eventId) : "")
    );
  }
  private eventBody(a: Record<string, any>) {
    return {
      ...(a.summary !== undefined ? { summary: a.summary } : {}),
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(a.time_range
        ? {
            start_time: {
              timestamp: String(Date.parse(a.time_range.start) / 1000),
              timezone: a.timezone,
            },
            end_time: {
              timestamp: String(Date.parse(a.time_range.end) / 1000),
              timezone: a.timezone,
            },
          }
        : {}),
    };
  }
  private blocks(text: string) {
    return text
      .split("\n")
      .map((content) => ({
        block_type: 2,
        text: { elements: [{ text_run: { content } }] },
      }));
  }
  async inspectBooking(token: string, a: Record<string, any>) {
    assert(
      Date.parse(a.time_range.end) > this.now(),
      "booking_time_in_past",
      422,
    );
    if (a.event_id) {
      const data = await this.call(token, this.eventPath(a, a.event_id));
      const e = data.event;
      assert(
        e?.event_id === a.event_id &&
          e.summary === a.summary &&
          String(e.start_time?.timestamp) ===
            String(Date.parse(a.time_range.start) / 1000) &&
          String(e.end_time?.timestamp) ===
            String(Date.parse(a.time_range.end) / 1000),
        "event_time_changed",
        409,
      );
    }
    const data = await this.call(token, "/calendar/v4/freebusy/list", "POST", {
      room_id: a.room_id,
      time_min: a.time_range.start,
      time_max: a.time_range.end,
      only_busy: true,
    });
    assert(
      Array.isArray(data.freebusy_list) &&
        data.freebusy_list.every(
          (v: any) =>
            timeRange.safeParse({ start: v?.start_time, end: v?.end_time })
              .success,
        ),
      "room_availability_unknown",
      422,
    );
    assert(
      !data.freebusy_list.some(
        (v: any) =>
          Date.parse(v.start_time) < Date.parse(a.time_range.end) &&
          Date.parse(v.end_time) > Date.parse(a.time_range.start),
      ),
      "room_unavailable",
      409,
    );
  }
  async bookingStatus(token: string, a: Record<string, any>, event_id: string) {
    let pageToken: string | undefined;
    let room: any;
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const data = await this.call(
        token,
        this.eventPath(a, event_id) +
          "/attendees?page_size=100" +
          (pageToken ? "&page_token=" + encodeURIComponent(pageToken) : ""),
      );
      assert(Array.isArray(data.items), "provider_receipt_incomplete", 502);
      room = data.items.find(
        (v: any) => v.type === "resource" && v.room_id === a.room_id,
      );
      if (room || data.has_more === false) break;
      assert(
        data.has_more === true &&
          typeof data.page_token === "string" &&
          !seen.has(data.page_token),
        "provider_receipt_incomplete",
        502,
      );
      seen.add(data.page_token);
      pageToken = data.page_token;
    }
    return room?.rsvp_status === "accept"
      ? "reserved"
      : room?.rsvp_status === "decline"
        ? "declined"
        : room?.rsvp_status === "removed"
          ? "removed"
          : room?.rsvp_status === "needs_action" ||
              room?.rsvp_status === "tentative"
            ? "pending"
            : "unknown";
  }
  async execute(
    token: string,
    operation: string,
    a: Record<string, any>,
    requestId: string,
  ): Promise<WriteReceipt> {
    const effects: Record<string, unknown>[] = [];
    let status: WriteReceipt["status"] = "succeeded";
    try {
      if (operation === "send_message" || operation === "reply_message") {
        const data = await this.call(
          token,
          operation === "send_message"
            ? `/im/v1/messages?receive_id_type=${a.receive_id_type}`
            : `/im/v1/messages/${a.message_id}/reply`,
          "POST",
          {
            msg_type: "text",
            content: JSON.stringify({ text: a.text }),
            uuid: requestId,
            ...(operation === "send_message"
              ? { receive_id: a.receive_id }
              : { reply_in_thread: a.reply_in_thread }),
          },
        );
        assert(
          typeof data.message_id === "string",
          "provider_receipt_incomplete",
          502,
        );
        effects.push({ message_id: data.message_id });
      } else if (operation === "create_doc") {
        const data = await this.call(token, "/docx/v1/documents", "POST", {
          title: a.title,
          ...(a.folder_token ? { folder_token: a.folder_token } : {}),
        });
        const document_id = data.document?.document_id;
        assert(
          typeof document_id === "string" &&
            /^[A-Za-z0-9_-]{1,128}$/.test(document_id),
          "provider_receipt_incomplete",
          502,
        );
        effects.push({ document_id, step: "created" });
        const blocks = this.blocks(a.text);
        assert(blocks.length <= 50, "document_block_limit", 422);
        await this.call(
          token,
          `/docx/v1/documents/${document_id}/blocks/${document_id}/children?document_revision_id=-1`,
          "POST",
          { children: blocks, index: -1 },
        );
        effects.push({ document_id, step: "content_added" });
      } else if (operation === "update_doc") {
        const q = `?document_revision_id=${a.revision}`;
        if (a.mode === "append")
          await this.call(
            token,
            `/docx/v1/documents/${a.document_id}/blocks/${a.document_id}/children${q}`,
            "POST",
            { children: this.blocks(a.text), index: -1 },
          );
        else
          await this.call(
            token,
            `/docx/v1/documents/${a.document_id}/blocks/${a.block_id}${q}`,
            "PATCH",
            {
              update_text_elements: {
                elements: [{ text_run: { content: a.text } }],
              },
            },
          );
        effects.push({ document_id: a.document_id, mode: a.mode });
      } else if (operation === "add_doc_comment") {
        const data = await this.call(
          token,
          `/drive/v1/files/${a.document_id}/comments?file_type=docx&user_id_type=open_id`,
          "POST",
          {
            reply_list: {
              replies: [
                {
                  content: {
                    elements: [
                      { type: "text_run", text_run: { text: a.text } },
                    ],
                  },
                },
              ],
            },
          },
        );
        assert(
          typeof data.comment_id === "string",
          "provider_receipt_incomplete",
          502,
        );
        effects.push({
          document_id: a.document_id,
          comment_id: data.comment_id,
        });
      } else if (
        operation === "create_base_record" ||
        operation === "update_base_record"
      ) {
        const data = await this.call(
          token,
          `/bitable/v1/apps/${a.token}/tables/${a.table_id}/records` +
            (a.record_id ? "/" + a.record_id : "") +
            "?user_id_type=open_id",
          operation === "create_base_record" ? "POST" : "PUT",
          { fields: a.fields },
        );
        assert(
          typeof data.record?.record_id === "string" &&
            (!a.record_id || data.record.record_id === a.record_id),
          "provider_receipt_incomplete",
          502,
        );
        effects.push({
          record_id: data.record.record_id,
          fields: data.record.fields,
        });
      } else if (operation === "create_task") {
        const data = await this.call(
          token,
          "/task/v2/tasks?user_id_type=open_id",
          "POST",
          {
            summary: a.summary,
            ...(a.description !== undefined
              ? { description: a.description }
              : {}),
            ...(a.due ? { due: a.due } : {}),
            members: a.assignee_ids.map((id: string) => ({
              id,
              type: "user",
              role: "assignee",
            })),
            client_token: requestId,
          },
        );
        assert(
          typeof data.task?.guid === "string",
          "provider_receipt_incomplete",
          502,
        );
        effects.push({ task_guid: data.task.guid });
      } else if (operation === "update_task" || operation === "complete_task") {
        const task =
          operation === "complete_task"
            ? { completed_at: String(this.now()) }
            : Object.fromEntries(
                ["summary", "description", "due"]
                  .filter((k) => a[k] !== undefined)
                  .map((k) => [k, a[k]]),
              );
        const data = await this.call(
          token,
          `/task/v2/tasks/${a.task_guid}?user_id_type=open_id`,
          "PATCH",
          { task, update_fields: Object.keys(task) },
        );
        assert(
          data.task?.guid === a.task_guid,
          "provider_receipt_incomplete",
          502,
        );
        effects.push({
          task_guid: a.task_guid,
          updated_fields: Object.keys(task),
        });
      } else if (operation === "respond_event") {
        await this.call(
          token,
          this.eventPath(a, a.event_id) + "/reply",
          "POST",
          { rsvp_status: a.rsvp_status },
        );
        effects.push({ event_id: a.event_id, rsvp_status: a.rsvp_status });
      } else if (operation === "update_event") {
        const data = await this.call(
          token,
          this.eventPath(a, a.event_id),
          "PATCH",
          this.eventBody(a),
        );
        assert(
          data.event?.event_id === a.event_id,
          "provider_receipt_incomplete",
          502,
        );
        effects.push({ event_id: a.event_id });
      } else if (
        operation === "create_event" ||
        operation === "book_meeting_room"
      ) {
        if (operation === "book_meeting_room")
          await this.inspectBooking(token, a);
        let event_id = a.event_id;
        if (!event_id) {
          const data = await this.call(
            token,
            this.eventPath(a) + `?idempotency_key=${requestId}`,
            "POST",
            this.eventBody(a),
          );
          event_id = data.event?.event_id;
          assert(
            typeof event_id === "string",
            "provider_receipt_incomplete",
            502,
          );
          effects.push({ event_id, step: "event_created" });
        }
        const attendees = a.attendee_ids.map((user_id: string) => ({
          type: "user",
          user_id,
        }));
        if (operation === "book_meeting_room")
          attendees.push({
            type: "resource",
            room_id: a.room_id,
            ...(a.approval_reason
              ? { approval_reason: a.approval_reason }
              : {}),
          });
        if (attendees.length) {
          const data = await this.call(
            token,
            this.eventPath(a, event_id) + "/attendees?user_id_type=open_id",
            "POST",
            { attendees, add_operator_to_attendee: false },
          );
          assert(
            Array.isArray(data.attendees),
            "provider_receipt_incomplete",
            502,
          );
          effects.push({ event_id, step: "attendees_submitted" });
        }
        if (operation === "book_meeting_room") {
          // The create response alone is not proof of a room reservation. Read the actual resource RSVP.
          const booking = await this.bookingStatus(token, a, event_id);
          effects.push({
            event_id,
            room_id: a.room_id,
            booking_status: booking,
          });
          status =
            booking === "reserved"
              ? "succeeded"
              : booking === "pending"
                ? "pending"
                : booking === "unknown"
                  ? "unknown"
                  : "partial";
        }
      } else assert(false, "write_or_unknown_tool_denied", 403);
    } catch (e) {
      const uncertain =
        e instanceof WriteFailure
          ? e.uncertain
          : e instanceof AppError && e.status === 502;
      return {
        operation,
        status: uncertain ? "unknown" : effects.length ? "partial" : "failed",
        effects,
        error: e instanceof AppError ? e.code : "provider_result_unknown",
        ...(e instanceof WriteFailure && e.provider_code !== undefined
          ? { provider_code: e.provider_code }
          : {}),
        retry_safe: false,
        source: "feishu_api",
      };
    }
    return {
      operation,
      status,
      effects,
      retry_safe: false,
      source: "feishu_api",
    };
  }
}
