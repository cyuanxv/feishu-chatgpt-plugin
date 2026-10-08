import type { Pool, PoolClient } from 'pg';
import { DomainError, type Identity } from '../../policy/src/core.js';
import { TokenCipher, type FeishuTokens } from './vault.js';

/** Stores verified provider identity and encrypted tokens atomically. No ambient database connection is opened. */
export class PostgresConnectionRepository {
  constructor(private readonly pool: Pick<Pool, 'connect'>, private readonly cipher: TokenCipher) {}
  async link(identity: Identity, verifiedProfile: { openId: string; tenantId: string; grantedProviderScopes?: readonly string[] }, tokens: FeishuTokens): Promise<void> {
    if (!verifiedProfile.openId || verifiedProfile.tenantId !== identity.tenantId) throw new DomainError('PERMISSION_DENIED', 'Verified provider identity does not match the connection.');
    const providerScopes = [...new Set(verifiedProfile.grantedProviderScopes ?? [])];
    if (providerScopes.length > 100 || providerScopes.some(scope => typeof scope !== 'string' || !/^[a-zA-Z0-9_:.-]{1,128}$/.test(scope))) throw new DomainError('INVALID_ARGUMENT', 'Verified provider permissions were malformed.');
    const sealed = this.cipher.seal(identity, tokens);
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const result = await client.query(`INSERT INTO feishu_connections(id,subject,tenant_id,domain,open_id,scopes,provider_scopes,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,'active')
        ON CONFLICT(id) DO UPDATE SET scopes=EXCLUDED.scopes,provider_scopes=EXCLUDED.provider_scopes,status='active',grant_generation=feishu_connections.grant_generation+1
        WHERE feishu_connections.subject=EXCLUDED.subject AND feishu_connections.tenant_id=EXCLUDED.tenant_id
          AND feishu_connections.domain=EXCLUDED.domain AND feishu_connections.open_id=EXCLUDED.open_id
        RETURNING id`, [identity.connectionId, identity.subject, identity.tenantId, identity.domain, verifiedProfile.openId, identity.scopes, providerScopes]);
      if (result.rowCount !== 1) throw new DomainError('PERMISSION_DENIED', 'Existing connection belongs to another identity.');
      await client.query(`INSERT INTO feishu_tokens(connection_id,subject,tenant_id,sealed,expires_at,refresh_expires_at)
        VALUES($1,$2,$3,$4::jsonb,to_timestamp($5),to_timestamp($6))
        ON CONFLICT(connection_id) DO UPDATE SET sealed=EXCLUDED.sealed,expires_at=EXCLUDED.expires_at,refresh_expires_at=EXCLUDED.refresh_expires_at,token_revision=feishu_tokens.token_revision+1`,
      [identity.connectionId, identity.subject, identity.tenantId, JSON.stringify(sealed), tokens.expiresAt / 1000, tokens.refreshExpiresAt / 1000]);
      await client.query('COMMIT');
    } catch (error) {
      try { await client?.query('ROLLBACK'); } catch { /* Never surface a driver's raw error, which may include query data. */ }
      if (error instanceof DomainError) throw error;
      throw new DomainError('UPSTREAM_ERROR', 'Connection could not be saved. Retry linking.');
    } finally { try { client?.release(); } catch { /* Driver cleanup must not expose private connection configuration. */ } }
  }
  async disconnect(identity: Identity): Promise<void> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const values = [identity.connectionId, identity.subject, identity.tenantId];
      const updated = await client.query("UPDATE feishu_connections SET status='revoked',grant_generation=grant_generation+1 WHERE id=$1 AND subject=$2 AND tenant_id=$3 RETURNING id", values);
      if (updated.rowCount !== 1) throw new DomainError('PERMISSION_DENIED', 'Connection cannot be disconnected by this identity.');
      await client.query('DELETE FROM feishu_tokens WHERE connection_id=$1 AND subject=$2 AND tenant_id=$3', values);
      await client.query('UPDATE oauth_grants SET revoked_at=now() WHERE connection_id=$1 AND subject=$2', [identity.connectionId, identity.subject]);
      await client.query('COMMIT');
    } catch (error) {
      try { await client?.query('ROLLBACK'); } catch { /* Only safe errors leave this boundary. */ }
      if (error instanceof DomainError) throw error;
      throw new DomainError('UPSTREAM_ERROR', 'Connection could not be disconnected.');
    } finally { try { client?.release(); } catch { /* Driver cleanup must not expose private connection configuration. */ } }
  }
}
