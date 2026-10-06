import type { Pool } from 'pg';
import { z } from 'zod';
import { digest, DomainError, type Identity } from '../../policy/src/core.js';
import type { TokenStore, FeishuTokens } from './vault.js';

// Chosen read-only permissions verified against the official calendar catalog. Broader alternatives
// are deliberately not requested/accepted implicitly; deployment must review its actual consent set.
export const AGENDA_PROVIDER_SCOPES = ['calendar:calendar:read', 'calendar:calendar.event:read'] as const;
export interface AuthenticatedGrant {
  identity: Identity; grantId: string; generation: string; providerScopes: string[]; resource: string; expiresAt: number;
}
const rowSchema = z.object({ connection_id:z.string().min(1),subject:z.string().min(1),tenant_id:z.string().min(1),domain:z.enum(['feishu','lark']),grant_id:z.string().min(1),generation:z.string().regex(/^[1-9][0-9]{0,18}$/),scopes:z.array(z.string()),provider_scopes:z.array(z.string()),resource:z.string(),expires_ms:z.number().finite() });

/** Opaque OAuth access-token verification. Never trusts identity/grants in model arguments.
 * This is a resource-server verifier, not a login screen or authorization issuer. */
export class PostgresResourceAccess {
  constructor(private readonly db:Pick<Pool,'query'>){}
  async authenticate(token:string,resource:string):Promise<AuthenticatedGrant>{
    if(!/^[A-Za-z0-9_-]{43,512}$/.test(token))throw new DomainError('AUTH_REQUIRED','Valid resource authorization is required.');
    let rows:unknown[];
    try{
      const result=await this.db.query(`SELECT c.id AS connection_id,c.subject,c.tenant_id,c.domain,g.id AS grant_id,
        c.grant_generation::text AS generation,g.scopes,c.provider_scopes,g.resource,
        (extract(epoch FROM t.expires_at)*1000)::double precision AS expires_ms
        FROM mcp_access_tokens t JOIN oauth_grants g ON g.id=t.grant_id
        JOIN feishu_connections c ON c.id=g.connection_id AND c.subject=g.subject
        WHERE t.token_hash=$1 AND g.resource=$2 AND t.expires_at>now()
          AND t.revoked_at IS NULL AND g.revoked_at IS NULL AND c.status='active'
          AND t.grant_generation=c.grant_generation AND g.scopes<@c.scopes`,[digest(token),resource]);
      rows=result.rows;
    }catch{throw new DomainError('UPSTREAM_ERROR','Authorization storage is unavailable.');}
    const parsed=rows.length===1?rowSchema.safeParse(rows[0]):null;
    if(!parsed?.success||parsed.data.expires_ms<=Date.now())throw new DomainError('AUTH_REQUIRED','Valid resource authorization is required.');
    const row=parsed.data;
    if(!row.scopes.includes('calendar.read'))throw new DomainError('INSUFFICIENT_SCOPE','Calendar authorization is required.','calendar.read');
    if(AGENDA_PROVIDER_SCOPES.some(scope=>!row.provider_scopes.includes(scope)))throw new DomainError('PERMISSION_DENIED','The linked Feishu grant lacks the required calendar read permissions.');
    return{identity:{subject:row.subject,tenantId:row.tenant_id,connectionId:row.connection_id,domain:row.domain,scopes:row.scopes},grantId:row.grant_id,generation:row.generation,providerScopes:row.provider_scopes,resource:row.resource,expiresAt:row.expires_ms};
  }
}

/** Revalidates durable grant and account generation before every provider operation. No refresh is
 * attempted here: refreshing also needs atomic actual-scope updates and is a later integration gate. */
export class GrantedAgendaTokens {
  constructor(private readonly access:PostgresResourceAccess,private readonly store:Pick<TokenStore,'snapshot'>,private readonly bearer:string,private readonly initial:AuthenticatedGrant){}
  async get(identity:Identity):Promise<FeishuTokens>{
    let current:AuthenticatedGrant;
    try{current=await this.access.authenticate(this.bearer,this.initial.resource);}catch(error){
      // A changed provider grant is a connection-wide authorization failure, not a calendar-specific
      // 403 that the agenda workflow may legitimately retain as partial visibility.
      if(error instanceof DomainError&&error.type==='PERMISSION_DENIED')throw new DomainError('AUTH_REQUIRED','Linked Feishu permissions changed. Reconnect.');
      throw error;
    }
    if(current.grantId!==this.initial.grantId||current.generation!==this.initial.generation||(['subject','tenantId','connectionId','domain'] as const).some(key=>current.identity[key]!==identity[key]||identity[key]!==this.initial.identity[key]))throw new DomainError('AUTH_REQUIRED','Account authorization changed. Reconnect.');
    let snapshot:Awaited<ReturnType<TokenStore['snapshot']>>;
    try{snapshot=await this.store.snapshot(current.identity);}catch{throw new DomainError('AUTH_REQUIRED','Linked credentials are unavailable. Reconnect.');}
    if(!snapshot||snapshot.revision.split(':')[0]!==current.generation||snapshot.tokens.expiresAt<=Date.now()||snapshot.tokens.refreshExpiresAt<=Date.now())throw new DomainError('AUTH_REQUIRED','Linked authorization expired or changed. Reconnect.');
    return snapshot.tokens;
  }
}
