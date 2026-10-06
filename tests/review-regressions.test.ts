import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createSafeSdkClient } from '../packages/feishu/src/sdk-client.js';
import { bindSdkReads, FeishuSdkReadGateway } from '../packages/feishu/src/sdk-reads.js';
import { FeishuProviderDomains } from '../packages/feishu/src/provider-domains.js';
import { FeishuProviderReads } from '../packages/feishu/src/provider-reads.js';
import { Handles } from '../packages/policy/src/core.js';
import { demoIdentity } from '../packages/feishu/src/fixtures.js';
import { PostgresConnectionRepository } from '../packages/auth/src/connection-repository.js';
import { PostgresTokenStore, TokenCipher } from '../packages/auth/src/vault.js';
import { TokenRefreshCoordinator } from '../packages/feishu/src/adapter.js';
function setup(response: unknown) {
 const request=vi.fn().mockResolvedValue(response);const identity=demoIdentity();
 const client=createSafeSdkClient({appId:'fixture',appSecret:'fixture',domain:'feishu',httpInstance:{request} as never});
 const gateway=new FeishuSdkReadGateway({identity,reads:bindSdkReads(client)},{get:async()=>({accessToken:'synthetic',refreshToken:'synthetic',expiresAt:Date.now()+1e6,refreshExpiresAt:Date.now()+2e6})});
 const handles=new Handles(randomBytes(32));return {identity,request,domains:new FeishuProviderDomains(gateway,handles),reads:new FeishuProviderReads(gateway,handles)};
}
describe('independent second-slice negative checks',()=>{
 it('missing freebusy_items must remain unknown rather than assert free/complete',async()=>{
  const s=setup({code:0,data:{freebusy_lists:[{user_id:'ou_fixture'}]}});
  const result=await s.domains.freeBusy(s.identity,{people:['ou_fixture'],time_range:{start:'2026-10-05T00:00:00Z',end:'2026-10-06T00:00:00Z'},timezone:'UTC'});
  expect(result.people[0]?.known).toBe(false);expect(result.complete).toBe(false);
 });
 it('does not emit unexpected Base search metadata without base.read',async()=>{
  const s=setup({code:0,data:{has_more:false,res_units:[{result_meta:{token:'synthetic-base',doc_types:'BITABLE'},summary_highlighted:'synthetic base record'}]}});
  const identity={...s.identity,scopes:['search.read','docs.read']};
  let leaked=false; try{const result=await s.reads.searchDocuments(identity,'demo',['DOCX']);leaked=result.results.some(r=>r.resource_type==='BITABLE');}catch{}
  expect(leaked).toBe(false);
 });
 it('a pre-disconnect refresh cannot overwrite a later re-linked grant with the same connection ID',async()=>{
  const db=await PGlite.create();try {
   for(const file of ['001_connections.sql','002_oauth_link_attempts.sql','003_resource_access.sql'])await db.exec(await readFile(new URL(`../infra/migrations/${file}`,import.meta.url),'utf8'));
   const query=async(sql:string,values?:unknown[])=>{const result=await db.query(sql,values);return {...result,rowCount:result.affectedRows??result.rows.length}};
   const pool={connect:async()=>({query,release:()=>{}})};const cipher=new TokenCipher(new Map([['review',randomBytes(32)]]),'review');
   const repository=new PostgresConnectionRepository(pool as never,cipher);const store=new PostgresTokenStore({query} as never,cipher);const identity=demoIdentity();
   const old={accessToken:'synthetic-old',refreshToken:'synthetic-old-refresh',expiresAt:0,refreshExpiresAt:Date.now()+1e6};
   const fresh={...old,accessToken:'synthetic-new-link',expiresAt:Date.now()+1e6};const stale={...old,accessToken:'synthetic-late-refresh',expiresAt:Date.now()+1e6};
   await repository.link(identity,{openId:'ou_fixture',tenantId:identity.tenantId},old);
   let release!:(value:typeof stale)=>void;let signal!:()=>void;const started=new Promise<void>(resolve=>{signal=resolve});
   const coordinator=new TokenRefreshCoordinator(store,()=>{signal();return new Promise(resolve=>{release=resolve})});
   const pending=coordinator.get(identity);await started;await repository.disconnect(identity);await repository.link(identity,{openId:'ou_fixture',tenantId:identity.tenantId},fresh);release(stale);
   await pending.catch(()=>{});
   expect((await store.get(identity))?.accessToken==='synthetic-new-link').toBe(true);
  } finally {await db.close()}
 },30000);
 it('sanitizes pool acquisition failure just like query failure',async()=>{
  const cipher=new TokenCipher(new Map([['review',randomBytes(32)]]),'review');
  const repository=new PostgresConnectionRepository({connect:async()=>{throw new Error('synthetic_private_dsn')}} as never,cipher);let text='';
  try{await repository.disconnect(demoIdentity())}catch(error){text=String(error)}
  expect(text).not.toContain('synthetic_private_dsn');
 });
});
