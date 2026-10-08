import { withUserAccessToken,type Client } from '@larksuiteoapi/node-sdk';
import { createTaskInput,providerTaskDue,taskGuid,type CreateTaskInput,type TaskWriteReceipt } from '../../schemas/src/task-write.js';
import { silentSdkLogger } from './sdk-client.js';
import { DomainError } from '../../policy/src/core.js';
export interface TaskCreateOutcome {status:'succeeded'|'partial'|'uncertain';guid:string|null;url:string|null;unverified:TaskWriteReceipt['unverified_fields'];}
const unknown=():TaskCreateOutcome=>({status:'uncertain',guid:null,url:null,unverified:[]});
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
/** Fixed Task v2 create, user token only. Local durable reservation, not the provider's five-minute
 * client_token window, is responsible for at-most-once dispatch across crashes and retries. */
export class TaskCreateProvider {
 constructor(private readonly client:Client,readonly domain:'feishu'|'lark'){
  if(!['feishu','lark'].includes(domain))throw new Error('Unsupported task provider.');client.logger=silentSdkLogger;
 }
 async create(raw:CreateTaskInput,intentId:string,userToken:string):Promise<TaskCreateOutcome>{
  const input=createTaskInput.parse(raw);taskGuid.parse(intentId);
  if(typeof userToken!=='string'||!userToken||/[\r\n]/.test(userToken)||userToken.length>8192)throw new DomainError('AUTH_REQUIRED','A current user token is required.');
  try{
   const response:unknown=await this.client.task.v2.task.create({data:{summary:input.summary,...(input.description!==undefined?{description:input.description}:{}),...(input.due?{due:providerTaskDue(input.due)}:{}),client_token:intentId,completed_at:'0'},params:{user_id_type:'open_id'}},withUserAccessToken(userToken));
   if(!object(response)||response.code!==0||!object(response.data)||!object(response.data.task)||Buffer.byteLength(JSON.stringify(response))>262144)return unknown();
   const task=response.data.task,parsed=taskGuid.safeParse(task.guid);if(!parsed.success)return unknown();
   const unverified:TaskWriteReceipt['unverified_fields']=[];
   if(task.summary!==input.summary)unverified.push('summary');
   if(task.description!==(input.description??''))unverified.push('description');
   const due=providerTaskDue(input.due);
   if(due?(!object(task.due)||task.due.timestamp!==due.timestamp||task.due.is_all_day!==due.is_all_day):(task.due!==undefined&&task.due!==null&&(!object(task.due)||!['0',''].includes(String(task.due.timestamp??'')))))unverified.push('due');
   // Missing fields remain unverified rather than claiming the provider honored unassigned/list-free scope.
   if(!Array.isArray(task.members)||task.members.length!==0)unverified.push('members');
   if(!Array.isArray(task.tasklists)||task.tasklists.length!==0)unverified.push('tasklists');
   if(task.completed_at!=='0')unverified.push('completed_at');
   const url=this.safeUrl(task.url,parsed.data);if(task.url!==undefined&&url===null)unverified.push('url');
   return{status:unverified.length?'partial':'succeeded',guid:parsed.data,url,unverified};
  }catch{return unknown();}
 }
 private safeUrl(value:unknown,guid:string):string|null {
  if(typeof value!=='string'||value.length>2048)return null;
  try{
   const url=new URL(value),host=this.domain==='feishu'?'applink.feishu.cn':'applink.larksuite.com';
   if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.hostname!==host||url.pathname!=='/client/todo/detail')return null;
   // Conservatively support one exact-task link shape; arbitrary query/path text is never stored.
   if(url.searchParams.get('guid')!==guid||url.searchParams.getAll('guid').length!==1)return null;
   for(const key of url.searchParams.keys()){
    if(key==='guid')continue;
    if(key!=='suite_entity_num'||url.searchParams.getAll(key).length!==1||!/^t[0-9]{1,20}$/.test(url.searchParams.get(key)??''))return null;
   }
   return url.href;
  }catch{return null;}
 }
}
