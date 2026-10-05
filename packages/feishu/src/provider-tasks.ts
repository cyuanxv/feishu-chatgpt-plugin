import { z } from 'zod';
import { digest, DomainError, Handles, requireScope, type Identity } from '../../policy/src/core.js';
import { FeishuSdkReadGateway } from './sdk-reads.js';

const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const pageSchema = z.object({ page_size: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(4096).optional() }).strict();
type Page = z.input<typeof pageSchema>;
const querySchema = z.object({ tasklist_id: id.optional(), assignee_id: id.optional(), status: z.enum(['todo', 'done']).optional() }).strict();
const memberSchema = z.object({ id: id.optional(), type: z.string().optional(), role: z.string().optional() });
const taskSchema = z.object({ guid: id, summary: z.string(), description: z.string().optional(), completed_at: z.string().regex(/^\d+$/).optional(), members: z.array(memberSchema).optional(), due: z.object({ timestamp: z.string().regex(/^\d+$/).optional(), is_all_day: z.boolean().optional() }).optional() });
type Task = z.infer<typeof taskSchema>;
type Omitted = { task_id: string; reason: string };

/** Closed task-read workflows. Explicit assignee IDs only; no name guessing or external writes. */
export class FeishuProviderTasks {
  constructor(private readonly gateway: FeishuSdkReadGateway, private readonly handles: Handles) {}
  private page(identity: Identity, operation: string, query: unknown, input: Page) {
    requireScope(identity, 'task.read');
    const page = pageSchema.parse(input); const fingerprint = digest(JSON.stringify({ query, scopes: [...identity.scopes].sort() }));
    let token: string | undefined; let history: string[] = [];
    if (page.cursor) {
      const cursor = this.handles.decode('cursor', identity, page.cursor);
      if (cursor.operation !== operation || cursor.fingerprint !== fingerprint || cursor.pageSize !== page.page_size || typeof cursor.token !== 'string' || !Array.isArray(cursor.history) || cursor.history.length > 20 || cursor.history.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) throw new DomainError('INVALID_ARGUMENT', 'Task cursor does not match this query.');
      token = cursor.token; history = cursor.history as string[];
    }
    return { size: page.page_size, token, next: (hasMore: boolean | undefined, nextToken: string | undefined) => {
      if (typeof hasMore !== 'boolean' || (hasMore && (typeof nextToken !== 'string' || !nextToken))) throw new DomainError('UPSTREAM_ERROR', 'Provider task pagination was incomplete.');
      if (!hasMore) return null;
      const hash = digest(nextToken!);
      if (history.includes(hash)) throw new DomainError('UPSTREAM_ERROR', 'Provider repeated a task pagination token.');
      if (history.length >= 20) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Task pagination exceeds the supported budget. Narrow the query.');
      const cursor = this.handles.encode('cursor', identity, { operation, fingerprint, pageSize: page.page_size, token: nextToken, history: [...history, hash] });
      if (cursor.length > 4096) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Task pagination reference exceeds the supported size.');
      return cursor;
    } };
  }
  private parseTask(raw: unknown, expectedId?: string): Task {
    const task = taskSchema.safeParse(raw);
    if (!task.success || (expectedId && task.data.guid !== expectedId)) throw new DomainError('UPSTREAM_ERROR', 'Provider task details were malformed or mismatched.');
    return task.data;
  }
  private summary(task: Task) {
    const membersKnown = task.members?.every(member => member.id && member.type && member.role);
    return { task_id: task.guid, title: task.summary, description: task.description ?? null, completed: task.completed_at === undefined ? null : !/^0+$/.test(task.completed_at), completed_at: task.completed_at ?? null, assignee_open_ids: membersKnown ? task.members!.filter(member => member.role === 'assignee' && member.type === 'user').map(member => member.id!) : null, due: task.due ?? null };
  }
  private exclusion(task: Task, query: z.infer<typeof querySchema>): string | null {
    if (query.assignee_id) {
      if (!task.members || task.members.some(member => !member.id || !member.type || !member.role)) return 'unknown_membership';
      if (!task.members.some(member => member.id === query.assignee_id && member.type === 'user' && member.role === 'assignee')) return 'filter_mismatch';
    }
    if (query.status) {
      if (task.completed_at === undefined) return 'unknown_completion';
      if ((!/^0+$/.test(task.completed_at)) !== (query.status === 'done')) return 'filter_mismatch';
    }
    return null;
  }
  async detail(identity: Identity, taskId: string) {
    id.parse(taskId);
    const response = await this.gateway.call('getTask', { path: { task_guid: taskId }, params: { user_id_type: 'open_id' } }, identity);
    return { ...this.summary(this.parseTask(response.task, taskId)), source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
  }
  async tasklists(identity: Identity, input: Page = {}) {
    const page = this.page(identity, 'tasklists', {}, input);
    const raw = await this.gateway.call('listTasklists', { params: { page_size: page.size, user_id_type: 'open_id', ...(page.token ? { page_token: page.token } : {}) } }, identity);
    const items = z.array(z.object({ guid: id, name: z.string() })).max(page.size).safeParse(raw.items);
    if (!items.success || new Set(items.data.map(item => item.guid)).size !== items.data.length) throw new DomainError('UPSTREAM_ERROR', 'Provider tasklist page was malformed.');
    return { tasklists: items.data.map(item => ({ tasklist_id: item.guid, name: item.name })), next_cursor: page.next(raw.has_more, raw.page_token), source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
  }
  async list(identity: Identity, queryInput: z.input<typeof querySchema>, input: Page = {}) {
    const query = querySchema.parse(queryInput); const page = this.page(identity, 'task_query', query, input);
    const completed = query.status === undefined ? undefined : query.status === 'done';
    const params = { user_id_type: 'open_id' as const, page_size: page.size, ...(page.token ? { page_token: page.token } : {}), ...(completed === undefined ? {} : { completed }) };
    const omitted: Omitted[] = []; let tasks: Task[]; let next: string | null; let notice: string | null = null;
    let coverage: 'tasks_assigned_to_current_user' | 'tasks_in_requested_list' | 'visible_tasks_for_explicit_assignee';
    if (query.tasklist_id) {
      coverage = 'tasks_in_requested_list';
      const raw = await this.gateway.call('listTasklistTasks', { path: { tasklist_guid: query.tasklist_id }, params }, identity);
      if (!Array.isArray(raw.items) || raw.items.length > page.size) throw new DomainError('UPSTREAM_ERROR', 'Provider task page was missing or oversized.');
      tasks = raw.items.map(item => this.parseTask(item)); next = page.next(raw.has_more, raw.page_token);
    } else if (query.assignee_id) {
      coverage = 'visible_tasks_for_explicit_assignee';
      // This is a local fan-out limit, not a claimed provider page-size maximum.
      if (page.size > 20) throw new DomainError('INVALID_ARGUMENT', 'Assignee search permits at most twenty detail checks per page.');
      const raw = await this.gateway.call('searchTasks', { data: { query: '', filter: { assignee_ids: [query.assignee_id], ...(completed === undefined ? {} : { is_completed: completed }) } }, params: { user_id_type: 'open_id', page_size: page.size, ...(page.token ? { page_token: page.token } : {}) } }, identity);
      const hits = z.array(z.object({ id })).max(page.size).safeParse(raw.items);
      if (!hits.success || new Set(hits.data.map(item => item.id)).size !== hits.data.length) throw new DomainError('UPSTREAM_ERROR', 'Provider task search page was malformed or oversized.');
      if (raw.notice !== undefined && typeof raw.notice !== 'string') throw new DomainError('UPSTREAM_ERROR', 'Provider task search notice was malformed.');
      next = page.next(raw.has_more, raw.page_token); notice = typeof raw.notice === 'string' && raw.notice ? raw.notice : null; tasks = [];
      // Sequential detail reads keep concurrency at one and never exceed the requested hit count.
      for (const hit of hits.data) {
        try {
          const detail = await this.gateway.call('getTask', { path: { task_guid: hit.id }, params: { user_id_type: 'open_id' } }, identity);
          tasks.push(this.parseTask(detail.task, hit.id));
        } catch (error) {
          if (!(error instanceof DomainError) || ['AUTH_REQUIRED', 'INSUFFICIENT_SCOPE', 'TOKEN_EXPIRED'].includes(error.type)) throw error;
          omitted.push({ task_id: hit.id, reason: error.type });
        }
      }
    } else {
      coverage = 'tasks_assigned_to_current_user';
      const raw = await this.gateway.call('listTasks', { params: { ...params, type: 'my_tasks' } }, identity);
      if (!Array.isArray(raw.items) || raw.items.length > page.size) throw new DomainError('UPSTREAM_ERROR', 'Provider task page was missing or oversized.');
      tasks = raw.items.map(item => this.parseTask(item)); next = page.next(raw.has_more, raw.page_token);
    }
    if (new Set(tasks.map(task => task.guid)).size !== tasks.length) throw new DomainError('UPSTREAM_ERROR', 'Provider repeated a task within one page.');
    const matches = tasks.filter(task => { const reason = this.exclusion(task, query); if (reason) omitted.push({ task_id: task.guid, reason }); return !reason; });
    return { tasks: matches.map(task => this.summary(task)), omitted, partial: omitted.length > 0 || notice !== null, notice, next_cursor: next, coverage, source: 'feishu_api' as const, content_trust: 'untrusted_source_data' as const };
  }
}
