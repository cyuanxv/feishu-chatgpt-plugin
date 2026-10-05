import { z } from 'zod';
import { digest, DomainError, Handles, type Identity } from '../../policy/src/core.js';
import { FeishuSdkReadGateway } from './sdk-reads.js';

const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.@+-]+$/);
const pageSchema = z.object({ page_size: z.number().int().min(1).max(50).default(20), cursor: z.string().max(4096).optional() }).strict();
const timeRange = z.object({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) }).strict().refine(range => Date.parse(range.end) > Date.parse(range.start) && Date.parse(range.end) - Date.parse(range.start) <= 31 * 86400000, 'A complete range of at most 31 days is required.');
const timezone = z.string().max(100).refine(zone => { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; } });
const busyInterval = z.object({ start_time: z.iso.datetime({ offset: true }), end_time: z.iso.datetime({ offset: true }) }).passthrough().refine(interval => Date.parse(interval.end_time) > Date.parse(interval.start_time));
const validBusyInterval = (value: unknown): boolean => busyInterval.safeParse(value).success;
type Page = { page_size?: number; cursor?: string };
type Field = { field_id: string; field_name: string; type: number };

/** Bounded high-level Base/calendar/provider mappings. No listener or app credentials are configured here. */
export class FeishuProviderDomains {
  constructor(private readonly gateway: FeishuSdkReadGateway, private readonly handles: Handles) {}
  private page(operation: string, query: unknown, input: Page, identity: Identity) {
    const page = pageSchema.parse(input); const fingerprint = digest(JSON.stringify(query));
    let token: string | undefined; let history: string[] = [];
    if (page.cursor) { const value = this.handles.decode('cursor', identity, page.cursor); if (value.operation !== operation || value.fingerprint !== fingerprint || value.pageSize !== page.page_size || typeof value.token !== 'string' || !Array.isArray(value.history) || value.history.length > 20 || value.history.some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item))) throw new DomainError('INVALID_ARGUMENT', 'Cursor does not match this provider query.'); token = value.token; history = value.history as string[]; }
    return { pageSize: page.page_size, token, next: (hasMore: boolean | undefined, nextToken: string | undefined) => {
      if (!hasMore) return null;
      if (typeof nextToken !== 'string' || !nextToken) throw new DomainError('UPSTREAM_ERROR', 'Provider pagination was incomplete.');
      const hash = digest(nextToken);
      if (history.includes(hash)) throw new DomainError('UPSTREAM_ERROR', 'Provider repeated a pagination token.');
      if (history.length >= 20) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Provider pagination exceeds the supported budget.');
      const cursor = this.handles.encode('cursor', identity, { operation, fingerprint, pageSize: page.page_size, token: nextToken, history: [...history, hash] });
      if (cursor.length > 4096) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Provider cursor exceeds the supported reference size.');
      return cursor;
    } };
  }
  async baseSchema(identity: Identity, baseId: string, tableId: string): Promise<{ base_id: string; table_id: string; fields: Field[]; schema_version: string; source: 'feishu_api' }> {
    id.parse(baseId); id.parse(tableId); const fields: Field[] = []; let token: string | undefined; const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const response = await this.gateway.call('listBaseFields', { path: { app_token: baseId, table_id: tableId }, params: { page_size: 100, ...(token ? { page_token: token } : {}) } }, identity);
      if (!Array.isArray(response.items) || response.items.length > 100 || typeof response.has_more !== 'boolean') throw new DomainError('UPSTREAM_ERROR', 'Provider field schema page was incomplete or oversized.');
      for (const field of response.items) { if (!field || typeof field.field_id !== 'string' || !id.safeParse(field.field_id).success || typeof field.field_name !== 'string' || !field.field_name || !Number.isSafeInteger(field.type) || field.type <= 0) throw new DomainError('UPSTREAM_ERROR', 'Provider field schema was incomplete.'); fields.push({ field_id: field.field_id, field_name: field.field_name, type: field.type }); }
      if (!response.has_more) {
        if (new Set(fields.map(field => field.field_id)).size !== fields.length || new Set(fields.map(field => field.field_name)).size !== fields.length) throw new DomainError('CONFLICT', 'Provider schema contains ambiguous fields.');
        return { base_id: baseId, table_id: tableId, fields, schema_version: digest(JSON.stringify(fields)).slice(0, 16), source: 'feishu_api' };
      }
      if (!response.page_token || seen.has(response.page_token)) throw new DomainError('UPSTREAM_ERROR', 'Provider repeated or omitted a schema page token.');
      seen.add(response.page_token); token = response.page_token;
    }
    throw new DomainError('UNSUPPORTED_CAPABILITY', 'This table schema exceeds the safe read budget.');
  }
  async queryBase(identity: Identity, input: { base_id: string; table_id: string; fields?: string[]; filter?: { field_id: string; operator: 'eq' | 'contains' | 'gt' | 'lt'; value: string | number }; sort?: { field_id: string; direction: 'asc' | 'desc' } }, page: Page = {}) {
    const parsed = z.object({ base_id: id, table_id: id, fields: z.array(id).min(1).max(50).optional(), filter: z.object({ field_id: id, operator: z.enum(['eq', 'contains', 'gt', 'lt']), value: z.union([z.string().max(1000), z.number().finite()]) }).strict().optional(), sort: z.object({ field_id: id, direction: z.enum(['asc', 'desc']) }).strict().optional() }).strict().parse(input);
    const schema = await this.baseSchema(identity, parsed.base_id, parsed.table_id);
    const getField = (fieldId: string): Field => { const field = schema.fields.find(item => item.field_id === fieldId); if (!field) throw new DomainError('INVALID_ARGUMENT', 'Unknown field ID. Read the current schema.'); return field; };
    const selected = parsed.fields?.map(getField) ?? schema.fields;
    const filterField = parsed.filter ? getField(parsed.filter.field_id) : undefined;
    if (filterField && parsed.filter) {
      // Initial provider filter mapper deliberately supports plain text (1), number (2), and single select (3) only.
      if (![1, 2, 3].includes(filterField.type)) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Filtering this Feishu field type is not implemented yet.');
      const numeric = filterField.type === 2;
      if (numeric !== (typeof parsed.filter.value === 'number') || (['gt', 'lt'].includes(parsed.filter.operator) && !numeric) || (parsed.filter.operator === 'contains' && numeric)) throw new DomainError('INVALID_ARGUMENT', 'Filter value/operator does not match the real field type.');
    }
    const sortField = parsed.sort ? getField(parsed.sort.field_id) : undefined;
    const pagination = this.page('base_records', { ...parsed, schema_version: schema.schema_version }, page, identity);
    const operators = { eq: 'is', contains: 'contains', gt: 'isGreater', lt: 'isLess' } as const;
    const raw = await this.gateway.call('searchBaseRecords', { path: { app_token: parsed.base_id, table_id: parsed.table_id }, params: { page_size: pagination.pageSize, user_id_type: 'open_id', ...(pagination.token ? { page_token: pagination.token } : {}) }, data: { field_names: selected.map(field => field.field_name), ...(filterField && parsed.filter ? { filter: { conjunction: 'and', conditions: [{ field_name: filterField.field_name, operator: operators[parsed.filter.operator], value: [String(parsed.filter.value)] }] } } : {}), ...(sortField && parsed.sort ? { sort: [{ field_name: sortField.field_name, desc: parsed.sort.direction === 'desc' }] } : {}) } }, identity);
    if (!Array.isArray(raw.items) || raw.items.length > pagination.pageSize || typeof raw.has_more !== 'boolean') throw new DomainError('UPSTREAM_ERROR', 'Provider record page was incomplete or oversized.');
    const records = raw.items.map(record => {
      if (!record || typeof record.record_id !== 'string' || !id.safeParse(record.record_id).success || !record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) throw new DomainError('UPSTREAM_ERROR', 'Provider record was missing an ID or fields.');
      return { record_id: record.record_id, fields: Object.fromEntries(selected.map(field => [field.field_id, { name: field.field_name, provider_type: field.type, value: Object.hasOwn(record.fields, field.field_name) ? record.fields[field.field_name] ?? null : null }])) };
    });
    if (new Set(records.map(record => record.record_id)).size !== records.length) throw new DomainError('UPSTREAM_ERROR', 'Provider repeated a record within one page.');
    return { records, schema_version: schema.schema_version, next_cursor: pagination.next(raw.has_more, raw.page_token), source: 'feishu_api' as const };
  }
  async calendars(identity: Identity, page: Page = {}) {
    const pagination = this.page('calendars', {}, page, identity);
    const raw = await this.gateway.call('listCalendars', { params: { page_size: pagination.pageSize, ...(pagination.token ? { page_token: pagination.token } : {}) } }, identity);
    if (!Array.isArray(raw.calendar_list) || raw.calendar_list.length > pagination.pageSize || typeof raw.has_more !== 'boolean') throw new DomainError('UPSTREAM_ERROR', 'Provider calendar page was incomplete or oversized.');
    const calendars = raw.calendar_list.filter(calendar => !calendar.is_deleted).map(calendar => {
      if (!id.safeParse(calendar.calendar_id).success) throw new DomainError('UPSTREAM_ERROR', 'Provider calendar ID was incomplete.');
      return { calendar_id: calendar.calendar_id!, summary: calendar.summary ?? '', type: calendar.type ?? 'unknown', role: calendar.role ?? 'unknown' };
    });
    if (new Set(calendars.map(calendar => calendar.calendar_id)).size !== calendars.length) throw new DomainError('UPSTREAM_ERROR', 'Provider repeated a calendar within one page.');
    return { calendars, next_cursor: pagination.next(raw.has_more, raw.page_token), source: 'feishu_api' as const };
  }
  async agenda(identity: Identity, input: { calendar_id: string; time_range: { start: string; end: string }; timezone: string }, page: Page = {}) {
    const parsed = z.object({ calendar_id: id, time_range: timeRange, timezone }).strict().parse(input);
    const pagination = this.page('agenda', parsed, page, identity);
    const raw = await this.gateway.call('listEvents', { path: { calendar_id: parsed.calendar_id }, params: { page_size: pagination.pageSize, start_time: String(Math.floor(Date.parse(parsed.time_range.start) / 1000)), end_time: String(Math.floor(Date.parse(parsed.time_range.end) / 1000)), user_id_type: 'open_id', ...(pagination.token ? { page_token: pagination.token } : {}) } }, identity);
    if (!Array.isArray(raw.items) || raw.items.length > pagination.pageSize || typeof raw.has_more !== 'boolean') throw new DomainError('UPSTREAM_ERROR', 'Provider event page was incomplete or oversized.');
    const events = raw.items.map(event => {
      if (!id.safeParse(event.event_id).success) throw new DomainError('UPSTREAM_ERROR', 'Provider event ID was incomplete.');
      return { event_id: event.event_id!, summary: event.summary ?? '', start: event.start_time, end: event.end_time, status: event.status ?? null };
    });
    if (new Set(events.map(event => event.event_id)).size !== events.length) throw new DomainError('UPSTREAM_ERROR', 'Provider repeated an event within one page.');
    return { events, timezone: parsed.timezone, time_encoding: 'provider_timestamp_or_all_day_date' as const, next_cursor: pagination.next(raw.has_more, raw.page_token), source: 'feishu_api' as const };
  }
  async freeBusy(identity: Identity, input: { people: string[]; time_range: { start: string; end: string }; timezone: string }) {
    const parsed = z.object({ people: z.array(id).min(1).max(20), time_range: timeRange, timezone }).strict().parse(input);
    const people = [...new Set(parsed.people)];
    const raw = await this.gateway.call('freeBusy', { data: { time_min: parsed.time_range.start, time_max: parsed.time_range.end, user_ids: people, only_busy: true, include_external_calendar: true }, params: { user_id_type: 'open_id' } }, identity);
    const known = raw.freebusy_lists ?? [];
    const valid = (item: typeof known[number]): boolean => Array.isArray(item.freebusy_items) && item.freebusy_items.every(validBusyInterval);
    const unknown = people.filter(person => !known.some(item => item.user_id === person && valid(item)) || known.some(item => item.user_id === person && !valid(item)));
    return { people: people.map(open_id => ({ open_id, known: !unknown.includes(open_id), busy: known.filter(item => item.user_id === open_id && valid(item)).flatMap(item => item.freebusy_items ?? []).map(item => ({ start: item.start_time, end: item.end_time, rsvp_status: item.rsvp_status ?? null })) })), unknown_people: unknown, timezone: parsed.timezone, complete: unknown.length === 0, source: 'feishu_api' as const };
  }
  async rooms(identity: Identity, query: string | undefined, page: Page = {}) {
    if (query !== undefined) z.string().trim().min(1).max(1000).parse(query);
    const pagination = this.page('rooms', { query }, page, identity);
    const raw = await this.gateway.call('searchRooms', { data: { ...(query ? { keyword: query } : {}), page_size: pagination.pageSize, ...(pagination.token ? { page_token: pagination.token } : {}) }, params: { user_id_type: 'open_id' } }, identity);
    // Provider output is untrusted: reject over-sized pages before any per-room fan-out.
    // Missing lists do not establish that there are no matching rooms.
    if (!Array.isArray(raw.rooms) || raw.rooms.length > pagination.pageSize) throw new DomainError('UPSTREAM_ERROR', 'Provider room page was missing or exceeded the requested limit.');
    return { rooms: raw.rooms.map(room => ({ room_id: room.room_id ?? null, name: room.name ?? '', capacity: typeof room.capacity === 'number' && Number.isSafeInteger(room.capacity) && room.capacity > 0 ? room.capacity : null, availability: 'not_queried' as const })), next_cursor: pagination.next(raw.has_more, raw.page_token), source: 'feishu_api' as const };
  }
  async roomAvailability(identity: Identity, roomId: string, range: { start: string; end: string }) {
    id.parse(roomId); const parsed = timeRange.parse(range);
    // The provider prioritizes user_id if both IDs are sent. Never send it in a room query.
    const raw = await this.gateway.call('roomBusy', { data: { time_min: parsed.start, time_max: parsed.end, room_id: roomId, include_external_calendar: true, only_busy: true } }, identity);
    const valid = Array.isArray(raw.freebusy_list) && raw.freebusy_list.every(validBusyInterval);
    if (!valid) return { room_id: roomId, available: null, known: false, busy: [], source: 'feishu_api' as const };
    const busy = raw.freebusy_list!.filter(item => Date.parse(item.start_time) < Date.parse(parsed.end) && Date.parse(item.end_time) > Date.parse(parsed.start)).map(item => ({ start: item.start_time, end: item.end_time }));
    return { room_id: roomId, available: busy.length === 0, known: true, busy, source: 'feishu_api' as const };
  }
  async roomsWithAvailability(identity: Identity, input: { query?: string; min_capacity?: number; time_range: { start: string; end: string }; page_size?: number; cursor?: string }) {
    const parsed = z.object({ query: z.string().trim().min(1).max(1000).optional(), min_capacity: z.number().int().min(1).max(1000).optional(), time_range: timeRange, page_size: z.number().int().min(1).max(10).default(5), cursor: z.string().max(4096).optional() }).strict().parse(input);
    // Bind the outer filter/window to the provider room-list continuation.
    const fingerprint = digest(JSON.stringify({ query: parsed.query, min_capacity: parsed.min_capacity, time_range: parsed.time_range, page_size: parsed.page_size }));
    let innerCursor: string | undefined;
    if (parsed.cursor) { const cursor = this.handles.decode('cursor', identity, parsed.cursor); if (cursor.operation !== 'room_availability_list' || cursor.fingerprint !== fingerprint || typeof cursor.inner !== 'string') throw new DomainError('INVALID_ARGUMENT', 'Room cursor does not match the requested window and filters.'); innerCursor = cursor.inner; }
    const page = await this.rooms(identity, parsed.query, { page_size: parsed.page_size, cursor: innerCursor });
    const matching = page.rooms.filter(room => parsed.min_capacity === undefined || (room.capacity !== null && room.capacity >= parsed.min_capacity));
    const rooms = await Promise.all(matching.map(async room => {
      const { availability: _notQueried, ...metadata } = room;
      if (!room.room_id) return { ...metadata, available: null, availability_known: false, error_type: 'UPSTREAM_ERROR' };
      try { const status = await this.roomAvailability(identity, room.room_id, parsed.time_range); return { ...metadata, available: status.available, availability_known: status.known, busy: status.busy }; }
      catch (raw) { return { ...metadata, available: null, availability_known: false, error_type: raw instanceof DomainError ? raw.type : 'UPSTREAM_ERROR' }; }
    }));
    const cursor = page.next_cursor ? this.handles.encode('cursor', identity, { operation: 'room_availability_list', fingerprint, inner: page.next_cursor }) : null;
    if (cursor && cursor.length > 4096) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Room continuation exceeds the safe reference budget. Narrow the query.');
    const unknownCapacity = page.rooms.filter(room => parsed.min_capacity !== undefined && room.capacity === null).length;
    return { rooms, next_cursor: cursor, partial: rooms.some(room => !room.availability_known) || unknownCapacity > 0, capacity_unknown_excluded: unknownCapacity, source: 'feishu_api' as const };
  }
}
