import { z } from 'zod';
import { digest, DomainError, Handles, requireScope, type Identity } from '../../policy/src/core.js';
import { FeishuSdkReadGateway } from './sdk-reads.js';
import { FeishuProviderDomains } from './provider-domains.js';

const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const pageSchema = z.object({ page_size: z.number().int().min(1).max(20).default(20), cursor: z.string().min(1).max(4096).optional() }).strict();
type Page = z.input<typeof pageSchema>;
const plain = (value: string): string => value.replace(/<[^>]*>/g, '');
function safeUrl(value?: string): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (url.hostname.endsWith('.feishu.cn') || url.hostname.endsWith('.larksuite.com')) ? url.href : null; } catch { return null; }
}

/** Keyword candidates -> explicit Base -> explicit table -> reviewed schema/query. No all-app enumeration. */
export class FeishuProviderBases {
  constructor(private readonly gateway: FeishuSdkReadGateway, private readonly domains: FeishuProviderDomains, private readonly handles: Handles) {}
  private page(identity: Identity, operation: string, query: unknown, input: Page) {
    requireScope(identity, 'base.read');
    const page = pageSchema.parse(input); const fingerprint = digest(JSON.stringify(query)); let token: string | undefined; let history: string[] = [];
    if (page.cursor) {
      const cursor = this.handles.decode('cursor', identity, page.cursor);
      if (cursor.operation !== operation || cursor.fingerprint !== fingerprint || cursor.pageSize !== page.page_size || typeof cursor.token !== 'string' || !Array.isArray(cursor.history) || cursor.history.length > 20 || cursor.history.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) throw new DomainError('INVALID_ARGUMENT', 'Base cursor does not match this query.');
      token = cursor.token; history = cursor.history as string[];
    }
    return { size: page.page_size, token, next: (hasMore: boolean | undefined, nextToken: string | undefined) => {
      if (typeof hasMore !== 'boolean' || (hasMore && (typeof nextToken !== 'string' || !nextToken))) throw new DomainError('UPSTREAM_ERROR', 'Base pagination was incomplete.');
      if (!hasMore) return null;
      const hash = digest(nextToken!);
      if (history.includes(hash)) throw new DomainError('UPSTREAM_ERROR', 'Provider repeated a Base pagination token.');
      if (history.length >= 20) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Base pagination exceeds the supported budget.');
      const cursor = this.handles.encode('cursor', identity, { operation, fingerprint, query, pageSize: page.page_size, token: nextToken, history: [...history, hash] });
      if (cursor.length > 4096) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Base cursor exceeds the supported reference size.');
      return cursor;
    } };
  }
  async search(identity: Identity, query: string | undefined, input: Page = {}) {
    requireScope(identity, 'base.read');
    if (query === undefined) throw new DomainError('UNSUPPORTED_CAPABILITY', 'All-Base enumeration is not available. Supply a title keyword.');
    const keyword = z.string().trim().min(1).refine(value => Array.from(value).length <= 30, 'Base search supports at most 30 Unicode characters.').parse(query);
    const page = this.page(identity, 'base_candidates', { keyword }, input);
    const raw = await this.gateway.call('searchBases', { data: { query: keyword, page_size: page.size, ...(page.token ? { page_token: page.token } : {}) } }, identity);
    const parsed = z.array(z.object({ entity_type: z.enum(['DOC', 'WIKI']), title_highlighted: z.string().optional(), title: z.string().optional(), result_meta: z.object({ token: id, doc_types: z.literal('BITABLE'), url: z.string().optional() }) })).max(page.size).safeParse(raw.res_units);
    if (!parsed.success) throw new DomainError('UPSTREAM_ERROR', 'Provider Base candidates were malformed or oversized.');
    if (new Set(parsed.data.map(item => `${item.entity_type}:${item.result_meta.token}`)).size !== parsed.data.length) throw new DomainError('UPSTREAM_ERROR', 'Provider repeated a Base candidate within one page.');
    const next = page.next(raw.has_more, raw.page_token);
    const candidates = parsed.data.map(item => ({ base_ref: this.handles.encode('resource', identity, { kind: 'base_candidate', token: item.result_meta.token, container: item.entity_type }), base_id: item.entity_type === 'DOC' ? item.result_meta.token : null, wiki_node_token: item.entity_type === 'WIKI' ? item.result_meta.token : null, title: plain(item.title_highlighted ?? item.title ?? ''), url: safeUrl(item.result_meta.url), resolved: item.entity_type === 'DOC' }));
    return { candidates, ambiguous: candidates.length > 1 || next !== null, selection_required: true, coverage: 'keyword_candidates' as const, next_cursor: next, source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
  }
  async inspect(identity: Identity, input: { base_id?: string; base_ref?: string; table_id?: string }, pageInput: Page = {}) {
    requireScope(identity, 'base.read');
    const parsed = z.object({ base_id: id.optional(), base_ref: z.string().min(1).max(4096).optional(), table_id: id.optional() }).strict().refine(value => Boolean(value.base_id) !== Boolean(value.base_ref), 'Select exactly one Base ID or signed candidate reference.').parse(input);
    const pageOptions = pageSchema.parse(pageInput);
    const selection = parsed.base_ref ?? parsed.base_id!;
    if (pageOptions.cursor) {
      if (parsed.table_id) throw new DomainError('INVALID_ARGUMENT', 'A table schema has no table-list continuation.');
      const cursor = this.handles.decode('cursor', identity, pageOptions.cursor);
      if (cursor.operation !== 'base_tables' || typeof cursor.query !== 'object' || cursor.query === null || (cursor.query as Record<string, unknown>).selection !== selection || cursor.pageSize !== pageOptions.page_size) throw new DomainError('INVALID_ARGUMENT', 'Base cursor does not match this selection.');
    }
    let baseId = parsed.base_id;
    if (parsed.base_ref) {
      const ref = this.handles.decode('resource', identity, parsed.base_ref);
      if (ref.kind !== 'base_candidate' || !['DOC', 'WIKI'].includes(String(ref.container))) throw new DomainError('INVALID_ARGUMENT', 'Select a valid Base candidate.');
      const token = id.parse(ref.token);
      if (ref.container === 'WIKI') {
        const raw = await this.gateway.call('resolveBaseWiki', { params: { token } }, identity);
        baseId = id.parse(raw.node?.obj_token);
      } else baseId = token;
    }
    if (parsed.table_id) {
      return { ...(await this.domains.baseSchema(identity, baseId!, parsed.table_id)), coverage: 'selected_table_schema' as const, selection_required: false as const };
    }
    const page = this.page(identity, 'base_tables', { baseId, selection }, pageOptions);
    const raw = await this.gateway.call('listBaseTables', { path: { app_token: baseId! }, params: { page_size: page.size, ...(page.token ? { page_token: page.token } : {}) } }, identity);
    const tables = z.array(z.object({ table_id: id, name: z.string() })).max(page.size).safeParse(raw.items);
    if (!tables.success || new Set(tables.data.map(table => table.table_id)).size !== tables.data.length) throw new DomainError('UPSTREAM_ERROR', 'Provider table candidates were malformed or duplicated.');
    return { base_id: baseId!, tables: tables.data, next_cursor: page.next(raw.has_more, raw.page_token), selection_required: true as const, coverage: 'table_candidates' as const, source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
  }
}
