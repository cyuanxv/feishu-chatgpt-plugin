import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadonlyAPI,readInput,Apps,READ_SCOPES} from '../.test-build/module.mjs';
import {setup,P} from './helpers.mjs';
test('read operation allowlist rejects writes, arbitrary paths and oversized sheet ranges before network',async()=>{
 const s=await setup();let calls=0;const api=new ReadonlyAPI(async()=>{calls++;return Response.json({});},s.vault,s.now);
 assert.throws(()=>readInput({operation:'delete',parameters:{}}));assert.throws(()=>readInput({operation:'wiki_node',parameters:{token:'../secret'}}));assert.throws(()=>readInput({operation:'tasks',parameters:{url:'https://evil.test'}}));
 await assert.rejects(()=>api.run(P,'grant','synthetic',readInput({operation:'sheet_values',parameters:{token:'tok',range:'abc!A1:ZZ10000'}})),{code:'range_limit_2000_cells'});assert.equal(calls,0);
});
test('paged reads bind cursor to owner, grant, operation and exact parameters',async()=>{
 const s=await setup();let calls=[];const api=new ReadonlyAPI(async(url,init)=>{calls.push({url,init});return Response.json({code:0,data:{items:[{title:'sample'}],has_more:!url.includes('page_token'),page_token:'next'}});},s.vault,s.now);
 const input=readInput({operation:'wiki_nodes',parameters:{space_id:'123'}});const first=await api.run(P,'g','synthetic',input);assert.equal(first.partial,true);
 for(const [p,g,x] of [[{...P,user:'other'},'g',input],[P,'new',input],[P,'g',readInput({operation:'wiki_nodes',parameters:{space_id:'456'}})]])await assert.rejects(()=>api.run(p,g,'synthetic',{...x,cursor:first.next_cursor}));
 const last=await api.run(P,'g','synthetic',{...input,cursor:first.next_cursor});assert.equal(last.traversal_complete,true);assert.equal(calls.length,2);assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.redirect,'manual');
});
test('all four domains use fixed documented read endpoints',async()=>{
 const s=await setup();const seen=[];const api=new ReadonlyAPI(async(url,init)=>{seen.push({url,method:init.method,body:init.body});return Response.json({code:0,data:{items:[],has_more:false,sheets:[],valueRange:{values:[]},node:{obj_type:'docx'}}});},s.vault,s.now);
 for(const [operation,parameters] of [['wiki_spaces',{}],['wiki_node',{token:'tok'}],['sheet_tabs',{token:'tok'}],['sheet_values',{token:'tok',range:'abc!A1:C3'}],['base_tables',{token:'tok'}],['base_fields',{token:'tok',table_id:'tbl'}],['base_records',{token:'tok',table_id:'tbl'}],['tasks',{}],['task',{task_guid:'guid'}],['tasklists',{}],['tasklist_tasks',{tasklist_guid:'guid'}]])await api.run(P,'g','synthetic',readInput({operation,parameters}));
 assert.equal(seen.filter(v=>v.method==='POST').length,1);assert(seen.find(v=>v.method==='POST').url.includes('/records/search'));assert(seen.every(v=>v.url.startsWith('https://open.feishu.cn/open-apis/')));
});
test('provider denial and malformed pagination fail without fabricated empty success',async()=>{
 const s=await setup();for(const data of [{code:99991679},{code:0,data:{items:[],has_more:true}}]){const api=new ReadonlyAPI(async()=>Response.json(data),s.vault,s.now);await assert.rejects(()=>api.run(P,'g','synthetic',readInput({operation:'tasks'})));}
});
test('scope-aware routing explains missing authorization without provider calls',async()=>{
 const s=await setup();await s.grant();let calls=0;const apps=new Apps(s.env,async()=>{calls++;throw Error('unexpected')},s.now);const r=await apps.query(P,{operation:'tasks'});assert.equal(r.error,'insufficient_scope');assert.deepEqual(r.required_scopes_any,['task:task:read']);assert.equal(calls,0);assert(READ_SCOPES.every(s=>!s.endsWith(':write')));
});
test('search bounded coverage is explicitly partial at provider limit',async()=>{
 const s=await setup();const api=new ReadonlyAPI(async(url,init)=>{const b=JSON.parse(init.body);return Response.json({code:0,data:{docs_entities:Array.from({length:b.count},()=>({docs_token:'tok'})),has_more:true}})},s.vault,s.now);let cursor,r;for(let i=0;i<10;i++){r=await api.run(P,'g','synthetic',readInput({operation:'search_files',parameters:{query:'AI',page_size:20},...(cursor?{cursor}:{})}));cursor=r.next_cursor;}assert.equal(r.limit_reached,true);assert.equal(r.partial,true);assert.equal(r.next_cursor,null);
});
