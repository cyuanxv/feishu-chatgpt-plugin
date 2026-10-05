import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const READ_SCOPES = ['profile.read', 'search.read', 'people.read', 'im.read', 'docs.read', 'base.read', 'calendar.read', 'task.read'] as const;
export type ReadScope = typeof READ_SCOPES[number];
export interface Identity {
  subject: string;
  connectionId: string;
  tenantId: string;
  domain: 'feishu' | 'lark';
  scopes: string[];
}
export type ErrorType = 'AUTH_REQUIRED' | 'INSUFFICIENT_SCOPE' | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'RATE_LIMITED' | 'CONFLICT' | 'TOKEN_EXPIRED' | 'UPSTREAM_ERROR' | 'UNSUPPORTED_CAPABILITY' | 'AMBIGUOUS_TARGET';
export class DomainError extends Error {
  constructor(public readonly type: ErrorType, message: string, public readonly requiredScope?: string) { super(message); }
}
export function requireScope(identity: Identity, scope: string): void {
  if (!identity.scopes.includes(scope)) throw new DomainError('INSUFFICIENT_SCOPE', 'Reconnect with the required permission.', scope);
}
export function requireSameIdentity(left: Identity, right: Pick<Identity, 'tenantId' | 'subject' | 'connectionId'>): void {
  if (left.tenantId !== right.tenantId || left.subject !== right.subject || left.connectionId !== right.connectionId) {
    throw new DomainError('PERMISSION_DENIED', 'This resource is not available to this connection.');
  }
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export function constantEquals(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

/** Authenticated, connection-bound handles. They are references, never access credentials. */
export class Handles {
  constructor(private readonly key: Buffer, private readonly now: () => number = Date.now) {
    if (key.length !== 32) throw new Error('A 32-byte handle key is required.');
  }
  encode(purpose: 'resource' | 'cursor', identity: Identity, value: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify({ ...value, purpose, connection: identity.connectionId, subject: identity.subject, tenant: identity.tenantId, exp: this.now() + 3_600_000 })).toString('base64url');
    return `${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}`;
  }
  decode(purpose: 'resource' | 'cursor', identity: Identity, handle: string): Record<string, unknown> {
    if (handle.length > 4096) throw new DomainError('INVALID_ARGUMENT', 'Invalid or expired reference.');
    const [body, signature, extra] = handle.split('.');
    if (!body || !signature || extra || !constantEquals(signature, createHmac('sha256', this.key).update(body).digest('base64url'))) {
      throw new DomainError('INVALID_ARGUMENT', 'Invalid or expired reference.');
    }
    let data: Record<string, unknown>;
    try { data = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>; }
    catch { throw new DomainError('INVALID_ARGUMENT', 'Invalid or expired reference.'); }
    if (data.purpose !== purpose || typeof data.exp !== 'number' || data.exp <= this.now()) throw new DomainError('INVALID_ARGUMENT', 'Invalid or expired reference.');
    if (data.connection !== identity.connectionId || data.subject !== identity.subject || data.tenant !== identity.tenantId) throw new DomainError('PERMISSION_DENIED', 'Reference belongs to a different connection.');
    return data;
  }
  paginate<T>(items: T[], identity: Identity, query: unknown, pageSize: number, cursor?: string): { items: T[]; next_cursor: string | null } {
    const fingerprint = digest(JSON.stringify(query));
    let offset = 0;
    if (cursor) {
      const data = this.decode('cursor', identity, cursor);
      if (data.fingerprint !== fingerprint || !Number.isSafeInteger(data.offset) || Number(data.offset) < 0) throw new DomainError('INVALID_ARGUMENT', 'Cursor does not match this query.');
      offset = Number(data.offset);
    }
    return {
      items: items.slice(offset, offset + pageSize),
      next_cursor: offset + pageSize < items.length ? this.encode('cursor', identity, { fingerprint, offset: offset + pageSize }) : null,
    };
  }
}

/** Bounded fixed-window limiter; never includes resource names or bodies in keys. */
export class RateLimiter {
  private buckets = new Map<string, { count: number; expires: number }>();
  constructor(private readonly limit = 60, private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}
  check(key: string): void {
    const time = this.now();
    if (this.buckets.size >= 10_000) for (const [k, v] of this.buckets) if (v.expires <= time) this.buckets.delete(k);
    const entry = this.buckets.get(key);
    if (!entry || entry.expires <= time) {
      if (this.buckets.size >= 10_000) throw new DomainError('RATE_LIMITED', 'Request capacity is temporarily exhausted.');
      this.buckets.set(key, { count: 1, expires: time + this.windowMs });
    } else if (++entry.count > this.limit) throw new DomainError('RATE_LIMITED', 'Too many requests. Try again later.');
  }
}
