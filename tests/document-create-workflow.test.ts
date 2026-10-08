import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PostgresConnectionRepository } from '../packages/auth/src/connection-repository.js';
import { PostgresTokenStore, TokenCipher } from '../packages/auth/src/vault.js';
import { PostgresDocumentWriteAccess } from '../packages/auth/src/document-write-access.js';
import { PostgresDocumentWriteStore } from '../packages/policy/src/document-write-store.js';
import { WriteConfirmationAuthority } from '../packages/policy/src/write-confirmation.js';
import { CreateDocumentWorkflow } from '../packages/tools/src/create-document-workflow.js';
import { DocumentCreateProvider } from '../packages/feishu/src/document-create-provider.js';
import { createSafeSdkClient } from '../packages/feishu/src/sdk-client.js';
import { demoIdentity } from '../packages/feishu/src/fixtures.js';
import { digest } from '../packages/policy/src/core.js';
import { readToolNames, writeToolNames } from '../packages/schemas/src/catalog.js';

let db: PGlite;
const bearer = 'D'.repeat(43); const betaBearer = 'E'.repeat(43); const resource = 'https://mcp.example.test/mcp';
const identity = { ...demoIdentity(), scopes: ['docs.write'] };
const beta = { ...demoIdentity('beta'), scopes: ['docs.write'] };
const tokens = { accessToken:'synthetic-document-user-token',refreshToken:'synthetic-document-refresh',expiresAt:Date.now()+3600_000,refreshExpiresAt:Date.now()+7200_000 };
const input = { title:'Private synthetic title & <literal>',markdown:'# Fixture\n\nThis is synthetic document content.',folder_token:'fld_fixture' };
const query = async (sql: string, values?: unknown[]) => { const result = await db.query(sql,values); return { ...result,rowCount:result.affectedRows??result.rows.length }; };
const cipher = new TokenCipher(new Map([['fixture',randomBytes(32)]]),'fixture');
const connections = new PostgresConnectionRepository({connect:async()=>({query,release:()=>{}})} as never,cipher);
const tokenStore = new PostgresTokenStore({query} as never,cipher);
const access = new PostgresDocumentWriteAccess({query} as never,tokenStore,resource);
const store = new PostgresDocumentWriteStore({query} as never);
const authority = new WriteConfirmationAuthority(randomBytes(32));
const transport = vi.fn();
const provider = new DocumentCreateProvider(createSafeSdkClient({appId:'synthetic',appSecret:'synthetic',domain:'feishu',httpInstance:{request:transport} as never}),'feishu');
const workflow = () => new CreateDocumentWorkflow(access,store,authority,()=>provider,{enabled:true});
const created = {code:0,data:{document:{document_id:'doc_created',revision_id:1,url:'https://tenant.feishu.cn/docx/doc_created'},warnings:[]}};
const task = (status: string, extras: object = {}) => ({code:0,data:{task:{task_id:'task_fixture',type:'create_document',status,...extras}}});
const asyncDone = () => task('succeeded',{result:{create_document:JSON.stringify(created.data)}});
async function seed(who=identity,token=bearer) {
  await connections.link(who,{openId:'ou_fixture_'+who.connectionId,tenantId:who.tenantId,grantedProviderScopes:['docx:document:create']},tokens);
  const grant='g_'+digest(token).slice(0,12);
  await query('INSERT INTO oauth_grants(id,subject,connection_id,scopes,resource,client_id) VALUES($1,$2,$3,$4,$5,$6)',[grant,who.subject,who.connectionId,['docs.write'],resource,'synthetic_host']);
  await query("INSERT INTO mcp_access_tokens(token_hash,grant_id,grant_generation,expires_at) VALUES($1,$2,1,now()+interval '1 hour')",[digest(token),grant]);
}
async function approved(w=workflow(),key='request_fixture',raw:unknown=input) {
  const preview=await w.preview(bearer,raw,key);
  const proof=authority.issue({...preview.confirmation_request,decision:'approve'});
  await w.confirm(bearer,preview.receipt.intent_id,proof);
  return {w,preview,proof,id:preview.receipt.intent_id};
}
beforeAll(async()=>{db=await PGlite.create();for(const name of ['001_connections.sql','002_oauth_link_attempts.sql','003_resource_access.sql','004_mcp_issuer.sql','005_document_write_intents.sql'])await db.exec(await readFile(new URL('../infra/migrations/'+name,import.meta.url),'utf8'));},30000);
beforeEach(async()=>{await db.exec('TRUNCATE feishu_connections CASCADE');transport.mockReset();transport.mockResolvedValue(created);await seed();});
afterAll(async()=>{await db.close();});

describe('default-off, durable document creation candidate',()=>{
  it('previews exact content/destination without a provider call or plaintext storage',async()=>{
    const w=workflow();const preview=await w.preview(bearer,input,'idempotency_fixture');
    expect(preview.review).toMatchObject({title:input.title,markdown:input.markdown,destination:{kind:'drive_folder',folder_token:'fld_fixture'}});
    expect(preview.requires_confirmation).toBe(true);expect(preview.receipt.may_have_created).toBe(false);
    const stored=JSON.stringify((await query('SELECT * FROM document_write_intents')).rows);
    for(const secret of [input.title,input.markdown,tokens.accessToken,bearer,'idempotency_fixture'])expect(stored).not.toContain(secret);
    expect(transport).not.toHaveBeenCalled();
  });
  it('requires a host-signed decision, then creates exactly the reviewed Markdown and returns a receipt',async()=>{
    const s=await approved();expect(transport).not.toHaveBeenCalled();
    const receipt=await s.w.execute(bearer,s.id,input);
    expect(receipt).toMatchObject({status:'succeeded',document_id:'doc_created',content_verified:false,may_have_created:true,automatic_create_retry_allowed:false,live_verified:false});
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0]).toMatchObject({method:'POST',url:'https://open.feishu.cn/open-apis/docs_ai/v1/documents',data:{format:'markdown',content:'<title>Private synthetic title &amp; &lt;literal&gt;</title>\n'+input.markdown,parent_token:'fld_fixture',extra_param:'{"open_create_async":true}'},headers:{Authorization:'Bearer '+tokens.accessToken}});
    expect(JSON.stringify(transport.mock.calls)).not.toContain(bearer);
  });
  it('uses the explicit personal-library destination when no folder was selected',async()=>{
    const raw={title:'Personal',markdown:'Synthetic text'};const s=await approved(workflow(),'personal_fixture',raw);await s.w.execute(bearer,s.id,raw);
    expect(transport.mock.calls[0]![0].data).toMatchObject({parent_position:'my_library'});expect(transport.mock.calls[0]![0].data).not.toHaveProperty('parent_token');
  });
  it('does not execute an unconfirmed preview or accept confirmed:true as input',async()=>{
    const w=workflow();const p=await w.preview(bearer,input,'unconfirmed_fixture');
    await expect(w.execute(bearer,p.receipt.intent_id,input)).rejects.toMatchObject({type:'PERMISSION_DENIED'});
    await expect(w.execute(bearer,p.receipt.intent_id,{...input,confirmed:true})).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['not-a-proof','true','a.b.c',''])('rejects forged confirmation %s',async proof=>{
    const w=workflow();const p=await w.preview(bearer,input,'forged_fixture');
    await expect(w.confirm(bearer,p.receipt.intent_id,proof)).rejects.toMatchObject({type:'PERMISSION_DENIED'});expect(transport).not.toHaveBeenCalled();
  });
  it('binds the proof to exactly one preview, payload and signing authority',async()=>{
    const w=workflow();const one=await w.preview(bearer,input,'proof_one');const two=await w.preview(bearer,{...input,title:'Other'},'proof_two');
    const proof=authority.issue({...one.confirmation_request,decision:'approve'});
    await expect(w.confirm(bearer,two.receipt.intent_id,proof)).rejects.toThrow();
    const wrong=new WriteConfirmationAuthority(randomBytes(32)).issue({...one.confirmation_request,decision:'approve'});
    await expect(w.confirm(bearer,one.receipt.intent_id,wrong)).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
  });
  it.each([{title:'Changed'},{markdown:'Changed body'},{folder_token:'fld_other'}])('rejects edited content or target after approval %s',async change=>{
    const s=await approved();await expect(s.w.execute(bearer,s.id,{...input,...change})).rejects.toMatchObject({type:'CONFLICT'});expect(transport).not.toHaveBeenCalled();
  });
  it('keeps a cancelled preview from creating a document',async()=>{
    const w=workflow();const p=await w.preview(bearer,input,'cancelled_fixture');const proof=authority.issue({...p.confirmation_request,decision:'cancel'});
    expect((await w.confirm(bearer,p.receipt.intent_id,proof)).status).toBe('cancelled');
    expect((await w.execute(bearer,p.receipt.intent_id,input)).status).toBe('cancelled');expect(transport).not.toHaveBeenCalled();
  });
  it('allows a trusted cancellation after approval but before the atomic execution claim',async()=>{
    const s=await approved();await s.w.confirm(bearer,s.id,authority.issue({...s.preview.confirmation_request,decision:'cancel'}));
    expect((await s.w.execute(bearer,s.id,input)).status).toBe('cancelled');expect(transport).not.toHaveBeenCalled();
  });
  it('expires previews instead of executing stale consent',async()=>{
    const s=await approved();await query("UPDATE document_write_intents SET expires_at=now()-interval '1 second'");
    expect((await s.w.execute(bearer,s.id,input)).status).toBe('expired');expect(transport).not.toHaveBeenCalled();
  });
  it('persists idempotency across workflow instances and rejects payload reuse under one key',async()=>{
    const s=await approved();await s.w.execute(bearer,s.id,input);
    const restarted=workflow();const again=await restarted.preview(bearer,input,'request_fixture');expect(again.receipt.intent_id).toBe(s.id);
    expect((await restarted.execute(bearer,s.id,input))).toMatchObject({status:'succeeded',document_id:'doc_created',replayed:true});
    await expect(restarted.preview(bearer,{...input,title:'Different'},'request_fixture')).rejects.toMatchObject({type:'CONFLICT'});
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('permits only one mutation for concurrent execution of an approved action',async()=>{
    const s=await approved();let release!:(value:unknown)=>void;let started!:()=>void;const reached=new Promise<void>(resolve=>{started=resolve;});
    transport.mockImplementationOnce(async()=>{started();return new Promise(resolve=>{release=resolve;});});
    const first=s.w.execute(bearer,s.id,input);await reached;
    expect((await workflow().execute(bearer,s.id,input)).status).toBe('executing');
    release(created);expect((await first).status).toBe('succeeded');expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not release an executing claim after a simulated process restart',async()=>{
    const s=await approved();const principal=await access.authenticate(bearer);expect(await store.claim(principal,s.id)).toBe(true);
    expect((await workflow().execute(bearer,s.id,input))).toMatchObject({status:'executing',may_have_created:true,automatic_create_retry_allowed:false});expect(transport).not.toHaveBeenCalled();
  });
  it('never recreates after the provider succeeds but receipt persistence fails',async()=>{
    let fail=true;const failingStore=new PostgresDocumentWriteStore({query:async(sql:string,values?:unknown[])=>{if(fail&&sql.includes('SET status=$1,receipt')){fail=false;throw new Error('synthetic storage failure');}return query(sql,values);}} as never);
    const w=new CreateDocumentWorkflow(access,failingStore,authority,()=>provider,{enabled:true});const s=await approved(w);
    await expect(w.execute(bearer,s.id,input)).rejects.toMatchObject({type:'UPSTREAM_ERROR'});
    expect((await workflow().execute(bearer,s.id,input)).status).toBe('executing');expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([429,503])('does not repeat an ambiguous POST after HTTP %s',async status=>{
    transport.mockRejectedValue({response:{status,data:'untrusted provider failure'}});const s=await approved();
    const receipt=await s.w.execute(bearer,s.id,input);expect(receipt).toMatchObject({status:'uncertain',may_have_created:true,automatic_create_retry_allowed:false});
    await workflow().execute(bearer,s.id,input);await workflow().getReceipt(bearer,s.id,true);expect(transport).toHaveBeenCalledTimes(1);expect(JSON.stringify(receipt)).not.toContain('untrusted');
  });
  it('returns pending until an explicit receipt refresh proves completion, never a second POST',async()=>{
    transport.mockResolvedValueOnce(task('processing')).mockResolvedValueOnce(asyncDone());const s=await approved();
    expect((await s.w.execute(bearer,s.id,input)).status).toBe('pending');
    expect((await workflow().execute(bearer,s.id,input)).status).toBe('pending');expect((await s.w.getReceipt(bearer,s.id)).status).toBe('pending');expect(transport).toHaveBeenCalledTimes(1);
    expect((await s.w.getReceipt(bearer,s.id,true))).toMatchObject({status:'succeeded',document_id:'doc_created'});
    expect(transport.mock.calls.map(c=>c[0].method)).toEqual(['POST','GET']);expect(transport.mock.calls[1]![0].url).toBe('https://open.feishu.cn/open-apis/docs_ai/v1/async_tasks/task_fixture');
  });
  it('preserves pending task recovery after an uncertain GET without repeating create',async()=>{
    transport.mockResolvedValueOnce(task('processing')).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(asyncDone());const s=await approved();await s.w.execute(bearer,s.id,input);
    expect((await s.w.getReceipt(bearer,s.id,true)).status).toBe('uncertain');expect((await workflow().getReceipt(bearer,s.id,true)).status).toBe('succeeded');expect(transport.mock.calls.map(c=>c[0].method)).toEqual(['POST','GET','GET']);
  });
  it('does not let a late processing poll overwrite a confirmed successful receipt',async()=>{
    transport.mockResolvedValueOnce(task('processing'));const s=await approved();await s.w.execute(bearer,s.id,input);
    let release!:(value:unknown)=>void;let started!:()=>void;const reached=new Promise<void>(resolve=>{started=resolve;});
    transport.mockImplementationOnce(async()=>{started();return new Promise(resolve=>{release=resolve;});}).mockResolvedValueOnce(asyncDone());
    const slow=s.w.getReceipt(bearer,s.id,true);await reached;expect((await workflow().getReceipt(bearer,s.id,true)).status).toBe('succeeded');release(task('processing'));
    expect((await slow).status).toBe('succeeded');expect((await s.w.getReceipt(bearer,s.id)).status).toBe('succeeded');
  });
  it('surfaces degraded creation without persisting or returning arbitrary warning text',async()=>{
    transport.mockResolvedValue({code:0,data:{...created.data,warnings:['raw-sensitive-fixture-warning']}});const s=await approved();const receipt=await s.w.execute(bearer,s.id,input);
    expect(receipt).toMatchObject({status:'partial',warnings_count:1,content_verified:false});expect(JSON.stringify(receipt)).not.toContain('raw-sensitive');expect(JSON.stringify((await query('SELECT * FROM document_write_intents')).rows)).not.toContain('raw-sensitive');
  });
  it.each(["UPDATE oauth_grants SET revoked_at=now()","UPDATE feishu_connections SET grant_generation=2","UPDATE feishu_connections SET provider_scopes='{}'","UPDATE feishu_connections SET status='revoked'"])('rechecks current grants before a confirmed write %s',async sql=>{
    const s=await approved();await db.exec(sql);await expect(s.w.execute(bearer,s.id,input)).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
  });
  it('checks authority again after the claim and before any provider mutation',async()=>{
    const guarding={authenticate:access.authenticate.bind(access),token:async(b:string,p:Parameters<typeof access.token>[1])=>{await db.exec('UPDATE oauth_grants SET revoked_at=now()');return access.token(b,p);}};
    const w=new CreateDocumentWorkflow(guarding,store,authority,()=>provider,{enabled:true});const s=await approved(w);
    expect((await w.execute(bearer,s.id,input))).toMatchObject({status:'failed',reason:'authorization_changed',may_have_created:false});expect(transport).not.toHaveBeenCalled();
  });
  it('requires separate internal write scope and actual provider consent',async()=>{
    await db.exec("UPDATE oauth_grants SET scopes=ARRAY['profile.read']; UPDATE feishu_connections SET scopes=ARRAY['profile.read']");
    await expect(workflow().preview(bearer,input,'scope_fixture')).rejects.toMatchObject({type:'INSUFFICIENT_SCOPE'});expect(transport).not.toHaveBeenCalled();
  });
  it('cannot read or approve another account intent',async()=>{
    const s=await approved();await seed(beta,betaBearer);await expect(workflow().getReceipt(betaBearer,s.id)).rejects.toMatchObject({type:'NOT_FOUND'});await expect(workflow().confirm(betaBearer,s.id,s.proof)).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
  });
  it('rejects old-key reuse after reconnection even if the request body is unchanged',async()=>{
    const s=await approved();await connections.link(identity,{openId:'ou_fixture_'+identity.connectionId,tenantId:identity.tenantId,grantedProviderScopes:['docx:document:create']},tokens);
    await query("UPDATE mcp_access_tokens SET grant_generation=2");
    await expect(workflow().preview(bearer,input,'request_fixture')).rejects.toMatchObject({type:'CONFLICT'});expect(transport).not.toHaveBeenCalled();
  });
  it.each([{markdown:'![image](https://example.test/image.png)'},{markdown:'<image src="https://example.test/a" />'},{markdown:'<sheet>resource</sheet>'},{markdown:''},{folder_token:'../target'},{confirmed:true}])('rejects unsupported media, rich XML and unexpected input %s',async change=>{
    await expect(workflow().preview(bearer,{...input,...change},'unsupported_fixture')).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
  });
  it('remains default-disabled and does not register a live write tool',async()=>{
    const w=new CreateDocumentWorkflow(access,store,authority,()=>provider);await expect(w.preview(bearer,input,'disabled_fixture')).rejects.toMatchObject({type:'UNSUPPORTED_CAPABILITY'});
    expect(readToolNames).not.toContain('create_doc');expect(writeToolNames).toContain('create_doc');expect(readToolNames).toHaveLength(17);expect(transport).not.toHaveBeenCalled();
  });
});
