import test from 'node:test';
import assert from 'node:assert/strict';
import {Apps,createWorker} from '../.test-build/module.mjs';
import {setup,P,request,ARGS} from './helpers.mjs';
const id='cli_testapp00000001', scopes=['offline_access','search:docs:read','docx:document:readonly'];
async function fixture(refreshToken="synthetic-refresh"){
 const s=await setup();s.env.FEISHU_DOCX_ENABLED='true';let requests=[];
 const fetcher=async(url,init={})=>{
  requests.push(url);
  if(url.endsWith('/oauth/token') && JSON.parse(init.body).grant_type==='refresh_token') assert.equal(JSON.parse(init.body).scope,scopes.join(' '));
  if(url.endsWith('/tenant_access_token/internal'))return Response.json({code:0,tenant_access_token:'synthetic-tenant'});
  if(url.endsWith('/application/v6/scopes'))return Response.json({code:0,data:{scopes:scopes.map(scope_name=>({scope_name,grant_status:1}))}});
  if(url.endsWith('/oauth/token')&&JSON.parse(init.body).client_id===id)return Response.json({access_token:'synthetic-doc-token',refresh_token:refreshToken,token_type:'Bearer',expires_in:3600,refresh_token_expires_in:86400,scope:scopes.join(' ')});
  if(url.endsWith('/user_info'))return Response.json({code:0,data:{tenant_key:'same-tenant',open_id:'app-specific-openid',union_id:'same-person',name:'Synthetic'}});
  if(url.includes('/doc_wiki/search'))return Response.json({code:0,data:{res_units:[{entity_type:'DOC',result_meta:{token:'synthetic_doc',doc_types:'DOCX'},title_highlighted:'Safe title'}],has_more:false}});
  if(url.endsWith('/raw_content'))return Response.json({code:0,data:{content:'hello world'}});
  return s.mocked.fetcher(url,init);
 };
 const worker=createWorker({fetcher,now:s.now}), apps=new Apps(s.env,fetcher,s.now);
 const send=(path,opts={})=>worker.fetch(request(path,opts),s.env);
 const status=async()=> (await send('/api/status')).json();
 async function add(){let csrf=(await status()).csrf;return send('/api/apps',{method:'POST',headers:{Origin:P.site},body:{csrf,app_id:id,label:'Secondary',app_secret:'synthetic-app-secret'}});}
 async function connect(){const csrf=(await status()).csrf;const r=await send('/api/apps/connect',{method:'POST',headers:{Origin:P.site},form:{csrf,connection_id:id}});assert.equal(r.status,303);const url=new URL(r.headers.get('location'));assert.equal(url.searchParams.get('scope'),scopes.join(' '));const cookie=r.headers.get('set-cookie').split(';')[0];const callback=await send('/api/feishu/callback?'+new URLSearchParams({state:url.searchParams.get('state'),code:'synthetic-code'}),{headers:{Cookie:cookie}});assert.equal(callback.status,303,await callback.clone().text());return cookie;}
 return {...s,send,status,apps,add,connect,requests};
}
test('application registration queries official scope API and stores only encrypted secret; no owner leak',async()=>{
 const s=await fixture();const r=await s.add();assert.equal(r.status,200);const data=await r.json();assert.equal(data.permission_count,3);assert.equal(JSON.stringify(data).includes('synthetic-app-secret'),false);
 const row=s.db.sql.prepare('SELECT * FROM app_registry').get();assert.equal(row.secret.includes('synthetic-app-secret'),false);
 const other=await s.send('/api/apps',{user:'other-owner'});assert.equal((await other.json()).connections.length,1);
 assert.equal((await s.add()).status,409);
});
test('second app supports DOCX-only OAuth, pinned fetch and refresh without calendar scopes',async()=>{
 const s=await fixture();await s.add();await s.connect();const list=await s.apps.list(P);assert.equal(list[1].connected,true);
 const found=await s.apps.read(P,'search_docx',{query:'hello'});assert.equal(found.connection_id,id);
 await assert.rejects(()=>s.apps.read(P,'fetch_docx',{result_id:found.results[0].result_id}),{code:'connection_reference_required'});
 const body=await s.apps.read(P,'fetch_docx',{result_id:found.results[0].result_id,connection_id:id});assert.equal(body.content,'hello world');
 const ctx=await s.apps.context(P,id);const grant=await s.store.get(ctx.p);await ctx.link.access(ctx.p,grant.grant_id,true);
 const fresh=await s.apps.read(P,'search_docx',{query:'hello'});assert.equal(fresh.source,'feishu_api');
 await assert.rejects(()=>s.apps.read(P,'get_agenda',ARGS),{code:'insufficient_scope'});
});
test('auto routing refuses different or unknown accounts; explicit selected connection stays isolated',async()=>{
 const s=await fixture();await s.add();await s.connect();await s.grant();
 await assert.rejects(()=>s.apps.read(P,'search_docx',{query:'hello'}),{code:'account_selection_required'});
 const doc=await s.apps.read(P,'search_docx',{query:'hello',connection_id:id});assert.equal(doc.results.length,1);
 await assert.rejects(()=>s.apps.read({...P,user:'another-owner'},'search_docx',{query:'hello',connection_id:id}),{code:'connection_required'});
});
test('CSRF and cross-origin registration fail before any provider request',async()=>{
 const s=await fixture();const n=s.requests.length;
 const r=await s.send('/api/apps',{method:'POST',body:{csrf:'invalid',app_id:id,label:'x',app_secret:'synthetic-app-secret'}});assert.equal(r.status,403);assert.equal(s.requests.length,n);
});

test("large opaque refresh credentials remain encrypted and renewable",async()=>{const s=await fixture("synthetic-"+"x".repeat(12000));await s.add();await s.connect();const ctx=await s.apps.context(P,id);const row=await s.store.get(ctx.p);await ctx.link.access(ctx.p,row.grant_id,true);assert.equal((await s.apps.list(P))[1].connected,true);});
