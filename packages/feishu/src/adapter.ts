import { DomainError, requireSameIdentity, type Identity } from '../../policy/src/core.js';
import type { FeishuTokens, TokenStore } from '../../auth/src/vault.js';

export interface Person { open_id: string; name: string; email: string }
export interface Chat { chat_id: string; name: string }
export interface Message { message_id: string; chat_id: string; thread_id: string; sender_open_id: string; text: string; created_at: string; app_link: string }
export interface Document { doc_id: string; type: 'doc' | 'wiki' | 'file'; title: string; text: string; owner: string; updated_at: string; url: string; comments: { comment_id: string; text: string; author_open_id: string }[] }
export interface Base { base_id: string; name: string; tables: { table_id: string; name: string; fields: { field_id: string; name: string; type: 'text' | 'number' | 'select' }[]; records: { record_id: string; fields: Record<string, string | number>; updated_at: string }[] }[] }
export interface CalendarEvent { event_id: string; summary: string; start: string; end: string; attendee_ids: string[]; room_id: string | null }
export interface Room { room_id: string; name: string; capacity: number }
export interface Task { task_id: string; title: string; description: string; status: 'todo' | 'done'; due: string; assignee_ids: string[]; tasklist_id: string; url: string }
export interface WorkspaceData { people: Person[]; chats: Chat[]; messages: Message[]; documents: Document[]; bases: Base[]; events: CalendarEvent[]; rooms: Room[]; tasks: Task[] }
export interface ReadAdapter { readonly mode: 'mock' | 'live'; read(identity: Identity): Promise<WorkspaceData> }

/** Mock access is still identity checked; all source data is synthetic. */
export class MockFeishuAdapter implements ReadAdapter {
  readonly mode = 'mock' as const;
  constructor(private readonly workspaces: ReadonlyMap<string, { identity: Identity; data: WorkspaceData }>) {}
  async read(identity: Identity): Promise<WorkspaceData> {
    const workspace = this.workspaces.get(identity.connectionId);
    if (!workspace) throw new DomainError('AUTH_REQUIRED', 'Demo connection was not found.');
    requireSameIdentity(identity, workspace.identity);
    return structuredClone(workspace.data);
  }
}

export interface UpstreamFailure { status?: number; code?: string; retryAfterMs?: number }
/** Never forward an upstream message or response body; it may contain private data. */
export function mapUpstreamError(error: UpstreamFailure): DomainError {
  if (error.status === 401) return new DomainError('AUTH_REQUIRED', 'Reconnect your Feishu account.');
  if (error.status === 403) return new DomainError('PERMISSION_DENIED', 'Feishu denied access to this resource.');
  if (error.status === 404) return new DomainError('NOT_FOUND', 'The Feishu resource was not found.');
  if (error.status === 429) return new DomainError('RATE_LIMITED', 'Feishu request limit reached. Retry later.');
  return new DomainError('UPSTREAM_ERROR', 'Feishu is temporarily unavailable.');
}
export async function retryRead<T>(operation: () => Promise<T>, options: { attempts?: number; sleep?: (ms: number) => Promise<void>; jitter?: () => number } = {}): Promise<T> {
  const attempts = Math.min(3, Math.max(1, options.attempts ?? 3));
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await operation(); } catch (raw) {
      const error = typeof raw === 'object' && raw !== null ? raw as UpstreamFailure : {};
      const retryable = error.status === 429 || (error.status !== undefined && error.status >= 500);
      if (!retryable || attempt === attempts - 1) throw mapUpstreamError(error);
      const delay = Math.min(10_000, Math.max(0, error.retryAfterMs ?? 200 * 2 ** attempt + Math.floor((options.jitter ?? Math.random)() * 100)));
      await sleep(delay);
    }
  }
  throw new DomainError('UPSTREAM_ERROR', 'Feishu is temporarily unavailable.');
}

/** In-process singleflight. Production multi-replica refresh also needs a DB lock. */
export class TokenRefreshCoordinator {
  private readonly pending = new Map<string, Promise<FeishuTokens>>();
  constructor(private readonly store: TokenStore, private readonly refresh: (identity: Identity, tokens: FeishuTokens) => Promise<FeishuTokens>, private readonly now: () => number = Date.now) {}
  async get(identity: Identity): Promise<FeishuTokens> {
    const key = JSON.stringify([identity.tenantId, identity.subject, identity.connectionId]);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const run = async (): Promise<FeishuTokens> => {
      const snapshot = await this.store.snapshot(identity);
      const tokens = snapshot?.tokens;
      if (!snapshot || !tokens || tokens.refreshExpiresAt <= this.now()) throw new DomainError('AUTH_REQUIRED', 'Reconnect your Feishu account.');
      if (tokens.expiresAt > this.now() + 30_000) return tokens;
      let next: FeishuTokens;
      try {
        next = await this.refresh(identity, tokens);
      } catch { await this.store.revokeIfCurrent(identity, snapshot.revision); throw new DomainError('AUTH_REQUIRED', 'Feishu authorization expired. Reconnect.'); }
      if (!await this.store.compareAndPut(identity, next, snapshot.revision)) throw new DomainError('CONFLICT', 'Connection changed during refresh. Retry using the current authorization.');
      return next;
    };
    const promise = run(); this.pending.set(key, promise);
    try { return await promise; } finally { this.pending.delete(key); }
  }
}
