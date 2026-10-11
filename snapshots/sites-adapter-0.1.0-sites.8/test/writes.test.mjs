import test from 'node:test';
import assert from 'node:assert/strict';
import {Writes,WriteProvider,writeInput,WRITE_SCOPES,SCOPES} from '../.test-build/module.mjs';
import {setup,P} from './helpers.mjs';
async function ready(){const s=await setup();await s.grant();s.env.FEISHU_WRITE_ENABLED='true';s.db.sql.prepare('UPDATE connections SET scopes=?').run(JSON.stringify([...SCOPES,...WRITE_SCOPES]));return s;}
const task={summary:'Synthetic test only',description:'not live',assignee_ids:[]};
const request=()=>({request_id:crypto.randomUUID(),parameters:task});
test('write intent is encrypted, owner-bound, idempotent and rejects changed payload under one request ID',async()=>{
 const s=await ready();let calls=0;const w=new Writes(s.env,async()=>{calls++;throw Error('should not execute')},s.now);const args=request(),r=await w.prepare(P,'create_task',args);
 assert.equal(calls,0);assert.equal(r.status,'pending');assert.equal((await w.prepare(P,'create_task',args)).intent_id,r.intent_id);
 assert(!s.db.sql.prepare('SELECT payload FROM write_intents').get().payload.includes(task.summary));
 await assert.rejects(()=>w.prepare(P,'create_task',{...args,parameters:{...task,summary:'changed'}}),{code:'request_id_conflict'});
 await assert.rejects(()=>w.review({...P,user:'other'},r.intent_id),{code:'intent_not_found'});
});
test('two concurrent confirms create exactly once and a completed request returns its receipt',async()=>{
 const s=await ready();let calls=0;let release;const hold=new Promise(r=>release=r);const w=new Writes(s.env,async()=>{calls++;await hold;return Response.json({code:0,data:{task:{guid:'task_one'}}})},s.now);const r=await w.prepare(P,'create_task',request());
 const a=w.execute(P,r.intent_id),b=w.execute(P,r.intent_id);await new Promise(r=>setTimeout(r,10));release();const results=await Promise.all([a,b]);assert.equal(calls,1);assert(results.some(r=>r.status==='succeeded'));assert.equal((await w.execute(P,r.intent_id)).status,'succeeded');assert.equal(calls,1);
});
test('cancellation, expired review, disconnect and permission removal prevent business writes',async()=>{
 for(const mode of ['cancel','expire','disconnect','scope']){const s=await ready();let calls=0;const w=new Writes(s.env,async()=>{calls++;throw Error('must not run')},s.now);const r=await w.prepare(P,'create_task',request());
 if(mode==='cancel'){await w.cancel(P,r.intent_id);assert.equal((await w.execute(P,r.intent_id)).status,'cancelled');}
 else {if(mode==='expire')s.db.sql.prepare('UPDATE write_intents SET expires=0').run();if(mode==='disconnect')s.db.sql.prepare("UPDATE connections SET status='revoked'").run();if(mode==='scope')s.db.sql.prepare("UPDATE connections SET scopes='[]'").run();await assert.rejects(()=>w.execute(P,r.intent_id));}assert.equal(calls,0);}
});
test('ambiguous transport result is persisted and never automatically retried',async()=>{
 const s=await ready();let calls=0;const w=new Writes(s.env,async()=>{calls++;throw Error('socket closed after server accepted')},s.now);const r=await w.prepare(P,'create_task',request());const result=await w.execute(P,r.intent_id);assert.equal(result.status,'unknown');await w.execute(P,r.intent_id);assert.equal(calls,1);
});
test('write validation rejects block overflow before document creation and unknown fields',()=>{
 assert.throws(()=>writeInput('create_doc',{title:'x',text:Array(51).fill('line').join('\n')}));assert.throws(()=>writeInput('send_message',{receive_id:'oc_test',receive_id_type:'chat_id',text:'x',url:'https://evil.test'}));
});
const booking={calendar_id:'calendar@example.test',room_id:'omm_room',summary:'Synthetic room booking',time_range:{start:'2030-01-01T09:00:00Z',end:'2030-01-01T10:00:00Z'},timezone:'UTC',attendee_ids:[]};
test('room booking distinguishes accepted, pending and rejected resource RSVP from HTTP success',async()=>{
 for(const [rsvp,status] of [['accept','succeeded'],['needs_action','pending'],['decline','partial']]){const calls=[];const p=new WriteProvider(async(url,init)=>{calls.push({url,body:init.body?JSON.parse(init.body):null});let data;if(url.includes('freebusy/list'))data={freebusy_list:[]};else if(url.includes('idempotency_key'))data={event:{event_id:'event_1'}};else if(init.method==='POST')data={attendees:[{room_id:'omm_room',rsvp_status:'needs_action'}]};else data={items:[{type:'resource',room_id:'omm_room',rsvp_status:rsvp}],has_more:false};return Response.json({code:0,data});});const result=await p.execute('synthetic','book_meeting_room',booking,crypto.randomUUID());assert.equal(result.status,status);assert.equal(calls.length,4);assert.equal(calls[2].body.attendees[0].type,'resource');assert.equal(calls[2].body.attendees[0].room_id,'omm_room');}
});
test('room conflict and stale event time stop before any mutation',async()=>{
 for(const existing of [false,true]){let writes=0;const p=new WriteProvider(async(url,init)=>{if(init.method!=='GET'&&!url.includes('/freebusy/'))writes++;return Response.json({code:0,data:existing?{event:{event_id:'event_1',start_time:{timestamp:'0'},end_time:{timestamp:'1'}}}:{freebusy_list:[{start_time:booking.time_range.start,end_time:booking.time_range.end}]}});});const r=await p.execute('synthetic','book_meeting_room',{...booking,...(existing?{event_id:'event_1'}:{})},crypto.randomUUID());assert.equal(r.status,'failed');assert.equal(writes,0);}
});
test('created event is retained in partial receipt when room submission is rejected',async()=>{
 const p=new WriteProvider(async(url)=>Response.json({code:url.includes('/attendees')?403:0,data:url.includes('/freebusy/')?{freebusy_list:[]}:{event:{event_id:'created_1'}}}));const r=await p.execute('synthetic','book_meeting_room',booking,crypto.randomUUID());assert.equal(r.status,'partial');assert.equal(r.effects[0].event_id,'created_1');assert.equal(r.retry_safe,false);
});
test('MCP prepares but cannot bypass browser confirmation by adding a confirmation field',async()=>{
 const s=await ready();const bad=await s.tool({...request(),confirmed:true},P.user,'create_task');assert.equal(bad.result.isError,true);
 const created=await s.tool(request(),P.user,'create_task');assert.equal(created.result.structuredContent.status,'pending');const id=created.result.structuredContent.intent_id;
 const denied=await s.send('/api/writes/'+id,{method:'POST',body:{action:'confirm',csrf:'fake'},headers:{Origin:P.site}});assert.equal(denied.status,403);
 const page=await s.send('/write-review/'+id);assert.equal(page.status,200);const cookie=page.headers.get('set-cookie').split(';')[0];const state=await s.send('/api/writes/'+id,{headers:{Cookie:cookie}});const detail=await state.json();assert.equal(detail.parameters.summary,task.summary);
 const cancelled=await s.send('/api/writes/'+id,{method:'POST',body:{action:'cancel',csrf:detail.csrf},headers:{Origin:P.site,Cookie:cookie}});assert.equal((await cancelled.json()).status,'cancelled');
});
