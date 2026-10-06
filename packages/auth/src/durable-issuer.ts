import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientError, InvalidGrantError, InvalidRequestError, InvalidScopeError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { constantEquals, digest, type Identity } from '../../policy/src/core.js';
import { pkceChallenge } from './mock-broker.js';
import { AGENDA_PROVIDER_SCOPES } from './resource-access.js';

const opaque = /^[A-Za-z0-9_-]{43,128}$/;
const fresh = () => randomBytes(32).toString('base64url');
export interface PublicOAuthClient { clientId: string; name: string; redirects: readonly string[] }
export interface IssuerAuthorizationRequest { clientId: string; redirectUri: string; resource: string; challenge: string; scopes: string[]; state?: string }
export interface IssuerConfig { issuer: string; resource: string; clients: readonly PublicOAuthClient[] }
function https(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.href !== value) throw new Error('Exact canonical HTTPS URLs are required.');
  return url;
}

/** Persistence for a single calendar-read OAuth issuer. No identity is accepted from HTTP here.
 * begin/consent must be called by a reviewed browser login adapter after session/CSRF validation.
 * This module alone does not authenticate a human and is not mounted by either executable. */
export class PostgresAgendaIssuer {
  readonly clientsStore: { getClient: (clientId: string) => OAuthClientInformationFull | undefined };
  private readonly clients = new Map<string, PublicOAuthClient>();
  readonly config: Readonly<IssuerConfig>;
  constructor(private readonly pool: Pick<Pool, 'connect'>, config: IssuerConfig) {
    const issuer = https(config.issuer); const resource = https(config.resource);
    if (issuer.pathname !== '/' || resource.pathname !== '/mcp') throw new Error('Issuer origin and exact MCP resource are required.');
    if (!config.clients.length || config.clients.length > 20) throw new Error('A bounded pre-registered client allowlist is required.');
    for (const entry of config.clients) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(entry.clientId) || !entry.name || entry.name.length > 100 || this.clients.has(entry.clientId) || !entry.redirects.length || entry.redirects.length > 5) throw new Error('Invalid pre-registered client.');
      entry.redirects.forEach(value => {
        https(value);
        // Registered redirects also appear as a narrowly scoped CSP form-action source.
        // Never accept CSP separators/keywords or wildcard host/path syntax in configuration.
        if (/[\s;'",*]/.test(value)) throw new Error('Redirect URI is not an exact safe CSP source.');
      });
      this.clients.set(entry.clientId, { ...entry, redirects: [...entry.redirects] });
    }
    this.config = Object.freeze({ issuer: issuer.href, resource: resource.href, clients: [] });
    this.clientsStore = { getClient: (clientId) => {
      const client = this.clients.get(clientId);
      return client ? { client_id: client.clientId, client_name: client.name, redirect_uris: [...client.redirects], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'calendar.read' } : undefined;
    } };
  }
  private client(id: string, redirect?: string) {
    const client = this.clients.get(id);
    if (!client || (redirect !== undefined && !client.redirects.includes(redirect))) throw new InvalidClientError('Client or redirect is not registered.');
    return client;
  }
  private scopes(scopes: string[]) { if (scopes.length !== 1 || scopes[0] !== 'calendar.read') throw new InvalidScopeError('Only calendar.read is supported.'); }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    try { client = await this.pool.connect(); await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) {
      try { await client?.query('ROLLBACK'); } catch { /* No driver data in errors. */ }
      if (error instanceof InvalidClientError || error instanceof InvalidGrantError || error instanceof InvalidRequestError || error instanceof InvalidScopeError) throw error;
      throw new ServerError('Authorization storage is unavailable.');
    } finally { try { client?.release(); } catch { /* No driver data in errors. */ } }
  }
  async begin(input: IssuerAuthorizationRequest, browserSecret: string): Promise<string> {
    this.client(input.clientId, input.redirectUri); this.scopes(input.scopes);
    if (input.resource !== this.config.resource || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge) || !opaque.test(browserSecret) || (input.state !== undefined && (input.state.length > 1024 || /[\x00-\x1f\x7f]/.test(input.state)))) throw new InvalidRequestError('Authorization request is invalid.');
    const requestId = fresh();
    await this.transaction(async db => {
      // Bound pending sessions per browser. Global HTTP abuse limits belong to the login adapter.
      const count = await db.query('SELECT count(*)::int AS n FROM mcp_authorization_attempts WHERE browser_hash=$1 AND expires_at>now()', [digest(browserSecret)]);
      if (Number(count.rows[0]?.n) >= 5) throw new InvalidRequestError('Too many pending authorization attempts.');
      await db.query(`INSERT INTO mcp_authorization_attempts(request_hash,browser_hash,client_id,redirect_uri,resource,challenge,client_state,scopes,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '10 minutes')`, [digest(requestId), digest(browserSecret), input.clientId, input.redirectUri, input.resource, input.challenge, input.state ?? null, input.scopes]);
    });
    return requestId;
  }
  /** Trusted server-side completion only: identity must come from verified Feishu login, and
   * allow must reflect an explicit CSRF-protected consent POST from this browser session. */
  async consent(requestId: string, browserSecret: string, identity: Identity, allow: boolean): Promise<string> {
    if (!opaque.test(requestId) || !opaque.test(browserSecret)) throw new InvalidGrantError('Browser authorization expired or changed.');
    return this.transaction(async db => {
      const attempt = await db.query('DELETE FROM mcp_authorization_attempts WHERE request_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *', [digest(requestId), digest(browserSecret)]);
      const row = attempt.rows[0]; if (!row) throw new InvalidGrantError('Browser authorization expired or changed.');
      this.client(row.client_id, row.redirect_uri); this.scopes(row.scopes);
      if (row.resource !== this.config.resource) throw new InvalidGrantError('Resource changed.');
      const redirect = new URL(row.redirect_uri); if (row.client_state !== null) redirect.searchParams.set('state', row.client_state);
      redirect.searchParams.set('iss', this.config.issuer);
      if (!allow) { redirect.searchParams.set('error', 'access_denied'); return redirect.href; }
      const current = await this.connection(db, identity.connectionId, identity.subject);
      if (current.tenant_id !== identity.tenantId || current.domain !== identity.domain || !identity.scopes.includes('calendar.read')) throw new InvalidGrantError('Verified account does not match.');
      const grant = randomUUID(); const code = fresh();
      await db.query('INSERT INTO oauth_grants(id,subject,connection_id,scopes,resource,client_id) VALUES($1,$2,$3,$4,$5,$6)', [grant, identity.subject, identity.connectionId, ['calendar.read'], row.resource, row.client_id]);
      await db.query(`INSERT INTO mcp_authorization_codes(code_hash,grant_id,grant_generation,client_id,redirect_uri,resource,challenge,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '60 seconds')`, [digest(code), grant, current.generation, row.client_id, row.redirect_uri, row.resource, row.challenge]);
      redirect.searchParams.set('code', code); return redirect.href;
    });
  }
  private async connection(db: PoolClient, id: string, subject: string) {
    const result = await db.query(`SELECT c.*,c.grant_generation::text AS generation FROM feishu_connections c
      JOIN feishu_tokens t ON t.connection_id=c.id AND t.subject=c.subject AND t.tenant_id=c.tenant_id
      WHERE c.id=$1 AND c.subject=$2 AND c.status='active' AND 'calendar.read'=ANY(c.scopes)
        AND $3::text[]<@c.provider_scopes AND t.expires_at>now() AND t.refresh_expires_at>now() FOR SHARE OF c,t`, [id, subject, AGENDA_PROVIDER_SCOPES]);
    if (result.rows.length !== 1) throw new InvalidGrantError('Linked account authorization is unavailable.');
    return result.rows[0];
  }
  private async activeGrant(db: PoolClient, id: string, clientId: string, generation: string) {
    const result = await db.query('SELECT * FROM oauth_grants WHERE id=$1 AND client_id=$2 AND resource=$3 AND revoked_at IS NULL', [id, clientId, this.config.resource]);
    const grant = result.rows[0]; if (!grant) throw new InvalidGrantError('Authorization grant is unavailable.');
    this.scopes(grant.scopes);
    const current = await this.connection(db, grant.connection_id, grant.subject);
    if (current.generation !== generation) throw new InvalidGrantError('Linked account changed. Reauthorize.');
    // Lock connection before grant, matching disconnect's order; recheck revocation after waiting.
    const locked = await db.query('SELECT id FROM oauth_grants WHERE id=$1 AND client_id=$2 AND resource=$3 AND subject=$4 AND connection_id=$5 AND revoked_at IS NULL FOR UPDATE', [id, clientId, this.config.resource, grant.subject, grant.connection_id]);
    if (locked.rows.length !== 1) throw new InvalidGrantError('Authorization grant is unavailable.');
    return grant;
  }
  private async issue(db: PoolClient, grantId: string, generation: string, refreshExpiry?: Date): Promise<OAuthTokens> {
    const access = fresh(); const refresh = fresh();
    await db.query("INSERT INTO mcp_access_tokens(token_hash,grant_id,grant_generation,expires_at) VALUES($1,$2,$3,now()+interval '15 minutes')", [digest(access), grantId, generation]);
    await db.query("INSERT INTO mcp_refresh_tokens(token_hash,grant_id,grant_generation,expires_at) VALUES($1,$2,$3,COALESCE($4::timestamptz,now()+interval '1 day'))", [digest(refresh), grantId, generation, refreshExpiry ?? null]);
    return { access_token: access, token_type: 'Bearer', expires_in: 900, refresh_token: refresh, scope: 'calendar.read' };
  }
  async exchange(input: { code: string; clientId: string; redirectUri?: string; resource?: string; verifier?: string }): Promise<OAuthTokens> {
    this.client(input.clientId, input.redirectUri);
    if (!opaque.test(input.code) || input.resource !== this.config.resource || !input.redirectUri || !input.verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier)) throw new InvalidGrantError('Authorization code binding is invalid.');
    const result = await this.transaction(async db => {
      const rows = await db.query('SELECT *,grant_generation::text AS generation,expires_at>now() AS fresh FROM mcp_authorization_codes WHERE code_hash=$1 FOR UPDATE', [digest(input.code)]);
      const code = rows.rows[0];
      if (!code || code.client_id !== input.clientId || code.redirect_uri !== input.redirectUri || code.resource !== input.resource || !constantEquals(code.challenge, pkceChallenge(input.verifier!))) throw new InvalidGrantError('Authorization code binding is invalid.');
      if (code.used_at) { await db.query('UPDATE oauth_grants SET revoked_at=now() WHERE id=$1', [code.grant_id]); return null; }
      if (!code.fresh) throw new InvalidGrantError('Authorization code expired.');
      await this.activeGrant(db, code.grant_id, input.clientId, code.generation);
      await db.query('UPDATE mcp_authorization_codes SET used_at=now() WHERE code_hash=$1', [digest(input.code)]);
      return this.issue(db, code.grant_id, code.generation);
    });
    if (!result) throw new InvalidGrantError('Authorization code was already used. Reauthorize.');
    return result;
  }
  async refresh(input: { refreshToken: string; clientId: string; resource?: string; scopes?: string[] }): Promise<OAuthTokens> {
    this.client(input.clientId); if (input.scopes) this.scopes(input.scopes);
    if (!opaque.test(input.refreshToken) || input.resource !== this.config.resource) throw new InvalidGrantError('Refresh token binding is invalid.');
    const result = await this.transaction(async db => {
      const rows = await db.query(`SELECT t.*,t.grant_generation::text AS generation,t.expires_at>now() AS fresh,g.client_id,g.resource FROM mcp_refresh_tokens t
        JOIN oauth_grants g ON g.id=t.grant_id WHERE t.token_hash=$1 FOR UPDATE OF t`, [digest(input.refreshToken)]);
      const token = rows.rows[0];
      if (!token || token.client_id !== input.clientId || token.resource !== input.resource) throw new InvalidGrantError('Refresh token binding is invalid.');
      if (token.used_at) { await db.query('UPDATE oauth_grants SET revoked_at=now() WHERE id=$1', [token.grant_id]); return null; }
      if (!token.fresh) throw new InvalidGrantError('Refresh token expired.');
      await this.activeGrant(db, token.grant_id, input.clientId, token.generation);
      await db.query('UPDATE mcp_refresh_tokens SET used_at=now() WHERE token_hash=$1', [digest(input.refreshToken)]);
      return this.issue(db, token.grant_id, token.generation, token.expires_at);
    });
    if (!result) throw new InvalidGrantError('Refresh token was already used. Reauthorize.');
    return result;
  }
  async revoke(token: string, clientId: string): Promise<void> {
    this.client(clientId); if (!opaque.test(token)) return;
    await this.transaction(async db => { await db.query(`UPDATE oauth_grants SET revoked_at=now() WHERE client_id=$1 AND id IN (
      SELECT grant_id FROM mcp_access_tokens WHERE token_hash=$2 UNION SELECT grant_id FROM mcp_refresh_tokens WHERE token_hash=$2)`, [clientId, digest(token)]); });
  }
  async clientForGrant(grantId: string): Promise<string> {
    return this.transaction(async db => {
      const row = (await db.query('SELECT client_id FROM oauth_grants WHERE id=$1 AND resource=$2 AND revoked_at IS NULL', [grantId, this.config.resource])).rows[0];
      if (!row) throw new InvalidGrantError('Authorization grant is unavailable.');
      this.client(row.client_id); return row.client_id;
    });
  }
}
