import { randomUUID } from 'node:crypto';
import { inputSchemas, outputSchema, scopeForTool, type ReadToolName } from '../../schemas/src/catalog.js';
import { DomainError, digest, Handles, RateLimiter, requireScope, type Identity } from '../../policy/src/core.js';
import { auditEvent, silentAudit, type AuditSink } from '../../observability/src/audit.js';
import type { ReadAdapter, WorkspaceData, CalendarEvent } from '../../feishu/src/adapter.js';

type Params = Record<string, unknown>;
type Payload = { data: Record<string, unknown>; next_cursor?: string | null; partial?: boolean };
const text = (args: Params, key: string): string => args[key] as string;
const optionalText = (args: Params, key: string): string | undefined => args[key] as string | undefined;
const includes = (haystack: string, needle: string): boolean => haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
type Range = { start: string; end: string };
const overlaps = (event: { start: string; end: string }, range: Range): boolean => Date.parse(event.start) < Date.parse(range.end) && Date.parse(event.end) > Date.parse(range.start);
const inRange = (value: string, range?: Range): boolean => !range || (Date.parse(value) >= Date.parse(range.start) && Date.parse(value) < Date.parse(range.end));
const localTime = (iso: string, timezone: string): string => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
const required = <T>(value: T | undefined, label: string): T => { if (value === undefined) throw new DomainError('NOT_FOUND', `${label} is not visible to this connection.`); return value; };

export class ToolEngine {
  constructor(private readonly adapter: ReadAdapter, private readonly handles: Handles, private readonly audit: AuditSink = silentAudit, private readonly limiter = new RateLimiter()) {}
  async call(name: string, input: unknown, identity: Identity): Promise<ReturnType<typeof outputSchema.parse>> {
    const started = Date.now(); const requestId = randomUUID();
    const base = { request_id: requestId, identity: 'user' as const, connection_hash: digest(identity.connectionId).slice(0, 16), source: 'synthetic_mock' as const, next_cursor: null as string | null, partial: false };
    try {
      if (!Object.hasOwn(inputSchemas, name)) throw new DomainError('UNSUPPORTED_CAPABILITY', 'This tool is not enabled in the read-only development build.');
      const tool = name as ReadToolName;
      const parsed = inputSchemas[tool].safeParse(input);
      if (!parsed.success) throw new DomainError('INVALID_ARGUMENT', 'Arguments do not match the tool schema.');
      requireScope(identity, scopeForTool[tool]);
      this.limiter.check(JSON.stringify([identity.tenantId, identity.subject, identity.connectionId, name]));
      const data = await this.adapter.read(identity);
      const payload = this.execute(tool, parsed.data as Params, identity, data);
      const result = outputSchema.parse({ ok: true, data: payload.data, meta: { ...base, next_cursor: payload.next_cursor ?? null, partial: payload.partial ?? false } });
      this.log(auditEvent(requestId, name, identity.connectionId, 'ok', Date.now() - started));
      return result;
    } catch (error) {
      const safe = error instanceof DomainError ? error : new DomainError('UPSTREAM_ERROR', 'The request could not be completed.');
      this.log(auditEvent(requestId, Object.hasOwn(inputSchemas, name) ? name : 'unknown_tool', identity.connectionId, 'error', Date.now() - started, safe.type));
      return outputSchema.parse({ ok: false, error: { type: safe.type, message: safe.message, ...(safe.requiredScope ? { required_scope: safe.requiredScope } : {}) }, meta: base });
    }
  }
  private log(event: Parameters<AuditSink>[0]): void { try { this.audit(event); } catch { /* Logging failures must not reveal source data or interrupt reads. */ } }
  private page<T>(name: string, values: T[], args: Params, identity: Identity, field: string): Payload {
    const { cursor, ...query } = args;
    const paginated = this.handles.paginate(values, identity, { tool: name, ...query }, Number(args.page_size ?? 20), cursor as string | undefined);
    return { data: { [field]: paginated.items }, next_cursor: paginated.next_cursor };
  }
  private execute(name: ReadToolName, args: Params, identity: Identity, workspace: WorkspaceData): Payload {
    switch (name) {
      case 'get_profile': return { data: { display_name: workspace.people[0]!.name, domain: identity.domain, connection_id: identity.connectionId, granted_scopes: identity.scopes, mode: 'synthetic_mock', read_only: true } };
      case 'search': return this.search(args, identity, workspace);
      case 'fetch': return this.fetch(args, identity, workspace);
      case 'search_people': {
        const candidates = workspace.people.filter(person => includes(`${person.name} ${person.email}`, text(args, 'query')));
        const page = this.page(name, candidates, args, identity, 'people');
        return { ...page, data: { ...page.data, ambiguous: candidates.length > 1 } };
      }
      case 'list_chats': return this.page(name, workspace.chats.filter(chat => !args.query || includes(chat.name, text(args, 'query'))), args, identity, 'chats');
      case 'search_messages': return this.page(name, workspace.messages.filter(message => includes(message.text, text(args, 'query')) && (!args.chat_id || message.chat_id === args.chat_id) && (!args.sender_open_id || message.sender_open_id === args.sender_open_id) && inRange(message.created_at, args.time_range as Range | undefined)), args, identity, 'messages');
      case 'get_message_thread': {
        const message = required(workspace.messages.find(item => item.message_id === args.message_id), 'Message');
        return this.page(name, workspace.messages.filter(item => item.thread_id === message.thread_id && item.chat_id === message.chat_id), args, identity, 'messages');
      }
      case 'list_doc_comments': return this.page(name, required(workspace.documents.find(doc => doc.doc_id === args.doc_id), 'Document').comments, args, identity, 'comments');
      case 'list_bases': return this.page(name, workspace.bases.filter(base => !args.query || includes(base.name, text(args, 'query'))).map(base => ({ base_id: base.base_id, name: base.name })), args, identity, 'bases');
      case 'get_base_schema': {
        let baseId = args.base_id;
        if (args.base_ref) {
          const ref = this.handles.decode('resource', identity, text(args, 'base_ref'));
          if (ref.type !== 'base' || typeof ref.id !== 'string') throw new DomainError('INVALID_ARGUMENT', 'Select a synthetic Base search reference.');
          baseId = ref.id;
        }
        const base = required(workspace.bases.find(item => item.base_id === baseId), 'Base');
        if (args.table_id) required(base.tables.find(table => table.table_id === args.table_id), 'Table');
        const page = this.page(name, base.tables.filter(table => !args.table_id || table.table_id === args.table_id).map(({ table_id, name, fields }) => ({ table_id, name, fields })), args, identity, 'tables');
        return { ...page, data: { ...page.data, base_id: base.base_id, schema_version: digest(JSON.stringify(base.tables.map(table => table.fields))).slice(0, 16) } };
      }
      case 'query_base_records': return this.queryBase(args, identity, workspace);
      case 'get_agenda': {
        const timezone = text(args, 'timezone');
        return { ...this.page(name, workspace.events.filter(event => overlaps(event, args.time_range as Range)).map(event => ({ ...event, local_start: localTime(event.start, timezone), local_end: localTime(event.end, timezone), timezone })), args, identity, 'events') };
      }
      case 'get_free_busy': {
        const people = this.people(args, workspace);
        return { data: { timezone: args.timezone, people: people.map(open_id => ({ open_id, busy: workspace.events.filter(event => event.attendee_ids.includes(open_id) && overlaps(event, args.time_range as Range)).map(event => ({ start: event.start, end: event.end })) })) } };
      }
      case 'suggest_meeting_times': return this.suggestTimes(args, workspace);
      case 'list_meeting_rooms': return this.page(name, workspace.rooms.filter(room => (!args.query || includes(room.name, text(args, 'query'))) && (!args.min_capacity || room.capacity >= Number(args.min_capacity))).map(room => ({ ...room, available: args.time_range ? !workspace.events.some(event => event.room_id === room.room_id && overlaps(event, args.time_range as Range)) : null })), args, identity, 'rooms');
      case 'list_tasks': return this.page(name, workspace.tasks.filter(task => (!args.status || task.status === args.status) && (!args.tasklist_id || task.tasklist_id === args.tasklist_id) && (!args.assignee_id || task.assignee_ids.includes(text(args, 'assignee_id')))), args, identity, 'tasks');
      case 'get_task': return { data: { task: required(workspace.tasks.find(task => task.task_id === args.task_id), 'Task') } };
    }
  }
  private people(args: Params, workspace: WorkspaceData): string[] {
    const people = [...new Set(args.people as string[])];
    for (const person of people) required(workspace.people.find(item => item.open_id === person), 'Person');
    return people;
  }
  private suggestTimes(args: Params, workspace: WorkspaceData): Payload {
    const people = this.people(args, workspace); const range = args.time_range as Range;
    const duration = Number(args.duration_minutes) * 60_000; const timezone = text(args, 'timezone');
    const busy = workspace.events.filter(event => event.attendee_ids.some(person => people.includes(person)) && overlaps(event, range));
    const slots: { start: string; end: string; local_start: string; local_end: string }[] = [];
    const end = Date.parse(range.end);
    for (let start = Date.parse(range.start); start + duration <= end && slots.length < Number(args.limit); start += 15 * 60_000) {
      const candidate = { start: new Date(start).toISOString(), end: new Date(start + duration).toISOString() };
      if (!busy.some(event => overlaps(event, candidate))) slots.push({ ...candidate, local_start: localTime(candidate.start, timezone), local_end: localTime(candidate.end, timezone) });
    }
    return { data: { slots, timezone, requested_count: args.limit, count: slots.length, availability_basis: 'synthetic_fixture_events_only' } };
  }
  private queryBase(args: Params, identity: Identity, workspace: WorkspaceData): Payload {
    const base = required(workspace.bases.find(item => item.base_id === args.base_id), 'Base');
    const table = required(base.tables.find(item => item.table_id === args.table_id), 'Table');
    const fields = args.fields as string[] | undefined;
    for (const field of fields ?? []) if (!table.fields.some(item => item.field_id === field)) throw new DomainError('INVALID_ARGUMENT', 'Unknown field_id. Read the schema first.');
    let records = [...table.records];
    const filter = args.filter as { field_id: string; operator: string; value: string | number } | undefined;
    if (filter) {
      const field = table.fields.find(item => item.field_id === filter.field_id);
      if (!field) throw new DomainError('INVALID_ARGUMENT', 'Unknown field_id. Read the schema first.');
      if ((field.type === 'number') !== (typeof filter.value === 'number') || (['gt', 'lt'].includes(filter.operator) && field.type !== 'number') || (filter.operator === 'contains' && field.type === 'number')) throw new DomainError('INVALID_ARGUMENT', 'Filter type is incompatible with the field.');
      records = records.filter(record => {
        const value = record.fields[filter.field_id];
        if (filter.operator === 'eq') return value === filter.value;
        if (filter.operator === 'contains') return typeof value === 'string' && includes(value, String(filter.value));
        return filter.operator === 'gt' ? Number(value) > Number(filter.value) : Number(value) < Number(filter.value);
      });
    }
    const sort = args.sort as { field_id: string; direction: string } | undefined;
    if (sort) {
      if (!table.fields.some(field => field.field_id === sort.field_id)) throw new DomainError('INVALID_ARGUMENT', 'Unknown sort field_id.');
      records.sort((a, b) => { const aa = a.fields[sort.field_id] ?? ''; const bb = b.fields[sort.field_id] ?? ''; const compare = typeof aa === 'number' && typeof bb === 'number' ? aa - bb : String(aa).localeCompare(String(bb)); return sort.direction === 'asc' ? compare : -compare; });
    }
    return this.page('query_base_records', records.map(record => ({ ...record, fields: fields ? Object.fromEntries(fields.map(field => [field, record.fields[field] ?? null])) : record.fields })), args, identity, 'records');
  }
  private search(args: Params, identity: Identity, workspace: WorkspaceData): Payload {
    const types = [...new Set((args.types as string[] | undefined) ?? ['doc', 'wiki', 'file', 'message', 'base'])];
    const scope: Record<string, string> = { doc: 'docs.read', wiki: 'docs.read', file: 'docs.read', message: 'im.read', base: 'base.read' };
    const missing = [...new Set(types.filter(type => !identity.scopes.includes(scope[type]!)).map(type => scope[type]!))];
    const allowed = types.filter(type => identity.scopes.includes(scope[type]!));
    if (!allowed.length) throw new DomainError('INSUFFICIENT_SCOPE', 'No requested resource type is authorized.', missing[0]);
    const results: Record<string, unknown>[] = []; const query = text(args, 'query'); const range = args.time_range as Range | undefined;
    for (const doc of workspace.documents) if (allowed.includes(doc.type) && !args.chat_id && includes(`${doc.title} ${doc.text}`, query) && (!args.owner || doc.owner === args.owner) && inRange(doc.updated_at, range)) results.push({ result_id: this.handles.encode('resource', identity, { type: doc.type, id: doc.doc_id }), type: doc.type, title: doc.title, snippet: doc.text.slice(0, 240), url: doc.url, updated_at: doc.updated_at, ids: { doc_id: doc.doc_id } });
    if (allowed.includes('message')) for (const message of workspace.messages) if (includes(message.text, query) && (!args.chat_id || message.chat_id === args.chat_id) && (!args.owner || message.sender_open_id === args.owner) && inRange(message.created_at, range)) results.push({ result_id: this.handles.encode('resource', identity, { type: 'message', id: message.message_id }), type: 'message', title: message.text.slice(0, 80), snippet: message.text.slice(0, 240), url: message.app_link, updated_at: message.created_at, ids: { message_id: message.message_id, chat_id: message.chat_id } });
    // Base fixtures carry no owner or timestamp; do not silently ignore those filters.
    if (allowed.includes('base') && !args.owner && !args.chat_id && !range) for (const base of workspace.bases) if (includes(base.name, query)) results.push({ result_id: this.handles.encode('resource', identity, { type: 'base', id: base.base_id }), type: 'base', title: base.name, snippet: 'Base metadata', url: `https://example.test/base/${base.base_id}`, updated_at: null, ids: { base_id: base.base_id } });
    const page = this.page('search', results, args, identity, 'results');
    return { ...page, data: { ...page.data, missing_scopes: missing, content_trust: 'untrusted_source_data' }, partial: missing.length > 0 };
  }
  private fetch(args: Params, identity: Identity, workspace: WorkspaceData): Payload {
    const reference = this.handles.decode('resource', identity, text(args, 'result_id'));
    const scope: Record<string, string> = { doc: 'docs.read', wiki: 'docs.read', file: 'docs.read', message: 'im.read', base: 'base.read' };
    if (typeof reference.type !== 'string' || !Object.hasOwn(scope, reference.type)) throw new DomainError('INVALID_ARGUMENT', 'Unknown resource type.');
    requireScope(identity, scope[reference.type]!);
    let body: string; let title: string; let url: string;
    if (reference.type === 'message') {
      const message = required(workspace.messages.find(item => item.message_id === reference.id), 'Message');
      body = message.text; title = body.slice(0, 80); url = message.app_link;
    } else if (reference.type === 'base') {
      const base = required(workspace.bases.find(item => item.base_id === reference.id), 'Base');
      body = JSON.stringify({ base_id: base.base_id, name: base.name, tables: base.tables.map(({ table_id, name }) => ({ table_id, name })) }); title = base.name; url = `https://example.test/base/${base.base_id}`;
    } else {
      const document = required(workspace.documents.find(item => item.doc_id === reference.id && item.type === reference.type), 'Document');
      body = document.text; title = document.title; url = document.url;
    }
    // Unicode-safe chunks: never split a surrogate pair. Cursors bind to both result and chunk size.
    const characters = Array.from(body);
    const page = this.handles.paginate(characters, identity, { tool: 'fetch', result_id: args.result_id, max_chars: args.max_chars }, Number(args.max_chars), optionalText(args, 'cursor'));
    return { data: { type: reference.type, title, content: page.items.join(''), url, truncated: page.next_cursor !== null, content_trust: 'untrusted_source_data' }, next_cursor: page.next_cursor };
  }
}
