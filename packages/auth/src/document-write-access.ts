import type { Pool } from 'pg';
import { z } from 'zod';
import { digest, DomainError } from '../../policy/src/core.js';
import { writeBinding, type DocumentWritePrincipal } from '../../schemas/src/document-write.js';
import type { FeishuTokens, TokenStore } from './vault.js';

export const DOCUMENT_CREATE_PROVIDER_SCOPES = ['docx:document:create'] as const;
export interface DocumentWriteAccess {
  authenticate(bearer: string): Promise<DocumentWritePrincipal>;
  token(bearer: string, initial: DocumentWritePrincipal): Promise<FeishuTokens>;
}
const rowSchema = z.object({
  connection_id: z.string().min(1), subject: z.string().min(1), tenant_id: z.string().min(1), domain: z.enum(['feishu', 'lark']),
  grant_id: z.string().min(1), generation: z.string().regex(/^[1-9][0-9]{0,18}$/), client_id: z.string().min(1),
  scopes: z.array(z.string()), provider_scopes: z.array(z.string()), resource: z.string(), expires_ms: z.number().finite(),
});
/** Separate, unmounted write verifier. Existing calendar OAuth never grants docs.write. */
export class PostgresDocumentWriteAccess implements DocumentWriteAccess {
  constructor(private readonly db: Pick<Pool, 'query'>, private readonly store: Pick<TokenStore, 'snapshot'>, private readonly resource: string) {
    const url = new URL(resource);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp' || url.href !== resource) throw new Error('An exact HTTPS MCP resource is required.');
  }
  async authenticate(bearer: string): Promise<DocumentWritePrincipal> {
    if (!/^[A-Za-z0-9_-]{43,512}$/.test(bearer)) throw new DomainError('AUTH_REQUIRED', 'Valid write authorization is required.');
    let rows: unknown[];
    try {
      rows = (await this.db.query(`SELECT c.id AS connection_id,c.subject,c.tenant_id,c.domain,g.id AS grant_id,
        c.grant_generation::text AS generation,g.client_id,g.scopes,c.provider_scopes,g.resource,
        (extract(epoch FROM t.expires_at)*1000)::double precision AS expires_ms
        FROM mcp_access_tokens t JOIN oauth_grants g ON g.id=t.grant_id
        JOIN feishu_connections c ON c.id=g.connection_id AND c.subject=g.subject
        WHERE t.token_hash=$1 AND g.resource=$2 AND t.expires_at>now() AND t.revoked_at IS NULL
          AND g.revoked_at IS NULL AND c.status='active' AND t.grant_generation=c.grant_generation
          AND g.scopes<@c.scopes`, [digest(bearer), this.resource])).rows;
    } catch { throw new DomainError('UPSTREAM_ERROR', 'Write authorization storage is unavailable.'); }
    const parsed = rows.length === 1 ? rowSchema.safeParse(rows[0]) : null;
    if (!parsed?.success || parsed.data.expires_ms <= Date.now()) throw new DomainError('AUTH_REQUIRED', 'Valid write authorization is required.');
    const row = parsed.data;
    if (!row.scopes.includes('docs.write')) throw new DomainError('INSUFFICIENT_SCOPE', 'Explicit document-write authorization is required.', 'docs.write');
    if (DOCUMENT_CREATE_PROVIDER_SCOPES.some(scope => !row.provider_scopes.includes(scope))) throw new DomainError('PERMISSION_DENIED', 'The current Feishu grant lacks document-create permission.');
    return { identity: { subject: row.subject, tenantId: row.tenant_id, connectionId: row.connection_id, domain: row.domain, scopes: row.scopes }, grantId: row.grant_id, generation: row.generation, clientId: row.client_id, resource: row.resource };
  }
  async token(bearer: string, initial: DocumentWritePrincipal): Promise<FeishuTokens> {
    const current = await this.authenticate(bearer);
    if (writeBinding(current) !== writeBinding(initial)) throw new DomainError('AUTH_REQUIRED', 'Write authorization changed. Review and confirm again.');
    let snapshot: Awaited<ReturnType<TokenStore['snapshot']>>;
    try { snapshot = await this.store.snapshot(current.identity); } catch { throw new DomainError('AUTH_REQUIRED', 'Linked credentials are unavailable.'); }
    // Credential loading is asynchronous; an issuer can revoke the MCP grant while it runs.
    // Recheck that grant after the snapshot, immediately before releasing the user credential.
    const final = await this.authenticate(bearer);
    if (writeBinding(final) !== writeBinding(initial)) throw new DomainError('AUTH_REQUIRED', 'Write authorization changed while loading credentials.');
    if (!snapshot || snapshot.revision.split(':')[0] !== current.generation || !snapshot.tokens.accessToken || !Number.isFinite(snapshot.tokens.expiresAt) || snapshot.tokens.expiresAt <= Date.now()) throw new DomainError('AUTH_REQUIRED', 'Linked authorization expired or changed.');
    return snapshot.tokens;
  }
}
