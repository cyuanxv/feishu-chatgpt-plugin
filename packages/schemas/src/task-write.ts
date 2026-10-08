import { z } from 'zod';
import { digest } from '../../policy/src/core.js';
import { writeBinding,type DocumentWritePrincipal } from './document-write.js';
export type TaskWritePrincipal=DocumentWritePrincipal;
export const taskBinding=(principal:TaskWritePrincipal)=>writeBinding(principal,'create_task');
export const taskDeadline=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('timed'),at:z.iso.datetime({offset:true,precision:0}).refine(value=>Date.parse(value)>0&&Number.isSafeInteger(Date.parse(value)))}).strict(),
  z.object({kind:z.literal('all_day'),date:z.iso.date().refine(value=>Date.parse(value+'T00:00:00Z')>0)}).strict(),
]);
export const createTaskInput=z.object({
  summary:z.string().trim().min(1).max(200).refine(value=>!/[\x00-\x1f\x7f]/.test(value)),
  description:z.string().max(3000).refine(value=>Buffer.byteLength(value)<=20000&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value),'Plain text within 20 KiB is required.')
    .refine(value=>!/!\s*\[|<[A-Za-z!/][^>]*>/.test(value),'Media, raw HTML/XML and rich mentions are not supported.').optional(),
  due:taskDeadline.optional(),
}).strict();
export type CreateTaskInput=z.infer<typeof createTaskInput>;
export function providerTaskDue(due:CreateTaskInput['due']):{timestamp:string;is_all_day:boolean}|undefined {
  if(!due)return undefined;
  return{timestamp:String(Date.parse(due.kind==='timed'?due.at:due.date+'T00:00:00Z')),is_all_day:due.kind==='all_day'};
}
export const taskRequestHash=(input:CreateTaskInput)=>digest(JSON.stringify({summary:input.summary,description:input.description??'',due:input.due??null}));
export const taskGuid=z.string().uuid();
export const taskWriteReceipt=z.object({
  operation:z.literal('create_task'),intent_id:z.string().uuid(),
  status:z.enum(['preview','approved','cancelled','expired','executing','succeeded','partial','failed','uncertain']),
  task_guid:taskGuid.nullable(),url:z.string().url().nullable(),
  reason:z.enum(['awaiting_confirmation','approved','cancelled','expired','executing','provider_created','provider_fields_unverified','outcome_unknown','authorization_changed']),
  unverified_fields:z.array(z.enum(['summary','description','due','members','tasklists','completed_at','url'])).max(7),
  may_have_created:z.boolean(),automatic_create_retry_allowed:z.literal(false),
  response_fields_verified:z.boolean(),read_back_verified:z.literal(false),replayed:z.boolean(),live_verified:z.literal(false),
}).strict();
export type TaskWriteReceipt=z.infer<typeof taskWriteReceipt>;
