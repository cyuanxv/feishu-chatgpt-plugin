import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresDocumentWriteStore } from '../packages/policy/src/document-write-store.js';
import { demoIdentity } from '../packages/feishu/src/fixtures.js';
import { documentRequestHash } from '../packages/schemas/src/document-write.js';
import type { DocumentWriteReceipt } from '../packages/schemas/src/document-write.js';

// Only the existing ephemeral synthetic CI service. Never reads operator database settings.
describe.skipIf(process.env.GITHUB_ACTIONS!=='true'||process.env.FEISHU_CI_POSTGRES!=='1')('native PostgreSQL document-write idempotency',()=>{
  const schema='doc_fixture_'+randomUUID().replaceAll('-','');
  const config={host:'127.0.0.1',port:5432,user:'synthetic_ci',password:'synthetic_ci',database:'feishu_ci',connectionTimeoutMillis:5000,query_timeout:10000,statement_timeout:10000};
  let admin:Pool,pool:Pool,store:PostgresDocumentWriteStore;
  const identity={...demoIdentity(),scopes:['docs.write']};
  const principal={identity,grantId:'synthetic_grant',generation:'1',clientId:'synthetic_host',resource:'https://mcp.example.test/mcp'};
  const hash=documentRequestHash({title:'Synthetic',markdown:'Synthetic text'});
  beforeAll(async()=>{admin=new Pool({...config,max:1});await admin.query(`CREATE SCHEMA ${schema}`);pool=new Pool({...config,max:8,options:`-c search_path=${schema}`});for(const f of ['001_connections.sql','005_document_write_intents.sql'])await pool.query(await readFile(new URL('../infra/migrations/'+f,import.meta.url),'utf8'));store=new PostgresDocumentWriteStore(pool);});
  beforeEach(async()=>{await pool.query('TRUNCATE feishu_connections CASCADE');await pool.query("INSERT INTO feishu_connections(id,subject,tenant_id,domain,open_id,scopes,status) VALUES($1,$2,$3,$4,'synthetic_user',ARRAY['docs.write'],'active')",[identity.connectionId,identity.subject,identity.tenantId,identity.domain]);});
  afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
  it('deduplicates simultaneous previews across independent connections',async()=>{
    const results=await Promise.all(Array.from({length:8},()=>store.prepare(principal,hash,'same_request')));
    expect(new Set(results.map(r=>r.id)).size).toBe(1);expect((await pool.query('SELECT count(*)::int AS n FROM document_write_intents')).rows[0].n).toBe(1);
  });
  it('permits exactly one concurrent execution claim',async()=>{
    const row=await store.prepare(principal,hash,'claim_fixture');await store.confirm(principal,row.id,'approve');
    const claims=await Promise.all(Array.from({length:8},()=>store.claim(principal,row.id)));expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it('never both cancels successfully and claims execution in a cancellation race',async()=>{
    const row=await store.prepare(principal,hash,'cancel_fixture');await store.confirm(principal,row.id,'approve');
    const result=await Promise.allSettled([store.claim(principal,row.id),store.confirm(principal,row.id,'cancel')]);
    const claimed=result[0].status==='fulfilled'&&result[0].value===true;const cancelled=result[1].status==='fulfilled';expect(claimed&&cancelled).toBe(false);
    expect((await store.get(principal,row.id)).status).toBe(claimed?'executing':'cancelled');
  });
  it('preserves an executing reservation when the adapter is reconstructed',async()=>{
    const row=await store.prepare(principal,hash,'restart_fixture');await store.confirm(principal,row.id,'approve');expect(await store.claim(principal,row.id)).toBe(true);
    const second=new Pool({...config,max:2,options:`-c search_path=${schema}`});try{const restarted=new PostgresDocumentWriteStore(second);expect(await restarted.claim(principal,row.id)).toBe(false);expect((await restarted.get(principal,row.id)).status).toBe('executing');}finally{await second.end();}
  });
  it('rejects competing different content under the same idempotency key',async()=>{
    const other=documentRequestHash({title:'Different',markdown:'Synthetic text'});
    const results=await Promise.allSettled([store.prepare(principal,hash,'collision_fixture'),store.prepare(principal,other,'collision_fixture')]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect((await pool.query('SELECT count(*)::int AS n FROM document_write_intents')).rows[0].n).toBe(1);
  });
  it('retains late warning evidence atomically without losing a successful document receipt',async()=>{
    const row=await store.prepare(principal,hash,'warnings_fixture');await store.confirm(principal,row.id,'approve');await store.claim(principal,row.id);
    const receipt=(status:'pending'|'succeeded',warnings:number):DocumentWriteReceipt=>({operation:'create_doc',status,intent_id:row.id,document_id:status==='succeeded'?'doc_fixture':null,revision_id:status==='succeeded'?1:null,url:null,reason:status==='succeeded'?'provider_created':'provider_processing',warnings_count:warnings,warning_count_mode:'max_observed',may_have_created:true,automatic_create_retry_allowed:false,content_verified:false,replayed:false,live_verified:false});
    await store.finish(principal,row.id,receipt('pending',0),'task_fixture','execution');
    await Promise.all([store.finish(principal,row.id,receipt('succeeded',0),'task_fixture','poll'),store.finish(principal,row.id,receipt('pending',3),'task_fixture','poll')]);
    const final=await store.get(principal,row.id);expect(final.status).toBe('partial');expect(final.receipt).toMatchObject({status:'partial',document_id:'doc_fixture',revision_id:1,warnings_count:3});
  });
});
