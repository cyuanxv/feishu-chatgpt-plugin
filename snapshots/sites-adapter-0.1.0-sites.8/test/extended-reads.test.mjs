import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadonlyAPI,readInput,READ_TOOL,Apps} from '../.test-build/module.mjs';
import {setup,P} from './helpers.mjs';
const time_range={start:'2026-10-12T09:00:00+08:00',end:'2026-10-12T10:00:00+08:00'};
test('room lookup requires definite ordered timestamps and forwards RFC3339 rather than epoch strings',async()=>{
 for(const parameters of [{timezone:'Asia/Shanghai'},{time_range:{...time_range,end:time_range.start},timezone:'Asia/Shanghai'},{time_range,timezone:'Invalid/Zone'}])assert.throws(()=>readInput({operation:'rooms',parameters}));
 const s=await setup();let request;const api=new ReadonlyAPI(async(url,init)=>{request={url,body:JSON.parse(init.body)};return Response.json({code:0,data:{available_rooms:[{room_id:'omm_room',room_name:'A'}]}})},s.vault,s.now);
 const result=await api.run(P,'g','token',readInput({operation:'rooms',parameters:{time_range,timezone:'Asia/Shanghai',min_capacity:4}}));
 assert(request.url.endsWith('/calendar/v4/freebusy/room_find'));assert.equal(request.body.event_start_time,time_range.start);assert.equal(request.body.min_capacity,4);assert.equal(result.data.available_rooms[0].room_id,'omm_room');
});
test('room busy never sends a user id; malformed busy data cannot become available',async()=>{
 const s=await setup();let body;const input=readInput({operation:'room_availability',parameters:{room_id:'omm_room',time_range}});
 const api=new ReadonlyAPI(async(url,init)=>{body=JSON.parse(init.body);return Response.json({code:0,data:{freebusy_list:[{start_time:'bad',end_time:'bad'}]}})},s.vault,s.now);
 await assert.rejects(()=>api.run(P,'g','token',input),{code:'provider_response_invalid'});assert.equal(body.room_id,'omm_room');assert.equal(body.user_id,undefined);
});
test('people truncation asks to refine instead of inventing a continuation or full coverage',async()=>{
 const s=await setup();const api=new ReadonlyAPI(async()=>Response.json({code:0,data:{items:[{id:'ou_one'}],has_more:true}}),s.vault,s.now);
 const r=await api.run(P,'g','token',readInput({operation:'people',parameters:{query:'王'}}));assert.equal(r.refinement_required,true);assert.equal(r.next_cursor,null);assert.equal(r.traversal_complete,false);
});
test('message filters bind pagination and reject mismatching upstream chat',async()=>{
 const s=await setup();let seen;const api=new ReadonlyAPI(async(url,init)=>{seen=JSON.parse(init.body);return Response.json({code:0,data:{items:[{meta_data:{message_id:'om_one',chat_id:'oc_other'}}],has_more:false}})},s.vault,s.now);
 await assert.rejects(()=>api.run(P,'g','token',readInput({operation:'messages',parameters:{query:'测试',chat_id:'oc_expected',time_range}})),{code:'provider_response_invalid'});assert.equal(seen.filter.time_range.start_time,String(Date.parse(time_range.start)/1000));
});
test('pagination rejects A-B-A cycles, including empty pages, and cross-operation continuations',async()=>{
 const s=await setup();let i=0;const api=new ReadonlyAPI(async()=>Response.json({code:0,data:{items:[],has_more:true,page_token:['A','B','A'][i++]}}),s.vault,s.now);const input=readInput({operation:'chats'});
 const a=await api.run(P,'g','token',input);const b=await api.run(P,'g','token',{...input,cursor:a.next_cursor});
 await assert.rejects(()=>api.run(P,'g','token',{...input,cursor:b.next_cursor}),{code:'provider_pagination_invalid'});
 await assert.rejects(()=>api.run(P,'g','token',{...readInput({operation:'doc_comments',parameters:{token:'doc'}}),cursor:a.next_cursor}));
});
test('profile strips incidental personal fields and tool schema exposes new arguments',async()=>{
 const s=await setup();const api=new ReadonlyAPI(async()=>Response.json({code:0,data:{name:'User',open_id:'ou_one',tenant_key:'tenant',email:'private@example.test',avatar_url:'https://example.test'}}),s.vault,s.now);
 const r=await api.run(P,'g','token',readInput({operation:'profile'}));assert.deepEqual(r.data,{name:'User',open_id:'ou_one',tenant_key:'tenant'});
 for(const key of ['time_range','room_id','calendar_id','comment_id','thread_id'])assert(READ_TOOL.inputSchema.properties.parameters.properties[key]);
});

test('meeting suggestions respect touching boundaries, overlapping busy time and unknown availability',async()=>{
 const {meetingSlots}=await import('../.test-build/module.mjs');
 const start='2026-10-12T09:00:00Z',end='2026-10-12T11:00:00Z';
 const people=[{user_id:'ou_1',busy:[{start_time:start,end_time:'2026-10-12T09:30:00Z'}]},{user_id:'ou_2',busy:[{start_time:'2026-10-12T10:00:00Z',end_time:'2026-10-12T10:30:00Z'}]}];
 assert.deepEqual(meetingSlots(start,end,30,30,people).slots,[{start:'2026-10-12T09:30:00.000Z',end:'2026-10-12T10:00:00.000Z'},{start:'2026-10-12T10:30:00.000Z',end:'2026-10-12T11:00:00.000Z'}]);
 assert.throws(()=>meetingSlots(start,end,30,30,[{user_id:'ou_1'}]),{code:'availability_unknown'});
 assert.throws(()=>meetingSlots(start,end,30,0,people));
});
