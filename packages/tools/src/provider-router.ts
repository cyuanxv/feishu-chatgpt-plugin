import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { inputSchemas, providerOutputSchema, readToolNames, scopeForTool, type ReadToolName } from '../../schemas/src/catalog.js';
import { DomainError, digest, RateLimiter, requireScope, type Identity } from '../../policy/src/core.js';
import { auditEvent, silentAudit, type AuditSink } from '../../observability/src/audit.js';
import type { FeishuProviderReads } from '../../feishu/src/provider-reads.js';
import type { FeishuProviderDomains } from '../../feishu/src/provider-domains.js';
import type { FeishuProviderWorkflows } from '../../feishu/src/provider-workflows.js';
import type { FeishuProviderBases } from '../../feishu/src/provider-bases.js';
import type { FeishuProviderTasks } from '../../feishu/src/provider-tasks.js';

export const providerReadNames = Object.freeze([...readToolNames]);
const bindingSchema = z.object({ subject:z.string().min(1).max(256),tenantId:z.string().min(1).max(256),connectionId:z.string().min(1).max(256),domain:z.enum(['feishu','lark']) }).strict();
const contextSchema = z.object({ identity:bindingSchema.extend({scopes:z.array(z.string().min(1).max(100)).max(100)}).strict(),audience:z.string(),expiresAt:z.number().finite().int() }).strict();
export type ProviderCallContext = z.infer<typeof contextSchema>;
export interface ProviderReadServices {
  reads: Pick<FeishuProviderReads,'profile'|'people'|'chats'|'searchMessages'>;
  domains: Pick<FeishuProviderDomains,'queryBase'|'freeBusy'|'roomMetadata'|'roomsWithAvailability'>;
  workflows: Pick<FeishuProviderWorkflows,'search'|'fetch'|'messageThread'|'comments'|'agenda'|'suggestMeetingTimes'>;
  bases: Pick<FeishuProviderBases,'search'|'inspect'>;
  tasks: Pick<FeishuProviderTasks,'list'|'detail'>;
}

/**
 * Inert, finite provider routing seam. No server imports this module, and it does not authenticate
 * bearer tokens. A future reviewed host adapter must supply authenticated context out of band;
 * never construct context from model/tool arguments. Real provider grants remain unconfigured.
 */
export class ProviderReadRouter {
  private readonly binding:z.infer<typeof bindingSchema>;
  constructor(private readonly resource:string,binding:Pick<Identity,'subject'|'tenantId'|'connectionId'|'domain'>,private readonly services:ProviderReadServices,private readonly audit:AuditSink=silentAudit,private readonly limiter=new RateLimiter()){
    const url=new URL(resource);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.href!==resource)throw new Error('A canonical HTTPS resource is required.');
    this.binding=Object.freeze(bindingSchema.parse({subject:binding.subject,tenantId:binding.tenantId,connectionId:binding.connectionId,domain:binding.domain}));
  }
  async call(name:string,input:unknown,rawContext:unknown):Promise<ReturnType<typeof providerOutputSchema.parse>>{
    const requestId=randomUUID();const started=Date.now();let connection='unauthenticated';
    const meta={request_id:requestId,identity:'user' as const,connection_hash:'unauthenticated',source:'feishu_api' as const,next_cursor:null as string|null,partial:false,live_verified:false as const};
    try{
      const parsedContext=contextSchema.safeParse(rawContext);
      if(!parsedContext.success||parsedContext.data.audience!==this.resource||parsedContext.data.expiresAt<=Date.now())throw new DomainError('AUTH_REQUIRED','A valid resource-bound authenticated context is required.');
      const identity=parsedContext.data.identity;
      if((['subject','tenantId','connectionId','domain'] as const).some(key=>identity[key]!==this.binding[key]))throw new DomainError('PERMISSION_DENIED','Provider router belongs to a different connection.');
      connection=identity.connectionId;meta.connection_hash=digest(connection).slice(0,16);
      if(!Object.hasOwn(inputSchemas,name))throw new DomainError('UNSUPPORTED_CAPABILITY','This operation is not enabled in the read-only provider router.');
      const tool=name as ReadToolName;requireScope(identity,scopeForTool[tool]);
      this.limiter.check(JSON.stringify([identity.tenantId,identity.subject,identity.connectionId,tool]));
      if(!inputSchemas[tool].safeParse(input).success)throw new DomainError('INVALID_ARGUMENT','Arguments do not match the tool schema.');
      const budget=(size:number,max:number)=>{if(size>max)throw new DomainError('INVALID_ARGUMENT',`This provider workflow accepts at most ${max} results/checks per page.`);};
      const chars=(value:string,max:number)=>{if(Array.from(value.trim()).length>max)throw new DomainError('INVALID_ARGUMENT',`This provider workflow accepts at most ${max} query characters.`);};
      const window=(range:{start:string;end:string})=>{if(Date.parse(range.end)-Date.parse(range.start)>31*86400000)throw new DomainError('INVALID_ARGUMENT','This provider workflow accepts a window of at most 31 days.');};
      let data:object;
      switch(tool){
        case 'get_profile':data=await this.services.reads.profile(identity);break;
        case 'search':{const args=inputSchemas.search.parse(input);if(args.owner||args.time_range||args.chat_id)throw new DomainError('UNSUPPORTED_CAPABILITY','Unified provider search does not yet support owner/time/chat filters. Use the targeted message search when applicable.');budget(args.page_size,20);chars(args.query,30);const {owner:_owner,time_range:_range,chat_id:_chat,...supported}=args;data=await this.services.workflows.search(identity,supported);break;}
        case 'fetch':data=await this.services.workflows.fetch(identity,inputSchemas.fetch.parse(input));break;
        case 'search_people':{const args=inputSchemas.search_people.parse(input);if(args.cursor)throw new DomainError('UNSUPPORTED_CAPABILITY','People search requires refining the query instead of cursor pagination.');budget(args.page_size,30);chars(args.query,50);data=await this.services.reads.people(identity,{query:args.query,page_size:args.page_size});break;}
        case 'list_chats':{const args=inputSchemas.list_chats.parse(input);data=await this.services.reads.chats(identity,args.query,{page_size:args.page_size,cursor:args.cursor});break;}
        case 'search_messages':{const args=inputSchemas.search_messages.parse(input);data=await this.services.reads.searchMessages(identity,{query:args.query,chat_id:args.chat_id,sender_open_id:args.sender_open_id,start:args.time_range?.start,end:args.time_range?.end},{page_size:args.page_size,cursor:args.cursor});break;}
        case 'get_message_thread':{const args=inputSchemas.get_message_thread.parse(input);data=await this.services.workflows.messageThread(identity,args.message_id,{page_size:args.page_size,cursor:args.cursor});break;}
        case 'list_doc_comments':{const args=inputSchemas.list_doc_comments.parse(input);data=await this.services.workflows.comments(identity,args.doc_id,{page_size:args.page_size,cursor:args.cursor});break;}
        case 'list_bases':{const args=inputSchemas.list_bases.parse(input);budget(args.page_size,20);if(args.query)chars(args.query,30);data=await this.services.bases.search(identity,args.query,{page_size:args.page_size,cursor:args.cursor});break;}
        case 'get_base_schema':{const args=inputSchemas.get_base_schema.parse(input);budget(args.page_size,20);data=await this.services.bases.inspect(identity,{base_id:args.base_id,base_ref:args.base_ref,table_id:args.table_id},{page_size:args.page_size,cursor:args.cursor});break;}
        case 'query_base_records':{const {page_size,cursor,...query}=inputSchemas.query_base_records.parse(input);data=await this.services.domains.queryBase(identity,query,{page_size,cursor});break;}
        case 'get_agenda':{const args=inputSchemas.get_agenda.parse(input);budget(args.page_size,20);window(args.time_range);data=await this.services.workflows.agenda(identity,args);break;}
        case 'get_free_busy':{const args=inputSchemas.get_free_busy.parse(input);window(args.time_range);data=await this.services.domains.freeBusy(identity,args);break;}
        case 'suggest_meeting_times':data=await this.services.workflows.suggestMeetingTimes(identity,inputSchemas.suggest_meeting_times.parse(input));break;
        case 'list_meeting_rooms':{const args=inputSchemas.list_meeting_rooms.parse(input);if(args.time_range){window(args.time_range);const size=typeof input==='object'&&input!==null&&Object.hasOwn(input,'page_size')?args.page_size:5;budget(size,10);data=await this.services.domains.roomsWithAvailability(identity,{...args,time_range:args.time_range,page_size:size});}else data=await this.services.domains.roomMetadata(identity,{query:args.query,min_capacity:args.min_capacity},{page_size:args.page_size,cursor:args.cursor});break;}
        case 'list_tasks':{const {page_size,cursor,...query}=inputSchemas.list_tasks.parse(input);if(query.assignee_id&&!query.tasklist_id)budget(page_size,20);data=await this.services.tasks.list(identity,query,{page_size,cursor});break;}
        case 'get_task':data=await this.services.tasks.detail(identity,inputSchemas.get_task.parse(input).task_id);break;
      }
      const value=data as Record<string,unknown>;
      if(value.source!=='feishu_api')throw new DomainError('UPSTREAM_ERROR','Provider result has invalid provenance.');
      const {next_cursor,...payload}=value;
      if(next_cursor!==undefined&&next_cursor!==null&&(typeof next_cursor!=='string'||!next_cursor||next_cursor.length>4096))throw new DomainError('UPSTREAM_ERROR','Provider result has invalid continuation.');
      if((value.partial!==undefined&&typeof value.partial!=='boolean')||(value.complete!==undefined&&typeof value.complete!=='boolean'))throw new DomainError('UPSTREAM_ERROR','Provider result has invalid completeness metadata.');
      const result=providerOutputSchema.parse({ok:true,data:{...payload,content_trust:'untrusted_source_data'},meta:{...meta,next_cursor:next_cursor??null,partial:value.partial===true||value.complete===false}});
      if(Buffer.byteLength(JSON.stringify(result))>256*1024)throw new DomainError('UNSUPPORTED_CAPABILITY','Provider response exceeds the safe output budget. Narrow the request.');
      this.log(auditEvent(requestId,tool,connection,'ok',Date.now()-started));return result;
    }catch(raw){
      const error=raw instanceof DomainError?raw:new DomainError('UPSTREAM_ERROR','The provider workflow could not be completed.');
      this.log(auditEvent(requestId,Object.hasOwn(inputSchemas,name)?name:'unknown_tool',connection,'error',Date.now()-started,error.type));
      return providerOutputSchema.parse({ok:false,error:{type:error.type,message:error.message,...(error.requiredScope?{required_scope:error.requiredScope}:{})},meta});
    }
  }
  private log(event:Parameters<AuditSink>[0]):void{try{this.audit(event);}catch{/* Metadata-only audit failures cannot leak content or interrupt reads. */}}
}
