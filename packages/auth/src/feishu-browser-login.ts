import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withUserAccessToken, type Client } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { digest, DomainError, type Identity } from '../../policy/src/core.js';
import { PostgresAgendaIssuer, type IssuerAuthorizationRequest } from './durable-issuer.js';
import { FeishuOAuthExchange } from './feishu-exchange.js';
import { TokenCipher, type SealedToken } from './vault.js';
import { PostgresConnectionRepository } from './connection-repository.js';
import { AGENDA_PROVIDER_SCOPES } from './resource-access.js';

export const FEISHU_LOGIN_SCOPES = [...AGENDA_PROVIDER_SCOPES, 'offline_access'] as const;
const fresh = () => randomBytes(32).toString('base64url');
const identitySchema = z.object({subject:z.string().uuid(),tenantId:z.string().min(1).max(128),connectionId:z.string().uuid(),domain:z.literal('feishu'),scopes:z.tuple([z.literal('calendar.read')])}).strict();
/** A browser-linking service for a Feishu confidential client. Only synthetic transports have been
 * exercised. The actual secret is supplied to the safe SDK by the operator, never loaded here. */
export class FeishuBrowserLogin {
  constructor(private readonly db: Pick<Pool,'query'>, private readonly issuer: PostgresAgendaIssuer, private readonly exchange: FeishuOAuthExchange, private readonly cipher: TokenCipher, private readonly connections: PostgresConnectionRepository, private readonly sdk: Client, private readonly appId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(appId)) throw new Error('A Feishu app identifier is required.');
  }
  private async query(sql:string, values:unknown[]=[]) {
    try { return await this.db.query(sql,values); } catch { throw new DomainError('UPSTREAM_ERROR','Login storage is unavailable.'); }
  }
  async begin(request:IssuerAuthorizationRequest):Promise<{browserSecret:string;url:string}> {
    // Opportunistic expiry cleanup, no background worker or external side effect. A production
    // retention job is still required when this service is idle for long periods.
    await this.query('DELETE FROM mcp_browser_links WHERE expires_at<=now()');
    await this.query('DELETE FROM oauth_link_attempts WHERE expires_at<=now()');
    await this.query('DELETE FROM mcp_authorization_attempts WHERE expires_at<=now()');
    const browserSecret=fresh();const requestId=await this.issuer.begin(request,browserSecret);
    // Here the exchange initiator is a high-entropy browser capability, not an asserted human ID.
    // Human identity is established only by user_info using the exchanged user token below.
    const pending=await this.exchange.begin(digest(browserSecret),requestId,[...FEISHU_LOGIN_SCOPES]);
    if(pending.redirect_uri!==new URL('/oauth/feishu/callback',this.issuer.config.issuer).href)throw new DomainError('INVALID_ARGUMENT','Feishu callback configuration does not match this issuer.');
    await this.query("INSERT INTO mcp_browser_links(browser_hash,request_id,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",[digest(browserSecret),requestId,digest(fresh())]);
    const url=new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    Object.entries({client_id:this.appId,response_type:'code',...pending}).forEach(([key,value])=>url.searchParams.set(key,value));
    return{browserSecret,url:url.href};
  }
  async callback(browserSecret:string,state:string,code:string):Promise<{csrf:string;clientName:string;accountName:string;clientRedirectUri:string}> {
    this.browser(browserSecret);
    const before=(await this.query('SELECT request_id FROM mcp_browser_links WHERE browser_hash=$1 AND expires_at>now() AND sealed IS NULL',[digest(browserSecret)])).rows[0];
    if(!before)throw new DomainError('AUTH_REQUIRED','Browser login expired or changed.');
    const result=await this.exchange.finish({state,subject:digest(browserSecret),code});
    if(result.attempt.connectionId!==before.request_id||result.attempt.domain!=='feishu'||FEISHU_LOGIN_SCOPES.some(scope=>!result.grantedProviderScopes.includes(scope)))throw new DomainError('AUTH_REQUIRED','Required Feishu consent was not granted.');
    let profile:Awaited<ReturnType<Client['authen']['userInfo']['get']>>;
    try { profile=await this.sdk.authen.userInfo.get({},withUserAccessToken(result.tokens.accessToken)); }
    catch { throw new DomainError('AUTH_REQUIRED','Feishu identity could not be verified.'); }
    const verified=z.object({code:z.literal(0),data:z.object({open_id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),tenant_key:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)})}).safeParse(profile);
    if(!verified.success)throw new DomainError('AUTH_REQUIRED','Feishu identity could not be verified.');
    const {open_id:openId,tenant_key:tenantId}=verified.data.data;
    const account=(await this.query(`INSERT INTO mcp_provider_accounts(app_id,domain,tenant_id,open_id,subject,connection_id)
      VALUES($1,'feishu',$2,$3,$4,$5) ON CONFLICT(app_id,domain,tenant_id,open_id) DO UPDATE SET app_id=EXCLUDED.app_id RETURNING subject,connection_id`,[this.appId,tenantId,openId,randomUUID(),randomUUID()])).rows[0];
    const identity:Identity={subject:account.subject,connectionId:account.connection_id,tenantId,domain:'feishu',scopes:['calendar.read']};
    const csrf=fresh();const saved=await this.query(`UPDATE mcp_browser_links SET identity=$2::jsonb,provider_scopes=$3,sealed=$4::jsonb,open_id=$5,csrf_hash=$6
      WHERE browser_hash=$1 AND expires_at>now() AND sealed IS NULL RETURNING request_id`,[digest(browserSecret),JSON.stringify(identity),result.grantedProviderScopes,JSON.stringify(this.cipher.seal(identity,result.tokens)),openId,digest(csrf)]);
    if(saved.rows.length!==1)throw new DomainError('AUTH_REQUIRED','Browser login expired or changed.');
    const attempt=(await this.query('SELECT client_id,redirect_uri FROM mcp_authorization_attempts WHERE request_hash=$1 AND browser_hash=$2 AND expires_at>now()',[digest(before.request_id),digest(browserSecret)])).rows[0];
    const client=attempt?this.issuer.clientsStore.getClient(attempt.client_id):undefined;
    if(!client||!client.redirect_uris.includes(attempt.redirect_uri))throw new DomainError('AUTH_REQUIRED','OAuth client is no longer registered.');
    const name=profile.data?.name;const accountName=typeof name==='string'&&name.trim()&&name.length<=100?name.trim():'已验证的飞书账户';
    return{csrf,clientName:client.client_name!,accountName,clientRedirectUri:attempt.redirect_uri};
  }
  async consent(browserSecret:string,csrf:string,allow:boolean):Promise<string> {
    this.browser(browserSecret);this.browser(csrf);
    const result=await this.query(`DELETE FROM mcp_browser_links WHERE browser_hash=$1 AND csrf_hash=$2 AND expires_at>now() AND sealed IS NOT NULL RETURNING *`,[digest(browserSecret),digest(csrf)]);
    const row=result.rows[0];if(!row)throw new DomainError('AUTH_REQUIRED','Consent expired or changed. Start again.');
    const parsed=identitySchema.safeParse(row.identity);if(!parsed.success)throw new DomainError('AUTH_REQUIRED','Verified identity is invalid.');
    const identity=parsed.data;
    if(allow){
      const tokens=this.cipher.open(identity,row.sealed as SealedToken);
      if(tokens.expiresAt<=Date.now()||tokens.refreshExpiresAt<=Date.now())throw new DomainError('AUTH_REQUIRED','Feishu authorization expired.');
      if(!Array.isArray(row.provider_scopes)||FEISHU_LOGIN_SCOPES.some(scope=>!row.provider_scopes.includes(scope)))throw new DomainError('AUTH_REQUIRED','Required Feishu consent was not granted.');
      await this.connections.link(identity,{openId:row.open_id,tenantId:identity.tenantId,grantedProviderScopes:row.provider_scopes},tokens);
    }
    return this.issuer.consent(row.request_id,browserSecret,identity,allow);
  }
  private browser(value:string){if(!/^[A-Za-z0-9_-]{43}$/.test(value))throw new DomainError('AUTH_REQUIRED','Browser login is required.');}
}
