import test from 'node:test';
import assert from 'node:assert/strict';
import {Client,withUserAccessToken} from '@larksuiteoapi/node-sdk';
import {WriteProvider,writeInput} from '../.test-build/module.mjs';
const noop=()=>{};
function sdk(){const requests=[];const client=new Client({appId:'synthetic',appSecret:'synthetic',logger:{trace:noop,debug:noop,info:noop,warn:noop,error:noop},httpInstance:{request:async c=>{requests.push(c);return {code:0,data:{}};}}});return {client,requests};}
const cases=[
 ['send_message',{receive_id:'oc_test',receive_id_type:'chat_id',text:'sample'},'im.v1.message.create',{message_id:'om_result'}, {params:{receive_id_type:'chat_id'}}],
 ['reply_message',{message_id:'om_root',text:'sample'},'im.v1.message.reply',{message_id:'om_result'},{path:{message_id:'om_root'}}],
 ['add_doc_comment',{document_id:'doc1',text:'sample'},'drive.v1.fileComment.create',{comment_id:'comment1'},{path:{file_token:'doc1'},params:{file_type:'docx',user_id_type:'open_id'}}],
 ['create_base_record',{token:'base1',table_id:'table1',fields:{Name:'test'}},'bitable.v1.appTableRecord.create',{record:{record_id:'record1'}},{path:{app_token:'base1',table_id:'table1'},params:{user_id_type:'open_id'}}],
 ['update_base_record',{token:'base1',table_id:'table1',record_id:'record1',fields:{Name:'test'}},'bitable.v1.appTableRecord.update',{record:{record_id:'record1'}},{path:{app_token:'base1',table_id:'table1',record_id:'record1'},params:{user_id_type:'open_id'}}],
 ['create_task',{summary:'test'},'task.v2.task.create',{task:{guid:'task1'}},{params:{user_id_type:'open_id'}}],
 ['update_task',{task_guid:'task1',summary:'test'},'task.v2.task.patch',{task:{guid:'task1'}},{path:{task_guid:'task1'},params:{user_id_type:'open_id'}}],
 ['complete_task',{task_guid:'task1'},'task.v2.task.patch',{task:{guid:'task1'}},{path:{task_guid:'task1'},params:{user_id_type:'open_id'}}],
 ['create_event',{calendar_id:'calendar1',summary:'test',time_range:{start:'2030-01-01T09:00:00Z',end:'2030-01-01T10:00:00Z'},timezone:'UTC'},'calendar.v4.calendarEvent.create',{event:{event_id:'event1'}},{path:{calendar_id:'calendar1'}}],
 ['update_event',{calendar_id:'calendar1',event_id:'event1',summary:'test'},'calendar.v4.calendarEvent.patch',{event:{event_id:'event1'}},{path:{calendar_id:'calendar1',event_id:'event1'}}],
 ['respond_event',{calendar_id:'calendar1',event_id:'event1',rsvp_status:'accept'},'calendar.v4.calendarEvent.reply',{}, {path:{calendar_id:'calendar1',event_id:'event1'}}],
 ['update_doc',{document_id:'doc1',mode:'replace_block',block_id:'block1',revision:1,text:'test'},'docx.v1.documentBlock.patch',{}, {path:{document_id:'doc1',block_id:'block1'},params:{document_revision_id:1}}],
];
for(const [operation,args,method,data,payload] of cases)test('official SDK route parity: '+operation,async()=>{
 const actual=[];const requestId=crypto.randomUUID();const provider=new WriteProvider(async(url,init)=>{actual.push({url,init});return Response.json({code:0,data});});const result=await provider.execute('synthetic',operation,writeInput(operation,args),requestId);assert.equal(result.status,'succeeded');assert.equal(actual.length,1);
 const {client,requests}=sdk();let context=client;const segments=method.split('.');for(const p of segments.slice(0,-1))context=context[p];
 const body=JSON.parse(actual[0].init.body);const providerURL=new URL(actual[0].url);const params={...Object.fromEntries(providerURL.searchParams),...payload.params};await context[segments.at(-1)]({...payload,params,data:body},withUserAccessToken('synthetic'));
 const expected=requests[0];assert.equal(providerURL.pathname,new URL(expected.url).pathname);assert.equal(actual[0].init.method,expected.method);assert.deepEqual(JSON.parse(actual[0].init.body),expected.data);
});
