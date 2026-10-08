import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest,DomainError } from './core.js';
import { taskWriteReceipt,taskBinding,type TaskWritePrincipal,type TaskWriteReceipt } from '../../schemas/src/task-write.js';
const state=z.enum(['preview','approved','cancelled','executing','succeeded','partial','failed','uncertain']);
const rowSchema=z.object({id:z.string().uuid(),binding_hash:z.string(),request_hash:z.string(),status:state,receipt:z.unknown().nullable(),expires_ms:z.number().finite(),fresh:z.boolean()});
export type TaskWriteIntent=z.infer<typeof rowSchema>;
const select='*,floor(extract(epoch FROM expires_at)*1000)::double precision AS expires_ms,expires_at>now() AS fresh';
/** At-most-once reservation for create_task. The persisted UUID also supplies client_token,
 * but provider dedupe expires after five minutes; no executing/uncertain reservation is released. */
export class PostgresTaskWriteStore {
 constructor(private readonly db:Pick<Pool,'query'>){}
 private async query(sql:string,values:unknown[]):Promise<unknown[]>{try{return(await this.db.query(sql,values)).rows;}catch{throw new DomainError('UPSTREAM_ERROR','Task action storage is unavailable.');}}
 private row(rows:unknown[]):TaskWriteIntent{const parsed=rows.length===1?rowSchema.safeParse(rows[0]):null;if(!parsed?.success)throw new DomainError('NOT_FOUND','Task action is unavailable for this authorization.');return parsed.data;}
 async prepare(principal:TaskWritePrincipal,requestHash:string,key:string):Promise<TaskWriteIntent>{
  z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(key);z.string().regex(/^[a-f0-9]{64}$/).parse(requestHash);
  const binding=taskBinding(principal),who=principal.identity,keyHash=digest(key);
  await this.query(`INSERT INTO task_write_intents(id,connection_id,subject,tenant_id,binding_hash,key_hash,request_hash,status,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,'preview',now()+interval '10 minutes') ON CONFLICT(connection_id,key_hash) DO NOTHING RETURNING id`,[randomUUID(),who.connectionId,who.subject,who.tenantId,binding,keyHash,requestHash]);
  const current=this.row(await this.query(`SELECT ${select} FROM task_write_intents WHERE connection_id=$1 AND subject=$2 AND tenant_id=$3 AND key_hash=$4`,[who.connectionId,who.subject,who.tenantId,keyHash]));
  if(current.binding_hash!==binding||current.request_hash!==requestHash)throw new DomainError('CONFLICT','This idempotency key belongs to another task or authorization.');return current;
 }
 async get(principal:TaskWritePrincipal,id:string):Promise<TaskWriteIntent>{z.string().uuid().parse(id);const who=principal.identity;return this.row(await this.query(`SELECT ${select} FROM task_write_intents WHERE id=$1 AND connection_id=$2 AND subject=$3 AND tenant_id=$4 AND binding_hash=$5`,[id,who.connectionId,who.subject,who.tenantId,taskBinding(principal)]));}
 async confirm(principal:TaskWritePrincipal,id:string,decision:'approve'|'cancel'):Promise<TaskWriteIntent>{
  const status=decision==='approve'?'approved':'cancelled';await this.query("UPDATE task_write_intents SET status=$1,updated_at=now() WHERE id=$2 AND binding_hash=$3 AND expires_at>now() AND status=ANY($4::text[]) RETURNING id",[status,id,taskBinding(principal),decision==='approve'?['preview']:['preview','approved']]);
  const current=await this.get(principal,id);if(current.status!==status||(decision==='approve'&&!current.fresh))throw new DomainError('CONFLICT','Task preview expired, was cancelled or has already advanced.');return current;
 }
 async claim(principal:TaskWritePrincipal,id:string):Promise<boolean>{return(await this.query("UPDATE task_write_intents SET status='executing',updated_at=now() WHERE id=$1 AND binding_hash=$2 AND status='approved' AND expires_at>now() RETURNING id",[id,taskBinding(principal)])).length===1;}
 async finish(principal:TaskWritePrincipal,id:string,receipt:TaskWriteReceipt):Promise<TaskWriteIntent>{
  taskWriteReceipt.parse(receipt);if(receipt.intent_id!==id||!['succeeded','partial','failed','uncertain'].includes(receipt.status))throw new DomainError('INVALID_ARGUMENT','A terminal task receipt for this intent is required.');
  await this.query("UPDATE task_write_intents SET status=$1,receipt=$2::jsonb,updated_at=now() WHERE id=$3 AND binding_hash=$4 AND status='executing' RETURNING id",[receipt.status,JSON.stringify(receipt),id,taskBinding(principal)]);return this.get(principal,id);
 }
}
