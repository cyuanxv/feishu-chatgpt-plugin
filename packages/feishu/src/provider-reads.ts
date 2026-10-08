import { z } from 'zod';
import { digest, DomainError, Handles, requireScope, type Identity } from '../../policy/src/core.js';
import { FeishuSdkReadGateway, type SdkReadInput } from './sdk-reads.js';

const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const pageSchema = z.object({ page_size: z.number().int().min(1).max(50).default(20), cursor: z.string().max(4096).optional() }).strict();
type Page = { page_size?: number; cursor?: string };
const safeUrl = (url: string | undefined): string | null => {
  if (!url) return null;
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && (parsed.hostname.endsWith('.feishu.cn') || parsed.hostname.endsWith('.larksuite.com')) ? parsed.href : null; } catch { return null; }
};
const plain = (value: string | undefined): string => (value ?? '').replace(/<[^>]*>/g, '');

/** The search API accepts whole Unix seconds; never silently round a caller's narrower window. */
export function assertMessageSearchTimePrecision(range: { start: string; end: string } | undefined): void {
  if (range && [range.start, range.end].some(value => {
    const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1];
    // Inspect original digits too: Date.parse truncates sub-millisecond fractions such as .0001Z.
    return Date.parse(value) % 1000 !== 0 || (fraction !== undefined && /[1-9]/.test(fraction));
  })) {
    throw new DomainError('INVALID_ARGUMENT', 'Provider message search requires whole-second time boundaries.');
  }
}

/** Targeted real-provider calls with normalized, allowlisted data; no full workspace snapshot. These methods are not MCP tools yet. */
export class FeishuProviderReads {
  constructor(private readonly gateway: FeishuSdkReadGateway, private readonly handles: Handles) {}
  private token(operation: string, query: unknown, page: Page, identity: Identity): { pageSize: number; upstream?: string; history: string[] } {
    const parsed = pageSchema.parse(page);
    if (!parsed.cursor) return { pageSize: parsed.page_size, history: [] };
    const cursor = this.handles.decode('cursor', identity, parsed.cursor);
    if (cursor.operation !== operation || cursor.query !== JSON.stringify(query) || cursor.pageSize !== parsed.page_size || typeof cursor.upstream !== 'string' || !Array.isArray(cursor.history) || cursor.history.length > 20 || cursor.history.some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) throw new DomainError('INVALID_ARGUMENT', 'Cursor does not match the provider query.');
    return { pageSize: parsed.page_size, upstream: cursor.upstream, history: cursor.history as string[] };
  }
  private next(operation: string, query: unknown, pageSize: number, hasMore: boolean | undefined, upstream: string | undefined, identity: Identity, history: string[]): string | null {
    if (!hasMore) return null;
    if (!upstream) throw new DomainError('UPSTREAM_ERROR', 'Provider pagination was incomplete.');
    const tokenHash = digest(upstream);
    if (history.includes(tokenHash)) throw new DomainError('UPSTREAM_ERROR', 'Provider repeated a pagination token. Stop and retry a narrower query.');
    if (history.length >= 20) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Provider pagination exceeds the supported page budget. Narrow the query.');
    const cursor = this.handles.encode('cursor', identity, { operation, query: JSON.stringify(query), pageSize, upstream, history: [...history, tokenHash] });
    if (cursor.length > 4096) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Provider cursor exceeds the supported reference size. Narrow the query.');
    return cursor;
  }
  async profile(identity: Identity) {
    const raw = await this.gateway.call('profile', {}, identity);
    const profile = z.object({ name: z.string(), open_id: z.string(), tenant_key: z.string() }).parse(raw);
    if (profile.tenant_key !== identity.tenantId) throw new DomainError('PERMISSION_DENIED', 'Provider tenant does not match this connection.');
    return { display_name: profile.name, open_id: profile.open_id, domain: identity.domain, granted_scopes: identity.scopes, source: 'feishu_api' as const };
  }
  async people(identity: Identity, input: { query: string; page_size?: number; locale?: string }) {
    const querySchema = z.string().trim().min(1).refine(value => Array.from(value).length <= 50, 'Search supports at most 50 Unicode characters.');
    const parsed = z.object({ query: querySchema, page_size: z.number().int().min(1).max(30).default(20), locale: z.enum(['zh_cn', 'en_us', 'ja_jp', 'zh_hk', 'zh_tw']).default('zh_cn') }).strict().parse(input);
    const raw = await this.gateway.call('searchPeople', { data: { query: parsed.query }, params: { page_size: parsed.page_size } }, identity);
    const response = z.object({ items: z.array(z.object({ id: id, display_info: z.string().optional(), meta_data: z.object({ i18n_names: z.record(z.string(), z.string()).optional(), is_cross_tenant: z.boolean().optional() }).optional() })), has_more: z.boolean() }).parse(raw);
    const people = response.items.map(person => ({ open_id: person.id, display_name: person.meta_data?.i18n_names?.[parsed.locale] || person.meta_data?.i18n_names?.zh_cn || person.meta_data?.i18n_names?.en_us || person.id, is_cross_tenant: person.meta_data?.is_cross_tenant ?? null, match_summary: plain(person.display_info) }));
    return { people, ambiguous: people.length > 1 || response.has_more, has_more: response.has_more, next_cursor: null, refinement_required: response.has_more, source: 'feishu_api' as const };
  }
  async chats(identity: Identity, query: string | undefined, page: Page = {}) {
    if (query !== undefined) z.string().trim().min(1).max(1000).parse(query);
    const params = this.token('chats', { query }, page, identity);
    const args = { params: { user_id_type: 'open_id' as const, page_size: params.pageSize, ...(params.upstream ? { page_token: params.upstream } : {}), ...(query ? { query } : {}) } };
    const raw = query ? await this.gateway.call('searchChats', args, identity) : await this.gateway.call('listChats', args, identity);
    const items = (raw.items ?? []).map(item => { if (!item.chat_id) throw new DomainError('UPSTREAM_ERROR', 'Provider returned a chat without an ID.'); return { chat_id: item.chat_id, name: item.name ?? '', description: item.description ?? '' }; });
    return { chats: items, next_cursor: this.next('chats', { query }, params.pageSize, raw.has_more, raw.page_token, identity, params.history), source: 'feishu_api' as const };
  }
  async searchDocuments(identity: Identity, query: string, types: ('DOCX' | 'WIKI' | 'BITABLE' | 'FILE')[] = ['DOCX', 'WIKI'], page: Page = {}) {
    requireScope(identity, 'search.read');
    if (types.includes('BITABLE')) requireScope(identity, 'base.read');
    z.string().trim().min(1).refine(value => Array.from(value).length <= 30, 'Provider document search supports at most 30 Unicode characters.').parse(query);
    z.number().int().min(1).max(20).parse(page.page_size ?? 20);
    z.array(z.enum(['DOCX', 'WIKI', 'BITABLE', 'FILE'])).min(1).max(4).parse(types);
    const shape = { query, types }; const params = this.token('docs', shape, page, identity);
    const raw = await this.gateway.call('searchDocs', { data: { query, doc_filter: { doc_types: types }, wiki_filter: { doc_types: types }, page_size: params.pageSize, ...(params.upstream ? { page_token: params.upstream } : {}) } }, identity);
    const results = (raw.res_units ?? []).map(item => {
      const meta = item.result_meta;
      if (!meta?.token || !meta.doc_types) throw new DomainError('UPSTREAM_ERROR', 'Provider search result was incomplete.');
      if (!(types as readonly string[]).includes(meta.doc_types)) throw new DomainError('UPSTREAM_ERROR', 'Provider returned a resource type outside the requested set.');
      if (meta.doc_types === 'BITABLE') requireScope(identity, 'base.read');
      return { resource_token: meta.token, resource_type: meta.doc_types, container_type: item.entity_type ?? null, title: plain(item.title_highlighted), snippet: plain(item.summary_highlighted), url: safeUrl(meta.url), updated_at_provider: meta.update_time ?? null };
    });
    return { results, next_cursor: this.next('docs', shape, params.pageSize, raw.has_more, raw.page_token, identity, params.history), source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
  }
  async searchMessages(identity: Identity, input: { query: string; chat_id?: string; sender_open_id?: string; start?: string; end?: string }, page: Page = {}) {
    const checked = z.object({ query: z.string().trim().min(1).max(1000), chat_id: id.optional(), sender_open_id: id.optional(), start: z.iso.datetime({ offset: true }).optional(), end: z.iso.datetime({ offset: true }).optional() }).strict().refine(value => Boolean(value.start) === Boolean(value.end) && (!value.start || Date.parse(value.end!) > Date.parse(value.start)), 'An ordered complete time range is required.').parse(input);
    assertMessageSearchTimePrecision(checked.start ? { start: checked.start, end: checked.end! } : undefined);
    const params = this.token('messages', checked, page, identity);
    const raw = await this.gateway.call('searchMessages', { data: { query: checked.query, filter: { ...(checked.chat_id ? { chat_ids: [checked.chat_id] } : {}), ...(checked.sender_open_id ? { from_ids: [checked.sender_open_id] } : {}), ...(checked.start ? { time_range: { start_time: String(Math.floor(Date.parse(checked.start) / 1000)), end_time: String(Math.floor(Date.parse(checked.end!) / 1000)) } } : {}) } }, params: { user_id_type: 'open_id', page_size: params.pageSize, ...(params.upstream ? { page_token: params.upstream } : {}) } }, identity);
    if (!Array.isArray(raw.items) || raw.items.length > params.pageSize || typeof raw.has_more !== 'boolean') throw new DomainError('UPSTREAM_ERROR', 'Provider message search page was missing, oversized or had invalid pagination.');
    const seen = new Set<string>();
    return { messages: raw.items.map(item => {
      if (!item.meta_data) throw new DomainError('UPSTREAM_ERROR', 'Provider message was missing metadata.');
      const messageId = id.safeParse(item.meta_data?.message_id);
      if (!messageId.success || seen.has(messageId.data)) throw new DomainError('UPSTREAM_ERROR', 'Provider message was missing a unique valid ID.');
      seen.add(messageId.data);
      if ((checked.chat_id && item.meta_data.chat_id !== checked.chat_id) || (checked.sender_open_id && item.meta_data.from_id !== checked.sender_open_id)) throw new DomainError('UPSTREAM_ERROR', 'Provider returned a message outside the requested chat or sender.');
      return { message_id: messageId.data, chat_id: item.meta_data.chat_id ?? null, thread_id: item.meta_data.thread_id ?? null, sender_open_id: item.meta_data.from_id ?? null, snippet: plain(item.display_info), created_at_provider: item.meta_data.create_time ?? null };
    }), next_cursor: this.next('messages', checked, params.pageSize, raw.has_more, raw.page_token, identity, params.history), source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
  }
  async document(identity: Identity, documentId: string) {
    id.parse(documentId);
    const [metadata, content] = await Promise.all([this.gateway.call('getDocument', { path: { document_id: documentId } }, identity), this.gateway.call('readDocument', { path: { document_id: documentId } }, identity)]);
    if (metadata.document?.document_id !== documentId || typeof content.content !== 'string') throw new DomainError('UPSTREAM_ERROR', 'Provider document response was incomplete or mismatched.');
    return { doc_id: metadata.document.document_id, title: metadata.document.title ?? '', content: content.content, source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
  }
  /** A bounded metadata read, never a download. Keep each failed/missing request visible. */
  async metadata(identity: Identity, requests: { doc_token: string; doc_type: 'file' | 'docx' }[]) {
    const requestSchema = z.object({ doc_token: id, doc_type: z.enum(['file', 'docx']) }).strict();
    const parsed = z.array(requestSchema).min(1).max(200).parse(requests);
    if (new Set(parsed.map(item => item.doc_token)).size !== parsed.length) throw new DomainError('INVALID_ARGUMENT', 'Metadata requests must have unique resource tokens.');
    const raw = await this.gateway.call('batchMetadata', { data: { request_docs: parsed, with_url: true }, params: { user_id_type: 'open_id' } }, identity);
    const response = z.object({ metas: z.array(z.object({ doc_token: id, doc_type: z.enum(['file', 'docx']), title: z.string(), owner_id: z.string().optional(), create_time: z.string().optional(), latest_modify_time: z.string().optional(), url: z.string().optional(), request_doc_info: requestSchema.optional() })), failed_list: z.array(z.object({ token: id, code: z.number().int() })).optional() }).safeParse(raw);
    if (!response.success) throw new DomainError('UPSTREAM_ERROR', 'Provider metadata response was malformed.');
    const requested = new Map(parsed.map(item => [item.doc_token, item.doc_type]));
    const seen = new Set<string>();
    for (const meta of response.data.metas) {
      if (requested.get(meta.doc_token) !== meta.doc_type || (meta.request_doc_info && (meta.request_doc_info.doc_token !== meta.doc_token || meta.request_doc_info.doc_type !== meta.doc_type)) || seen.has(meta.doc_token)) throw new DomainError('UPSTREAM_ERROR', 'Provider metadata did not match unique requested resources.');
      seen.add(meta.doc_token);
    }
    for (const failure of response.data.failed_list ?? []) {
      if (!requested.has(failure.token) || seen.has(failure.token)) throw new DomainError('UPSTREAM_ERROR', 'Provider metadata failures did not match unique requested resources.');
      seen.add(failure.token);
    }
    const items = parsed.map(request => {
      const meta = response.data.metas.find(item => item.doc_token === request.doc_token);
      const failure = response.data.failed_list?.find(item => item.token === request.doc_token);
      return { ...request, status: meta ? 'ok' as const : failure ? 'failed' as const : 'unknown' as const, metadata: meta ? { title: meta.title, owner_open_id: meta.owner_id ?? null, created_at_provider: meta.create_time ?? null, updated_at_provider: meta.latest_modify_time ?? null, url: safeUrl(meta.url) } : null, provider_code: failure?.code ?? null };
    });
    return { items, partial: items.some(item => item.status !== 'ok'), coverage: 'metadata_only' as const, source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
  }
  async tasks(identity: Identity, completed: boolean | undefined, page: Page = {}) {
    const params = this.token('tasks', { completed }, page, identity);
    const raw = await this.gateway.call('listTasks', { params: { user_id_type: 'open_id', ...(completed !== undefined ? { completed } : {}), page_size: params.pageSize, ...(params.upstream ? { page_token: params.upstream } : {}) } }, identity);
    return { tasks: (raw.items ?? []).map(item => { if (!item.guid) throw new DomainError('UPSTREAM_ERROR', 'Provider task was missing a guid.'); return { task_id: item.guid, title: item.summary ?? '', description: item.description ?? '', completed_at: item.completed_at ?? null, due: item.due ?? null }; }), next_cursor: this.next('tasks', { completed }, params.pageSize, raw.has_more, raw.page_token, identity, params.history), source: 'feishu_api' as const, coverage: 'tasks_assigned_to_current_user' as const };
  }
  async task(identity: Identity, taskId: string) {
    id.parse(taskId); const raw = await this.gateway.call('getTask', { path: { task_guid: taskId }, params: { user_id_type: 'open_id' } }, identity);
    if (raw.task?.guid !== taskId) throw new DomainError('UPSTREAM_ERROR', 'Provider task response was incomplete or mismatched.');
    return { task_id: raw.task.guid, title: raw.task.summary ?? '', description: raw.task.description ?? '', due: raw.task.due ?? null, completed_at: raw.task.completed_at ?? null, source: 'feishu_api' as const };
  }
  /** Explicit lower-level schemas preserve SDK field names; high-level Base/calendar mappers are the next slice. */
  async baseTables(identity: Identity, input: SdkReadInput<'listBaseTables'>) { return this.gateway.call('listBaseTables', input, identity); }
  async baseFields(identity: Identity, input: SdkReadInput<'listBaseFields'>) { return this.gateway.call('listBaseFields', input, identity); }
  async baseRecords(identity: Identity, input: SdkReadInput<'searchBaseRecords'>) { return this.gateway.call('searchBaseRecords', input, identity); }
  async calendars(identity: Identity, input: SdkReadInput<'listCalendars'>) { return this.gateway.call('listCalendars', input, identity); }
  async calendarEvents(identity: Identity, input: SdkReadInput<'listEvents'>) { return this.gateway.call('listEvents', input, identity); }
}
