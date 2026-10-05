import { z } from 'zod';
import { digest, DomainError, Handles, requireScope, type Identity } from '../../policy/src/core.js';
import { FeishuProviderReads } from './provider-reads.js';
import { FeishuProviderDomains } from './provider-domains.js';
import { FeishuSdkReadGateway } from './sdk-reads.js';

const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const searchInput = z.object({ query: z.string().trim().min(1).refine(value => Array.from(value).length <= 30, 'Unified search supports at most 30 Unicode characters.'), types: z.array(z.enum(['doc', 'wiki', 'message', 'file'])).min(1).max(4).default(['doc', 'wiki', 'message']), page_size: z.number().int().min(1).max(20).default(20), cursor: z.string().min(1).max(4096).optional() }).strict();
type SearchInput = z.input<typeof searchInput>;
interface SearchHit { result_id: string; type: 'doc' | 'wiki' | 'message' | 'file'; title: string; snippet: string; url: string | null }
const commentCursorSchema = z.object({ operation: z.enum(['comments', 'comment_replies']), documentId: id, commentId: id.optional(), pageSize: z.number().int().min(1).max(50), upstream: z.string().min(1).nullable(), history: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20) });
type CommentCursor = z.infer<typeof commentCursorSchema>;
const replySchema = z.object({ reply_id: id, user_id: z.string().optional(), content: z.object({ elements: z.array(z.discriminatedUnion('type', [z.object({ type: z.literal('text_run'), text_run: z.object({ text: z.string() }) }), z.object({ type: z.literal('docs_link'), docs_link: z.object({ url: z.string() }) }), z.object({ type: z.literal('person'), person: z.object({ user_id: z.string() }) })])) }) });

/** Specific read workflows over the reviewed provider adapters; still not exposed through a live HTTP listener. */
export class FeishuProviderWorkflows {
  constructor(private readonly reads: FeishuProviderReads, private readonly domains: FeishuProviderDomains, private readonly gateway: FeishuSdkReadGateway, private readonly handles: Handles) {}
  async search(identity: Identity, input: SearchInput) {
    requireScope(identity, 'search.read');
    const parsed = searchInput.parse(input); const types = [...new Set(parsed.types)];
    const missing = [...new Set(types.filter(type => !identity.scopes.includes(type === 'message' ? 'im.read' : 'docs.read')).map(type => type === 'message' ? 'im.read' : 'docs.read'))];
    const allowed = types.filter(type => identity.scopes.includes(type === 'message' ? 'im.read' : 'docs.read'));
    const domains = [...(allowed.some(type => type !== 'message') ? ['docs'] : []), ...(allowed.includes('message') ? ['messages'] : [])];
    if (!domains.length) throw new DomainError('INSUFFICIENT_SCOPE', 'No requested search domain is authorized.', missing[0]);
    const query = { query: parsed.query, types, page_size: parsed.page_size, domains, scopes: [...identity.scopes].sort() };
    const fingerprint = digest(JSON.stringify(query));
    let index = 0; let upstream: string | undefined;
    if (parsed.cursor) {
      const previous = this.handles.decode('cursor', identity, parsed.cursor);
      if (previous.operation !== 'unified_search' || previous.fingerprint !== fingerprint || !Number.isInteger(previous.index) || Number(previous.index) < 0 || Number(previous.index) >= domains.length || (previous.upstream !== null && typeof previous.upstream !== 'string')) throw new DomainError('INVALID_ARGUMENT', 'Search cursor no longer matches the query or permissions.');
      index = Number(previous.index); upstream = previous.upstream === null ? undefined : previous.upstream as string;
    }
    let results: SearchHit[] = [];
    let nextCursor: string | null = null;
    // At most one page from each authorized domain in a call. Every continuation is explicit.
    while (index < domains.length) {
      if (domains[index] === 'docs') {
        const providerTypes: ('DOCX' | 'WIKI' | 'FILE')[] = [...(allowed.some(type => type === 'doc' || type === 'wiki') ? ['DOCX', 'WIKI'] as const : []), ...(allowed.includes('file') ? ['FILE'] as const : [])];
        const page = await this.reads.searchDocuments(identity, parsed.query, providerTypes, { page_size: parsed.page_size, cursor: upstream });
        results = page.results.flatMap(result => {
          const type = result.resource_type === 'FILE' ? 'file' as const : result.resource_type === 'WIKI' || result.container_type === 'WIKI' ? 'wiki' as const : 'doc' as const;
          if (!allowed.includes(type)) return [];
          return [{ result_id: this.handles.encode('resource', identity, { provider: 'feishu', kind: type, id: result.resource_token, ...(type === 'file' ? { wiki: result.container_type === 'WIKI' } : {}) }), type, title: result.title, snippet: result.snippet, url: result.url }];
        });
        upstream = page.next_cursor ?? undefined;
      } else {
        const page = await this.reads.searchMessages(identity, { query: parsed.query }, { page_size: parsed.page_size, cursor: upstream });
        results = page.messages.map(result => ({ result_id: this.handles.encode('resource', identity, { provider: 'feishu', kind: 'message', id: result.message_id }), type: 'message', title: result.snippet.slice(0, 80), snippet: result.snippet, url: null }));
        upstream = page.next_cursor ?? undefined;
      }
      if (!upstream) index++;
      nextCursor = null;
      if (index < domains.length) {
        nextCursor = this.handles.encode('cursor', identity, { operation: 'unified_search', fingerprint, index, upstream: upstream ?? null });
        if (nextCursor.length > 4096) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Provider cursor exceeds the supported reference size. Narrow the search domain.');
      }
      if (results.length || upstream || index >= domains.length) break;
    }
    return { results, next_cursor: nextCursor, partial: missing.length > 0, missing_scopes: missing, ordering: 'documents_then_messages' as const, source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
  }
  async fetch(identity: Identity, input: { result_id: string; max_chars?: number; cursor?: string }) {
    requireScope(identity, 'search.read');
    const parsed = z.object({ result_id: z.string().min(1).max(4096), max_chars: z.number().int().min(20).max(20_000).default(8000), cursor: z.string().max(4096).optional() }).strict().parse(input);
    const reference = this.handles.decode('resource', identity, parsed.result_id);
    if (reference.provider !== 'feishu' || !['doc', 'wiki', 'message', 'file'].includes(String(reference.kind))) throw new DomainError('INVALID_ARGUMENT', 'Unknown provider resource reference.');
    const resourceId = id.parse(reference.id);
    if (reference.kind === 'file') {
      requireScope(identity, 'docs.read');
      if (parsed.cursor) throw new DomainError('INVALID_ARGUMENT', 'File metadata does not have a content continuation.');
      let fileId = resourceId;
      if (reference.wiki === true) {
        const node = await this.gateway.call('getWikiNode', { params: { token: resourceId, obj_type: 'wiki' } }, identity);
        if (node.node?.obj_type !== 'file' || !node.node.obj_token) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Wiki search result did not resolve to file metadata.');
        fileId = id.parse(node.node.obj_token);
      }
      const result = await this.reads.metadata(identity, [{ doc_token: fileId, doc_type: 'file' }]);
      const item = result.items[0]!;
      return { title: item.metadata?.title ?? null, type: 'file' as const, content: null, metadata: item.metadata, status: item.status, provider_code: item.provider_code, partial: result.partial, coverage: 'metadata_only' as const, truncated: false, next_cursor: null, source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
    }
    let title: string; let content: string;
    if (reference.kind === 'message') {
      requireScope(identity, 'im.read');
      const raw = await this.gateway.call('getMessages', { path: { message_id: resourceId }, params: { user_id_type: 'open_id' } }, identity);
      const message = raw.items?.find(item => item.message_id === resourceId && !item.deleted);
      if (!message?.body || typeof message.body.content !== 'string') throw new DomainError('NOT_FOUND', 'Message content is not available.');
      if (message.msg_type === 'text') {
        try { content = z.object({ text: z.string() }).parse(JSON.parse(message.body.content)).text; } catch { throw new DomainError('UPSTREAM_ERROR', 'Message body did not match its declared format.'); }
      } else { content = message.body.content; }
      title = content.slice(0, 80);
    } else {
      requireScope(identity, 'docs.read');
      let documentId = resourceId;
      if (reference.kind === 'wiki') {
        const response = await this.gateway.call('getWikiNode', { params: { token: resourceId, obj_type: 'wiki' } }, identity);
        if (response.node?.obj_type !== 'docx' || !response.node.obj_token) throw new DomainError('UNSUPPORTED_CAPABILITY', 'This Wiki node is not a readable DOCX document in the current provider slice.');
        documentId = id.parse(response.node.obj_token);
      }
      const document = await this.reads.document(identity, documentId);
      title = document.title; content = document.content;
    }
    const page = this.handles.paginate(Array.from(content), identity, { operation: 'provider_fetch', result_id: parsed.result_id, max_chars: parsed.max_chars, content_version: digest(content) }, parsed.max_chars, parsed.cursor);
    return { title, type: reference.kind, content: page.items.join(''), truncated: page.next_cursor !== null, next_cursor: page.next_cursor, source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
  }
  async comments(identity: Identity, documentId: string, input: { page_size?: number; cursor?: string } = {}) {
    id.parse(documentId); requireScope(identity, 'docs.read');
    const page = z.object({ page_size: z.number().int().min(1).max(50).default(20), cursor: z.string().max(4096).optional() }).strict().parse(input);
    let context: CommentCursor = { operation: 'comments', documentId, pageSize: page.page_size, upstream: null, history: [] };
    if (page.cursor) {
      const decoded = commentCursorSchema.safeParse(this.handles.decode('cursor', identity, page.cursor));
      if (!decoded.success || decoded.data.documentId !== documentId || decoded.data.pageSize !== page.page_size || (decoded.data.operation === 'comment_replies' && !decoded.data.commentId)) throw new DomainError('INVALID_ARGUMENT', 'Comment cursor belongs to another query.');
      context = decoded.data;
    }
    const upstream = context.upstream ?? undefined;
    if (context.operation === 'comment_replies') {
      const raw = await this.gateway.call('listCommentReplies', { path: { file_token: documentId, comment_id: context.commentId! }, params: { file_type: 'docx', user_id_type: 'open_id', page_size: page.page_size, ...(upstream ? { page_token: upstream } : {}) } }, identity);
      if (!Array.isArray(raw.items) || raw.items.length > page.page_size) throw new DomainError('UPSTREAM_ERROR', 'Provider reply page was missing or oversized.');
      const next = this.nextCommentCursor(identity, context, raw.has_more, raw.page_token);
      const replies = raw.items.map((reply, index) => ({ ...this.commentReply(reply), is_root: !upstream && index === 0 }));
      if (new Set(replies.map(reply => reply.reply_id)).size !== replies.length) throw new DomainError('UPSTREAM_ERROR', 'Provider repeated a reply within one page.');
      return { comments: [{ comment_id: context.commentId!, replies, replies_complete: !upstream && next === null, reply_cursor: next }], partial: Boolean(upstream) || next !== null, reply_sequence_complete: next === null, next_cursor: next, coverage: 'comment_replies_page' as const, replaces_preview: !upstream, merge_by: 'reply_id' as const, source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
    }
    const raw = await this.gateway.call('listDocComments', { path: { file_token: documentId }, params: { file_type: 'docx', page_size: page.page_size, user_id_type: 'open_id', ...(upstream ? { page_token: upstream } : {}) } }, identity);
    if (!Array.isArray(raw.items) || raw.items.length > page.page_size) throw new DomainError('UPSTREAM_ERROR', 'Provider comment page was missing or oversized.');
    const next = this.nextCommentCursor(identity, context, raw.has_more, raw.page_token);
    const comments = raw.items.map(comment => {
      if (!comment.comment_id) throw new DomainError('UPSTREAM_ERROR', 'Comment ID was missing.');
      const complete = comment.has_more === false && Array.isArray(comment.reply_list?.replies);
      return { comment_id: comment.comment_id, author_open_id: comment.user_id ?? null, quote: comment.quote ?? '', solved: comment.is_solved ?? null, replies: (comment.reply_list?.replies ?? []).map(reply => this.commentReply(reply)), replies_complete: complete, reply_cursor: complete ? null : this.encodeCommentCursor(identity, { operation: 'comment_replies', documentId, commentId: id.parse(comment.comment_id), pageSize: page.page_size, upstream: null, history: [] }) };
    });
    return { comments, partial: next !== null || comments.some(comment => !comment.replies_complete), next_cursor: next, coverage: 'comments_page' as const, source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
  }
  private commentReply(raw: unknown) {
    const reply = replySchema.safeParse(raw);
    if (!reply.success) throw new DomainError('UPSTREAM_ERROR', 'Provider comment reply was incomplete.');
    return { reply_id: reply.data.reply_id, author_open_id: reply.data.user_id ?? null, elements: reply.data.content.elements };
  }
  private encodeCommentCursor(identity: Identity, value: CommentCursor): string {
    const cursor = this.handles.encode('cursor', identity, value);
    if (cursor.length > 4096) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Comment cursor exceeds the supported size.');
    return cursor;
  }
  private nextCommentCursor(identity: Identity, context: CommentCursor, hasMore: boolean | undefined, token: string | undefined) {
    if (typeof hasMore !== 'boolean' || (hasMore && (!token || typeof token !== 'string'))) throw new DomainError('UPSTREAM_ERROR', 'Comment pagination was incomplete.');
    if (!hasMore) return null;
    const hash = digest(token!);
    if (context.history.includes(hash)) throw new DomainError('UPSTREAM_ERROR', 'Provider repeated a comment pagination token.');
    if (context.history.length >= 20) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Comment pagination exceeds the supported budget.');
    return this.encodeCommentCursor(identity, { ...context, upstream: token!, history: [...context.history, hash] });
  }
  async messageThread(identity: Identity, messageId: string, input: { page_size?: number; cursor?: string } = {}) {
    id.parse(messageId); requireScope(identity, 'im.read');
    const page = z.object({ page_size: z.number().int().min(1).max(50).default(20), cursor: z.string().max(4096).optional() }).strict().parse(input);
    const initial = await this.gateway.call('getMessages', { path: { message_id: messageId }, params: { user_id_type: 'open_id' } }, identity);
    const root = initial.items?.find(message => message.message_id === messageId && !message.deleted);
    if (!root) throw new DomainError('NOT_FOUND', 'The requested message is not visible.');
    if (!root.thread_id) {
      if (page.cursor) throw new DomainError('INVALID_ARGUMENT', 'A standalone message has no thread continuation.');
      return { messages: [this.messageSummary(root)], next_cursor: null, thread_id: null, coverage: 'standalone_message' as const, source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
    }
    id.parse(root.thread_id);
    let upstream: string | undefined;
    if (page.cursor) { const cursor = this.handles.decode('cursor', identity, page.cursor); if (cursor.operation !== 'message_thread' || cursor.messageId !== messageId || cursor.threadId !== root.thread_id || cursor.pageSize !== page.page_size || typeof cursor.upstream !== 'string') throw new DomainError('INVALID_ARGUMENT', 'Thread cursor belongs to another message.'); upstream = cursor.upstream; }
    // Official CLI reference confirms this concrete read endpoint and container_id_type=thread.
    const response = await this.gateway.call('listMessages', { params: { container_id_type: 'thread', container_id: root.thread_id, sort_type: 'ByCreateTimeAsc', page_size: page.page_size, ...(upstream ? { page_token: upstream } : {}) } }, identity);
    if (response.has_more && !response.page_token) throw new DomainError('UPSTREAM_ERROR', 'Thread pagination was incomplete.');
    const messages = (response.items ?? []).filter(message => !message.deleted).map(message => {
      if (!message.message_id || message.thread_id !== root.thread_id || (root.chat_id && message.chat_id !== root.chat_id)) throw new DomainError('UPSTREAM_ERROR', 'Provider returned a message outside the requested thread.');
      return this.messageSummary(message);
    });
    return { messages, thread_id: root.thread_id, next_cursor: response.has_more ? this.handles.encode('cursor', identity, { operation: 'message_thread', messageId, threadId: root.thread_id, pageSize: page.page_size, upstream: response.page_token }) : null, coverage: 'thread_messages' as const, source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
  }
  private messageSummary(message: { message_id?: string; chat_id?: string; thread_id?: string; msg_type?: string; body?: { content: string }; sender?: { id: string }; create_time?: string }) {
    if (!message.body || typeof message.body.content !== 'string') throw new DomainError('UPSTREAM_ERROR', 'Provider did not return the message body.');
    let content = message.body.content;
    if (message.msg_type === 'text' && content) { try { content = z.object({ text: z.string() }).parse(JSON.parse(content)).text; } catch { throw new DomainError('UPSTREAM_ERROR', 'Message body did not match its declared format.'); } }
    return { message_id: message.message_id ?? null, chat_id: message.chat_id ?? null, thread_id: message.thread_id ?? null, sender_id: message.sender?.id ?? null, created_at_provider: message.create_time ?? null, type: message.msg_type ?? null, content };
  }
  async suggestMeetingTimes(identity: Identity, input: { people: string[]; time_range: { start: string; end: string }; timezone: string; duration_minutes: number; limit?: number }) {
    const parsed = z.object({ people: z.array(id).min(1).max(20), time_range: z.object({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) }).strict(), timezone: z.string().min(1).max(100), duration_minutes: z.number().int().min(15).max(480), limit: z.number().int().min(2).max(5).default(3) }).strict().parse(input);
    // The domain layer validates timezone, range, complete person coverage and interval shape.
    const availability = await this.domains.freeBusy(identity, { people: parsed.people, time_range: parsed.time_range, timezone: parsed.timezone });
    if (!availability.complete) throw new DomainError('PERMISSION_DENIED', 'Availability is unknown for one or more participants; no meeting times can be safely recommended.');
    const busy = availability.people.flatMap(person => person.busy); const duration = parsed.duration_minutes * 60_000;
    const slots: { start: string; end: string; local_start: string; local_end: string }[] = [];
    const format = new Intl.DateTimeFormat('sv-SE', { timeZone: parsed.timezone, dateStyle: 'short', timeStyle: 'short' });
    for (let start = Date.parse(parsed.time_range.start); start + duration <= Date.parse(parsed.time_range.end) && slots.length < parsed.limit; start += 15 * 60_000) {
      const end = start + duration;
      if (!busy.some(interval => Date.parse(interval.start) < end && Date.parse(interval.end) > start)) slots.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), local_start: format.format(new Date(start)), local_end: format.format(new Date(end)) });
    }
    return { slots, timezone: parsed.timezone, requested_count: parsed.limit, count: slots.length, source: 'feishu_api' as const, action_taken: false };
  }
}
