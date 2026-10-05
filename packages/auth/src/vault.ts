import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { DomainError, requireSameIdentity, type Identity } from '../../policy/src/core.js';

export interface FeishuTokens { accessToken: string; refreshToken: string; expiresAt: number; refreshExpiresAt: number }
export interface SealedToken { keyId: string; iv: string; tag: string; ciphertext: string }
const aad = (identity: Identity): Buffer => Buffer.from(JSON.stringify([identity.tenantId, identity.subject, identity.connectionId]));

export class TokenCipher {
  constructor(private readonly keys: ReadonlyMap<string, Buffer>, private readonly activeKeyId: string) {
    if (!keys.has(activeKeyId) || [...keys.values()].some(key => key.length !== 32)) throw new Error('Invalid token encryption key configuration.');
  }
  seal(identity: Identity, tokens: FeishuTokens): SealedToken {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, iv);
    cipher.setAAD(aad(identity));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    return { keyId: this.activeKeyId, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
  }
  open(identity: Identity, sealed: SealedToken): FeishuTokens {
    try {
      const key = this.keys.get(sealed.keyId);
      if (!key) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'));
      decipher.setAAD(aad(identity));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
      const tokens = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64url')), decipher.final()]).toString()) as FeishuTokens;
      if (typeof tokens.accessToken !== 'string' || typeof tokens.refreshToken !== 'string' || !Number.isFinite(tokens.expiresAt) || !Number.isFinite(tokens.refreshExpiresAt)) throw new Error();
      return tokens;
    } catch { throw new DomainError('AUTH_REQUIRED', 'Connection credentials cannot be read. Reconnect.'); }
  }
}

export interface TokenStore {
  put(identity: Identity, tokens: FeishuTokens): Promise<void>;
  get(identity: Identity): Promise<FeishuTokens | null>;
  snapshot(identity: Identity): Promise<{ tokens: FeishuTokens; revision: string } | null>;
  compareAndPut(identity: Identity, tokens: FeishuTokens, revision: string): Promise<boolean>;
  revokeIfCurrent(identity: Identity, revision: string): Promise<void>;
  revoke(identity: Identity): Promise<void>;
}
export class MemoryTokenStore implements TokenStore {
  private readonly records = new Map<string, { owner: Identity; sealed: SealedToken; revision: number }>();
  private readonly revoked = new Map<string, Identity>();
  constructor(private readonly cipher: TokenCipher) {}
  async put(identity: Identity, tokens: FeishuTokens): Promise<void> {
    const revokedOwner = this.revoked.get(identity.connectionId);
    if (revokedOwner) { requireSameIdentity(identity, revokedOwner); throw new DomainError('AUTH_REQUIRED', 'Connection was revoked. Link a new connection.'); }
    const existing = this.records.get(identity.connectionId);
    if (existing) requireSameIdentity(identity, existing.owner);
    this.records.set(identity.connectionId, { owner: { ...identity, scopes: [...identity.scopes] }, sealed: this.cipher.seal(identity, tokens), revision: (existing?.revision ?? 0) + 1 });
  }
  async get(identity: Identity): Promise<FeishuTokens | null> {
    return (await this.snapshot(identity))?.tokens ?? null;
  }
  async snapshot(identity: Identity): Promise<{ tokens: FeishuTokens; revision: string } | null> {
    const record = this.records.get(identity.connectionId);
    if (!record) return null;
    requireSameIdentity(identity, record.owner);
    return { tokens: this.cipher.open(identity, record.sealed), revision: `1:${record.revision}` };
  }
  async compareAndPut(identity: Identity, tokens: FeishuTokens, revision: string): Promise<boolean> {
    const record = this.records.get(identity.connectionId);
    if (!record || this.revoked.has(identity.connectionId)) return false;
    requireSameIdentity(identity, record.owner);
    if (`1:${record.revision}` !== revision) return false;
    record.sealed = this.cipher.seal(identity, tokens); record.revision++;
    return true;
  }
  async revokeIfCurrent(identity: Identity, revision: string): Promise<void> {
    const record = this.records.get(identity.connectionId);
    if (!record) return;
    requireSameIdentity(identity, record.owner);
    if (`1:${record.revision}` === revision) { this.revoked.set(identity.connectionId, record.owner); this.records.delete(identity.connectionId); }
  }
  async revoke(identity: Identity): Promise<void> {
    const record = this.records.get(identity.connectionId);
    if (record) { requireSameIdentity(identity, record.owner); this.revoked.set(identity.connectionId, record.owner); this.records.delete(identity.connectionId); }
  }
}

/** Persistence adapter only. No connection is created automatically or from ambient credentials. */
export class PostgresTokenStore implements TokenStore {
  constructor(private readonly db: Pick<Pool, 'query'>, private readonly cipher: TokenCipher) {}
  async put(identity: Identity, tokens: FeishuTokens): Promise<void> {
    const encrypted = this.cipher.seal(identity, tokens);
    const result = await this.db.query(`WITH active_connection AS (
      SELECT id FROM feishu_connections WHERE id=$1 AND subject=$2 AND tenant_id=$3 AND status='active' FOR UPDATE
      ) INSERT INTO feishu_tokens (connection_id, subject, tenant_id, sealed, expires_at, refresh_expires_at)
      SELECT $1,$2,$3,$4::jsonb,to_timestamp($5),to_timestamp($6) FROM active_connection
      ON CONFLICT (connection_id) DO UPDATE SET sealed=EXCLUDED.sealed, expires_at=EXCLUDED.expires_at, refresh_expires_at=EXCLUDED.refresh_expires_at, token_revision=feishu_tokens.token_revision+1
      WHERE feishu_tokens.subject=EXCLUDED.subject AND feishu_tokens.tenant_id=EXCLUDED.tenant_id RETURNING connection_id`,
    [identity.connectionId, identity.subject, identity.tenantId, JSON.stringify(encrypted), tokens.expiresAt / 1000, tokens.refreshExpiresAt / 1000]);
    if (result.rowCount !== 1) throw new DomainError('PERMISSION_DENIED', 'Connection identity does not match.');
  }
  async get(identity: Identity): Promise<FeishuTokens | null> {
    return (await this.snapshot(identity))?.tokens ?? null;
  }
  async snapshot(identity: Identity): Promise<{ tokens: FeishuTokens; revision: string } | null> {
    const result = await this.db.query("SELECT t.sealed,t.token_revision,c.grant_generation FROM feishu_tokens t JOIN feishu_connections c ON c.id=t.connection_id AND c.subject=t.subject AND c.tenant_id=t.tenant_id WHERE t.connection_id=$1 AND t.subject=$2 AND t.tenant_id=$3 AND c.status='active'", [identity.connectionId, identity.subject, identity.tenantId]);
    const row = result.rows[0];
    if (!row) return null;
    const revision = `${String(row.grant_generation)}:${String(row.token_revision)}`;
    this.parseRevision(revision);
    return { tokens: this.cipher.open(identity, row.sealed as SealedToken), revision };
  }
  private parseRevision(revision: string): [string, string] {
    if (!/^[1-9][0-9]{0,18}:[1-9][0-9]{0,18}$/.test(revision)) throw new DomainError('CONFLICT', 'Connection revision is invalid.');
    return revision.split(':') as [string, string];
  }
  async compareAndPut(identity: Identity, tokens: FeishuTokens, revision: string): Promise<boolean> {
    const [generation, tokenRevision] = this.parseRevision(revision);
    const sealed = this.cipher.seal(identity, tokens);
    const result = await this.db.query(`WITH active_connection AS (
      SELECT id FROM feishu_connections WHERE id=$1 AND subject=$2 AND tenant_id=$3 AND status='active' AND grant_generation=$7 FOR UPDATE
      ) UPDATE feishu_tokens SET sealed=$4::jsonb,expires_at=to_timestamp($5),refresh_expires_at=to_timestamp($6),token_revision=token_revision+1
      WHERE connection_id=$1 AND subject=$2 AND tenant_id=$3 AND token_revision=$8 AND EXISTS(SELECT 1 FROM active_connection)
      RETURNING connection_id`, [identity.connectionId, identity.subject, identity.tenantId, JSON.stringify(sealed), tokens.expiresAt / 1000, tokens.refreshExpiresAt / 1000, generation, tokenRevision]);
    return result.rowCount === 1;
  }
  async revokeIfCurrent(identity: Identity, revision: string): Promise<void> {
    const [generation, tokenRevision] = this.parseRevision(revision);
    await this.db.query(`WITH active_connection AS (
      SELECT id FROM feishu_connections WHERE id=$1 AND subject=$2 AND tenant_id=$3 AND status='active' AND grant_generation=$4 FOR UPDATE
      ) DELETE FROM feishu_tokens WHERE connection_id=$1 AND subject=$2 AND tenant_id=$3 AND token_revision=$5 AND EXISTS(SELECT 1 FROM active_connection)`, [identity.connectionId, identity.subject, identity.tenantId, generation, tokenRevision]);
  }
  async revoke(identity: Identity): Promise<void> {
    await this.db.query('DELETE FROM feishu_tokens WHERE connection_id=$1 AND subject=$2 AND tenant_id=$3', [identity.connectionId, identity.subject, identity.tenantId]);
  }
}
