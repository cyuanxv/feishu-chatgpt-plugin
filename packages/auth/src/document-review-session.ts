import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { digest, DomainError } from '../../policy/src/core.js';
import { writeBinding, type DocumentWritePrincipal } from '../../schemas/src/document-write.js';
import { PostgresDocumentWriteAccess } from './document-write-access.js';
import type { TokenStore } from './vault.js';

const secret = /^[A-Za-z0-9_-]{43}$/;
const fresh = () => randomBytes(32).toString('base64url');
const rowSchema = z.object({
  token_hash:z.string().regex(/^[a-f0-9]{64}$/),intent_id:z.string().uuid(),binding_hash:z.string().regex(/^[a-f0-9]{64}$/),request_hash:z.string().regex(/^[a-f0-9]{64}$/),
  phase:z.enum(['review','submitting','receipt','closed']),expires_ms:z.number().finite(),fresh:z.boolean(),
  open_id:z.string().min(1).max(256),tenant_id:z.string().min(1).max(256),domain:z.enum(['feishu','lark']),client_id:z.string().min(1).max(128),
});
export type DocumentReviewSession = z.infer<typeof rowSchema>;

/** Short-lived browser capability for exactly one verified MCP action. Hashes/reference only. */
export class PostgresDocumentReviewSessions {
  readonly origin: string;
  constructor(private readonly db:Pick<Pool,'query'>,origin:string) {
    const url=new URL(origin);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.origin!==origin)throw new Error('An exact HTTPS review origin is required.');
    this.origin=origin;
  }
  private async query(sql:string,values:unknown[]) {
    try{return(await this.db.query(sql,values)).rows;}catch{throw new DomainError('UPSTREAM_ERROR','Review session storage is unavailable.');}
  }
  async open(bearer:string,principal:DocumentWritePrincipal,intentId:string,requestHash:string,handoffHash:string):Promise<{session:string;csrf:string;record:DocumentReviewSession}> {
    if(!/^[A-Za-z0-9_-]{43,512}$/.test(bearer))throw new DomainError('AUTH_REQUIRED','Verified MCP authorization is required.');
    z.string().uuid().parse(intentId);z.string().regex(/^[a-f0-9]{64}$/).parse(requestHash);
    z.string().regex(/^[a-f0-9]{64}$/).parse(handoffHash);
    const session=fresh();const csrf=fresh();
    const inserted=await this.query(`INSERT INTO document_review_sessions(session_hash,token_hash,intent_id,binding_hash,request_hash,site_origin,csrf_hash,phase,expires_at,handoff_hash)
      SELECT $1,t.token_hash,i.id,$4,$5,$6,$7,'review',LEAST(t.expires_at,i.expires_at,now()+interval '5 minutes'),$13
      FROM mcp_access_tokens t JOIN oauth_grants g ON g.id=t.grant_id
      JOIN feishu_connections c ON c.id=g.connection_id AND c.subject=g.subject
      JOIN document_write_intents i ON i.id=$3
      WHERE t.token_hash=$2 AND t.expires_at>now() AND t.revoked_at IS NULL AND g.revoked_at IS NULL
        AND c.status='active' AND t.grant_generation=c.grant_generation AND g.scopes<@c.scopes
        AND 'docs.write'=ANY(g.scopes) AND 'docx:document:create'=ANY(c.provider_scopes)
        AND g.id=$8 AND g.connection_id=$9 AND g.subject=$10 AND g.client_id=$11 AND g.resource=$12
        AND i.binding_hash=$4 AND i.request_hash=$5 AND i.status='preview' AND i.expires_at>now()
      ON CONFLICT(handoff_hash) DO NOTHING RETURNING session_hash`,
    [digest(session),digest(bearer),intentId,writeBinding(principal),requestHash,this.origin,digest(csrf),principal.grantId,principal.identity.connectionId,principal.identity.subject,principal.clientId,principal.resource,handoffHash]);
    if(inserted.length!==1)throw new DomainError('AUTH_REQUIRED','Preview or authorization expired or changed.');
    return{session,csrf,record:await this.get(session)};
  }
  async get(value:string,csrf?:string):Promise<DocumentReviewSession> {
    if(!secret.test(value)||(csrf!==undefined&&!secret.test(csrf)))throw new DomainError('AUTH_REQUIRED','A valid review session is required.');
    const rows=await this.query(`SELECT s.token_hash,s.intent_id::text,s.binding_hash,s.request_hash,s.phase,
      floor(extract(epoch FROM s.expires_at)*1000)::double precision AS expires_ms,s.expires_at>now() AS fresh,
      c.open_id,c.tenant_id,c.domain,g.client_id
      FROM document_review_sessions s JOIN mcp_access_tokens t ON t.token_hash=s.token_hash
      JOIN oauth_grants g ON g.id=t.grant_id JOIN feishu_connections c ON c.id=g.connection_id AND c.subject=g.subject
      WHERE s.session_hash=$1 AND s.site_origin=$2 AND ($3::text IS NULL OR s.csrf_hash=$3)`,[digest(value),this.origin,csrf===undefined?null:digest(csrf)]);
    const parsed=rows.length===1?rowSchema.safeParse(rows[0]):null;
    if(!parsed?.success||!parsed.data.fresh||parsed.data.expires_ms<=Date.now()||parsed.data.phase==='closed')throw new DomainError('AUTH_REQUIRED','Review session expired, closed or changed.');
    return parsed.data;
  }
  async claim(value:string,csrf:string):Promise<boolean> {
    if(!secret.test(value)||!secret.test(csrf))throw new DomainError('AUTH_REQUIRED','A valid review session is required.');
    return(await this.query(`UPDATE document_review_sessions SET phase='submitting' WHERE session_hash=$1 AND site_origin=$2
      AND csrf_hash=$3 AND phase='review' AND expires_at>now() RETURNING intent_id`,[digest(value),this.origin,digest(csrf)])).length===1;
  }
  async cancel(value:string,csrf:string,principal:DocumentWritePrincipal):Promise<boolean> {
    if(!secret.test(value)||!secret.test(csrf))throw new DomainError('AUTH_REQUIRED','A valid review session is required.');
    // Cancel the shared intent before acknowledging Close. Per-session phase alone would not
    // serialize two independently opened review windows for the same action.
    return(await this.query(`WITH cancelled AS (
      UPDATE document_write_intents i SET status='cancelled',updated_at=now() FROM document_review_sessions s
      WHERE s.session_hash=$1 AND s.site_origin=$2 AND s.csrf_hash=$3 AND s.phase='review' AND s.expires_at>now()
        AND s.binding_hash=$4 AND i.id=s.intent_id AND i.binding_hash=$4 AND i.status IN ('preview','approved') RETURNING i.id
    ) UPDATE document_review_sessions s SET phase='closed'
      WHERE s.session_hash=$1 AND s.site_origin=$2 AND s.csrf_hash=$3 AND s.binding_hash=$4 AND s.phase='review' AND s.expires_at>now()
        AND (EXISTS(SELECT 1 FROM cancelled c WHERE c.id=s.intent_id) OR EXISTS(SELECT 1 FROM document_write_intents i WHERE i.id=s.intent_id AND i.binding_hash=$4 AND i.status='cancelled'))
      RETURNING s.intent_id`,[digest(value),this.origin,digest(csrf),writeBinding(principal)])).length===1;
  }
  async receipt(value:string):Promise<void> {
    if(!secret.test(value))throw new DomainError('AUTH_REQUIRED','A valid review session is required.');
    await this.query("UPDATE document_review_sessions SET phase='receipt' WHERE session_hash=$1 AND site_origin=$2 AND phase='submitting' RETURNING intent_id",[digest(value),this.origin]);
  }
}

/** Browser authentication uses only the token hash already linked to this server-created session.
 * The inherited token() rechecks both this session and the MCP grant after credential loading. */
export class DocumentReviewWriteAccess extends PostgresDocumentWriteAccess {
  constructor(db:Pick<Pool,'query'>,tokens:Pick<TokenStore,'snapshot'>,resource:string,private readonly sessions:PostgresDocumentReviewSessions,private readonly intentId:string) {
    super(db,tokens,resource);
  }
  override async authenticate(cookie:string):Promise<DocumentWritePrincipal> {
    const session=await this.sessions.get(cookie);
    if(session.intent_id!==this.intentId)throw new DomainError('PERMISSION_DENIED','Review belongs to a different action.');
    const principal=await this.authenticateStoredTokenHash(session.token_hash);
    if(writeBinding(principal)!==session.binding_hash)throw new DomainError('AUTH_REQUIRED','Review account or grant changed.');
    return principal;
  }
}
