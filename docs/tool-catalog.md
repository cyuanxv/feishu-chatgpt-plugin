# Tool traceability

The accepted PRD enumerates **30 tools**, despite its “29 tools” heading. All thirty appear below. The 17 reads are implemented against synthetic data only. The 13 writes are intentionally not registered.

| Tool | PRD milestone | Logical scope | Current evidence |
| --- | --- | --- | --- |
| get_profile | M5 | profile.read | Mock handler, input/output contract, automated test |
| search | M7 | search.read | Mock handler, input/output contract, automated test |
| fetch | M7 | search.read | Mock handler, input/output contract, automated test |
| search_people | M8 | people.read | Mock handler, input/output contract, automated test |
| list_chats | M9 | im.read | Mock handler, input/output contract, automated test |
| search_messages | M9 | im.read | Mock handler, input/output contract, automated test |
| get_message_thread | M9 | im.read | Mock handler, input/output contract, automated test |
| list_doc_comments | M7 / P1 | docs.read | Mock handler, input/output contract, automated test |
| list_bases | M10 | base.read | Mock handler, input/output contract, automated test |
| get_base_schema | M10 | base.read | Mock handler, input/output contract, automated test |
| query_base_records | M10 | base.read | Mock handler, input/output contract, automated test |
| get_agenda | M11 | calendar.read | Mock handler, input/output contract, automated test |
| get_free_busy | M11 | calendar.read | Mock handler, input/output contract, automated test |
| suggest_meeting_times | M11 | calendar.read | Mock handler, input/output contract, automated test |
| list_meeting_rooms | M11 / P1 | calendar.read | Mock handler, input/output contract, automated test |
| list_tasks | M12 | task.read | Mock handler, input/output contract, automated test |
| get_task | M12 | task.read | Mock handler, input/output contract, automated test |
| send_message | M14 | Not enabled | Not registered; rejection test |
| reply_message | M14 | Not enabled | Not registered; rejection test |
| create_doc | M15 | Not enabled | Not registered; rejection test |
| update_doc | M15 | Not enabled | Not registered; rejection test |
| add_doc_comment | M15 / P1 | Not enabled | Not registered; rejection test |
| create_base_record | M16 | Not enabled | Not registered; rejection test |
| update_base_record | M16 | Not enabled | Not registered; rejection test |
| create_event | M17 | Not enabled | Not registered; rejection test |
| update_event | M17 | Not enabled | Not registered; rejection test |
| respond_event | M17 / P1 | Not enabled | Not registered; rejection test |
| create_task | M18 | Not enabled | Not registered; rejection test |
| update_task | M18 | Not enabled | Not registered; rejection test |
| complete_task | M18 | Not enabled | Not registered; rejection test |

Logical scopes are internal application capabilities, not actual Feishu Open Platform permission names. A live scope mapper is not implemented. The profile and search scopes alone never grant document/message/calendar/task content.

Tool outputs are structured validated envelopes. The current output schema validates envelope integrity and JSON data; domain-specific output schemas and live provider contract fixtures remain future hardening work. All source bodies are untrusted data.

## Provider message-search filters (dev.10)

The internal provider `search` workflow accepts `owner`, `chat_id` and `time_range` only with explicit `types: ["message"]`. `owner` means sender open ID, not document creator. The time window must use whole-second boundaries (including `.000Z`); fractional-second bounds are rejected rather than silently rounded. The accepted window is serialized into the existing IM search API in Unix seconds. Provider-side boundary inclusion and returned timestamp units remain unverified against a real tenant. Queries remain offset-aware and bounded to 366 days; no new endpoint or permission is used. Filtered cursors bind all three constraints, query, page size, selected domains, connection and scope set. Unsupported mixed-domain filters fail before transport. These behaviors are tested with injected synthetic transport, not a real account. The HTTP listener remains synthetic.
