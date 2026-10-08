import { z } from 'zod';
import { digest, DomainError, Handles, type Identity } from '../../policy/src/core.js';
import { FeishuSdkReadGateway } from './sdk-reads.js';
import type { FeishuProviderDomains } from './provider-domains.js';

const time=z.object({date:z.iso.date().optional(),timestamp:z.string().regex(/^\d+$/).optional(),timezone:z.string().optional()}).refine(value=>Boolean(value.date)!==Boolean(value.timestamp));
const eventSchema=z.object({event_id:z.string().min(1),summary:z.string().optional(),start_time:time,end_time:time,status:z.enum(['cancelled','confirmed','tentative']).optional()});
const millis=(value:z.infer<typeof time>):number=>value.date?Date.parse(value.date+'T00:00:00Z'):Number(value.timestamp)*1000;
/** Recurring-event instances for a bounded actual agenda; no guessed provider pagination. */
export class FeishuInstanceAgenda {
  constructor(private readonly gateway:FeishuSdkReadGateway,private readonly handles:Handles){}
  async agenda(identity:Identity,input:Parameters<FeishuProviderDomains['agenda']>[1],page:Parameters<FeishuProviderDomains['agenda']>[2]={}):Promise<Awaited<ReturnType<FeishuProviderDomains['agenda']>>>{
    const parsed=z.object({calendar_id:z.string().min(1).max(256).regex(/^[A-Za-z0-9_.@+-]+$/),time_range:z.object({start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true})}).strict(),timezone:z.string().refine(zone=>{try{new Intl.DateTimeFormat('en',{timeZone:zone});return true;}catch{return false;}})}).strict().parse(input);
    const pagination=z.object({page_size:z.number().int().min(1).max(20).default(20),cursor:z.string().max(4096).optional()}).strict().parse(page);
    const start=Date.parse(parsed.time_range.start),end=Date.parse(parsed.time_range.end);
    if(end<=start||end-start>31*86400000)throw new DomainError('INVALID_ARGUMENT','Agenda requires an ordered window of at most 31 days.');
    const raw=await this.gateway.call('agendaInstances',{path:{calendar_id:parsed.calendar_id},params:{start_time:String(Math.floor(start/1000)),end_time:String(Math.floor(end/1000)),user_id_type:'open_id'}},identity);
    const extra=raw as typeof raw&{has_more?:unknown;page_token?:unknown};
    if((extra.has_more!==undefined&&extra.has_more!==false)||(extra.page_token!==undefined&&extra.page_token!==''))throw new DomainError('UPSTREAM_ERROR','Unexpected provider pagination cannot be discarded.');
    if(!Array.isArray(raw.items)||raw.items.length>200)throw new DomainError('UNSUPPORTED_CAPABILITY','Agenda instance view is missing or exceeds the supported 200-item budget. Narrow the time range.');
    const visible=raw.items.filter(event=>event.status!=='cancelled');
    const checked=z.array(eventSchema).safeParse(visible);
    if(!checked.success)throw new DomainError('UPSTREAM_ERROR','Provider agenda instances were malformed.');
    const events=checked.data.map(event=>{
      const from=millis(event.start_time),to=millis(event.end_time);
      if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to<=from)throw new DomainError('UPSTREAM_ERROR','Provider agenda timing was malformed.');
      return{event_id:event.event_id,summary:event.summary??'',start:event.start_time,end:event.end_time,status:event.status??null};
    }).filter(event=>millis(event.start)<end&&millis(event.end)>start);
    if(new Set(events.map(event=>event.event_id)).size!==events.length)throw new DomainError('UPSTREAM_ERROR','Provider repeated an agenda instance.');
    const chunk=this.handles.paginate(events,identity,{operation:'agenda_instances',...parsed,page_size:pagination.page_size,version:digest(JSON.stringify(events))},pagination.page_size,pagination.cursor);
    return{events:chunk.items,timezone:parsed.timezone,time_encoding:'provider_timestamp_or_all_day_date',next_cursor:chunk.next_cursor,source:'feishu_api'};
  }
}
