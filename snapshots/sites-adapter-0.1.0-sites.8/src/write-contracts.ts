import { z } from "zod";
import { assert } from "./security.ts";
import { timeRange } from "./extended-reads.ts";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const calendar = z.string().regex(/^[A-Za-z0-9_.@+-]{1,256}$/).refine(v => v !== "." && v !== "..");
const text = z.string().min(1).max(20000);
const documentText = text.refine(
  (v) => v.split("\n").length <= 50,
  "At most 50 paragraphs per write",
);
const fields = z
  .record(z.string().min(1).max(200), z.unknown())
  .refine(
    (v) =>
      Object.keys(v).length > 0 &&
      Object.keys(v).length <= 50 &&
      JSON.stringify(v).length <= 30000,
  );
const due = z
  .object({
    timestamp: z.string().regex(/^\d{13}$/),
    is_all_day: z.boolean().default(false),
  })
  .strict();
const people = z.array(z.string().regex(/^ou_[A-Za-z0-9_-]+$/)).max(50);
const eventFields = {
  summary: z.string().min(1).max(1000),
  description: z.string().max(10000).optional(),
  time_range: timeRange,
  timezone: z
    .string()
    .max(80)
    .refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }),
};
export const WRITE_SCHEMAS: Record<string, z.ZodType> = {
  send_message: z
    .object({
      receive_id: id,
      receive_id_type: z.enum(["open_id", "chat_id"]),
      text,
    })
    .strict(),
  reply_message: z
    .object({
      message_id: id,
      text,
      reply_in_thread: z.boolean().default(true),
    })
    .strict(),
  create_doc: z
    .object({
      title: z.string().min(1).max(200),
      folder_token: id.optional(),
      text: documentText,
    })
    .strict(),
  update_doc: z
    .object({
      document_id: id,
      mode: z.enum(["append", "replace_block"]),
      block_id: id.optional(),
      revision: z.number().int().min(0),
      text: documentText,
    })
    .strict()
    .refine(
      (v) => v.mode === "append" || !!v.block_id,
      "replace_block requires block_id",
    ),
  add_doc_comment: z.object({ document_id: id, text }).strict(),
  create_base_record: z.object({ token: id, table_id: id, fields }).strict(),
  update_base_record: z
    .object({ token: id, table_id: id, record_id: id, fields })
    .strict(),
  create_event: z
    .object({
      calendar_id: calendar,
      ...eventFields,
      attendee_ids: people.default([]),
    })
    .strict(),
  update_event: z
    .object({
      calendar_id: calendar,
      event_id: id,
      summary: eventFields.summary.optional(),
      description: eventFields.description,
      time_range: timeRange.optional(),
      timezone: eventFields.timezone.optional(),
    })
    .strict()
    .refine(
      (v) =>
        v.summary !== undefined ||
        v.description !== undefined ||
        v.time_range !== undefined,
    )
    .refine(
      (v) => !!v.time_range === !!v.timezone,
      "Time changes require both time_range and timezone",
    ),
  cancel_event: z.object({ calendar_id: calendar, event_id: id, summary: eventFields.summary, time_range: timeRange, timezone: eventFields.timezone, room_id: z.string().regex(/^omm_[A-Za-z0-9_-]+$/).optional(), need_notification: z.boolean().default(true) }).strict(),
  respond_event: z
    .object({
      calendar_id: calendar,
      event_id: id,
      rsvp_status: z.enum(["accept", "decline", "tentative"]),
    })
    .strict(),
  create_task: z
    .object({
      summary: z.string().min(1).max(1000),
      description: z.string().max(10000).optional(),
      due: due.optional(),
      assignee_ids: people.default([]),
    })
    .strict(),
  update_task: z
    .object({
      task_guid: id,
      summary: z.string().min(1).max(1000).optional(),
      description: z.string().max(10000).optional(),
      due: due.optional(),
    })
    .strict()
    .refine(
      (v) =>
        v.summary !== undefined ||
        v.description !== undefined ||
        v.due !== undefined,
    ),
  complete_task: z.object({ task_guid: id }).strict(),
  book_meeting_room: z
    .object({
      calendar_id: calendar,
      event_id: id.optional(),
      room_id: z.string().regex(/^omm_[A-Za-z0-9_-]+$/),
      ...eventFields,
      attendee_ids: people.default([]),
      approval_reason: z.string().min(1).max(1000).optional(),
    })
    .strict()
    .refine(
      (v) => !v.event_id || v.description === undefined,
      "Booking an existing event does not change its description",
    ),
};
// Each inner array is an alternative group; every group must be granted.
export const WRITE_REQUIREMENTS: Record<string, string[][]> = {
  send_message: [["im:message.send_as_user", "im:message"]],
  reply_message: [["im:message.send_as_user", "im:message"]],
  create_doc: [
    ["docx:document:create"],
    ["docx:document:write_only", "docx:document"],
  ],
  update_doc: [["docx:document:write_only", "docx:document"]],
  add_doc_comment: [["docs:document.comment:create"]],
  create_base_record: [["bitable:app", "base:record:create"]],
  update_base_record: [["bitable:app", "base:record:update"]],
  create_event: [["calendar:calendar.event:create", "calendar:calendar"]],
  update_event: [["calendar:calendar.event:update", "calendar:calendar"]],
  cancel_event: [["calendar:calendar.event:delete", "calendar:calendar"], ["calendar:calendar.event:read", "calendar:calendar:readonly", "calendar:calendar"]],
  respond_event: [["calendar:calendar.event:reply", "calendar:calendar"]],
  create_task: [["task:task:write", "task:task:writeonly"]],
  update_task: [["task:task:write", "task:task:writeonly"]],
  complete_task: [["task:task:write", "task:task:writeonly"]],
  book_meeting_room: [
    ["calendar:calendar.event:create", "calendar:calendar"],
    ["calendar:calendar.event:update", "calendar:calendar"],
    [
      "calendar:calendar.event:read",
      "calendar:calendar:readonly",
      "calendar:calendar",
    ],
    [
      "calendar:calendar.free_busy:read",
      "calendar:calendar:readonly",
      "calendar:calendar",
    ],
  ],
};
export const WRITE_SCOPES = [
  ...new Set(Object.values(WRITE_REQUIREMENTS).flat(2)),
];
export function writeInput(operation: string, input: unknown) {
  const schema = WRITE_SCHEMAS[operation];
  assert(schema, "write_or_unknown_tool_denied", 403);
  const parsed = schema.safeParse(input);
  assert(parsed.success);
  return parsed.data as Record<string, any>;
}
export function writeRequirements(operation: string, a: Record<string, any>) {
  let r = WRITE_REQUIREMENTS[operation]!.map((g) => [...g]);
  if (operation === "book_meeting_room" && a.event_id) r = r.slice(1);
  if (operation === "create_event" && a.attendee_ids.length)
    r.push(["calendar:calendar.event:update", "calendar:calendar"]);
  if (operation === "cancel_event" && a.room_id) r.push(["calendar:calendar.free_busy:read", "calendar:calendar:readonly", "calendar:calendar"]);
  return r;
}
export const WRITE_TOOLS = Object.entries(WRITE_SCHEMAS).map(
  ([name, schema]) => ({
    name,
    description: `Prepare ${name} for user review. Does not execute the action. Returns a private confirmation page; the user must review and confirm there. Do not call the confirmation endpoint or claim success before the final receipt. All recipients and resource IDs must be explicitly selected. Open IDs are application-scoped: use the connection_id that resolved the recipients; never reuse them through another app. For update_doc first query docx_metadata for revision, then docx_blocks to select a block.`,
    inputSchema: {
      type: "object",
      properties: {
        connection_id: { type: "string", maxLength: 80 },
        request_id: { type: "string", format: "uuid" },
        parameters: z.toJSONSchema(schema),
      },
      required: ["request_id", "parameters"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: [
        "update_doc",
        "update_base_record",
        "update_event",
        "cancel_event",
        "update_task",
        "complete_task",
      ].includes(name),
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
);
export const WRITE_STATUS_TOOL = {
  name: "get_write_status",
  description:
    "Read a prepared write intent and its receipt. refresh=true rechecks room approval using read-only provider requests; it never resubmits the booking. Does not execute or confirm a write.",
  inputSchema: {
    type: "object",
    properties: {
      intent_id: { type: "string", maxLength: 100 },
      refresh: { type: "boolean" },
    },
    required: ["intent_id"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};
