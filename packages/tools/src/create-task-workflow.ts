import { DomainError,RateLimiter } from '../../policy/src/core.js';
import { WriteConfirmationAuthority } from '../../policy/src/write-confirmation.js';
import { PostgresTaskWriteStore,type TaskWriteIntent } from '../../policy/src/task-write-store.js';
import { createTaskInput,taskRequestHash,taskWriteReceipt,taskBinding,type TaskWritePrincipal,type TaskWriteReceipt } from '../../schemas/src/task-write.js';
import type { TaskWriteAccess } from '../../auth/src/task-write-access.js';
import { TaskCreateProvider,type TaskCreateOutcome } from '../../feishu/src/task-create-provider.js';
export class CreateTaskWorkflow {
 constructor(private readonly access:TaskWriteAccess,private readonly store:PostgresTaskWriteStore,private readonly confirmation:WriteConfirmationAuthority,private readonly providerFor:(principal:TaskWritePrincipal)=>TaskCreateProvider,private readonly options:{enabled?:boolean}={},private readonly limiter=new RateLimiter(60)){}
 private enabled(){if(this.options.enabled!==true)throw new DomainError('UNSUPPORTED_CAPABILITY','Task creation remains disabled.');}
 async preview(bearer:string,raw:unknown,idempotencyKey:string){
  this.enabled();const input=createTaskInput.parse(raw),principal=await this.access.authenticate(bearer);this.limiter.check(taskBinding(principal));const intent=await this.store.prepare(principal,taskRequestHash(input),idempotencyKey);
  return{receipt:this.receipt(intent,false),requires_confirmation:intent.status==='preview'&&intent.fresh,
   review:{operation:'create_task' as const,...input,assignment:'unassigned' as const,tasklists:[] as never[],reminders:'not_configured' as const,notice:'Created unfinished under the current user identity. No assignees, followers or tasklists are added. Provider default notification behavior is unverified.'},
   confirmation_request:{intent:intent.id,binding:taskBinding(principal),request:intent.request_hash,expires:intent.expires_ms}};
 }
 async confirm(bearer:string,intentId:string,trustedHostProof:string):Promise<TaskWriteReceipt>{this.enabled();const principal=await this.access.authenticate(bearer),intent=await this.store.get(principal,intentId),claim=this.confirmation.verify(trustedHostProof,{intent:intent.id,binding:taskBinding(principal),request:intent.request_hash});return this.receipt(await this.store.confirm(principal,intentId,claim.decision),false);}
 async execute(bearer:string,intentId:string,raw:unknown):Promise<TaskWriteReceipt>{
  this.enabled();const input=createTaskInput.parse(raw),principal=await this.access.authenticate(bearer),initial=await this.store.get(principal,intentId);
  if(initial.request_hash!==taskRequestHash(input))throw new DomainError('CONFLICT','Task contents or deadline changed. Review a new preview.');
  if(initial.status==='preview')throw new DomainError('PERMISSION_DENIED','Explicit task confirmation is required.');
  if(initial.status!=='approved'||!initial.fresh)return this.receipt(initial,true);
  const provider=this.providerFor(principal);if(provider.domain!==principal.identity.domain)throw new DomainError('PERMISSION_DENIED','Task provider does not match the authorized account.');
  if(!await this.store.claim(principal,intentId))return this.receipt(await this.store.get(principal,intentId),true);
  let token:string;try{token=(await this.access.token(bearer,principal)).accessToken;}catch{return this.receipt(await this.store.finish(principal,intentId,this.base(intentId,'failed','authorization_changed',false)),false);}
  let outcome:TaskCreateOutcome;try{outcome=await provider.create(input,intentId,token);}catch{outcome={status:'uncertain',guid:null,url:null,unverified:[]};}
  const receipt=taskWriteReceipt.parse({...this.base(intentId,outcome.status,outcome.status==='succeeded'?'provider_created':outcome.status==='partial'?'provider_fields_unverified':'outcome_unknown',true),task_guid:outcome.guid,url:outcome.url,unverified_fields:outcome.unverified,response_fields_verified:outcome.status==='succeeded'});
  return this.receipt(await this.store.finish(principal,intentId,receipt),false);
 }
 async getReceipt(bearer:string,intentId:string,refresh=false):Promise<TaskWriteReceipt>{this.enabled();if(typeof refresh!=='boolean')throw new DomainError('INVALID_ARGUMENT','Receipt refresh must be a boolean.');const principal=await this.access.authenticate(bearer);return this.receipt(await this.store.get(principal,intentId),true);}
 private base(id:string,status:TaskWriteReceipt['status'],reason:TaskWriteReceipt['reason'],mayHaveCreated:boolean):TaskWriteReceipt{return{operation:'create_task',intent_id:id,status,task_guid:null,url:null,reason,unverified_fields:[],may_have_created:mayHaveCreated,automatic_create_retry_allowed:false,response_fields_verified:false,read_back_verified:false,replayed:false,live_verified:false};}
 private receipt(intent:TaskWriteIntent,replayed:boolean):TaskWriteReceipt{
  if(intent.receipt!==null)return taskWriteReceipt.parse({...taskWriteReceipt.parse(intent.receipt),replayed});
  const status=['preview','approved'].includes(intent.status)&&!intent.fresh?'expired':intent.status;
  const reasons={preview:'awaiting_confirmation',approved:'approved',cancelled:'cancelled',expired:'expired',executing:'executing',succeeded:'provider_created',partial:'provider_fields_unverified',failed:'authorization_changed',uncertain:'outcome_unknown'} as const;
  return{...this.base(intent.id,status,reasons[status],['executing','succeeded','partial','uncertain'].includes(status)),replayed};
 }
}
