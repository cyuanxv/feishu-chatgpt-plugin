import { z } from 'zod';
import { digest, DomainError, Handles, requireScope, type Identity } from '../../policy/src/core.js';
import { FeishuProviderDomains } from './provider-domains.js';

const providerId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.@+-]+$/);
const timezone = z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat('en', {timeZone:value}); return true; } catch { return false; } });
const range = z.object({ start:z.iso.datetime({offset:true}), end:z.iso.datetime({offset:true}) }).strict().refine(value => Date.parse(value.end)>Date.parse(value.start) && Date.parse(value.end)-Date.parse(value.start)<=31*86400000);
const inputSchema = z.object({ time_range:range, timezone, page_size:z.number().int().min(1).max(20).default(20), cursor:z.string().min(1).max(4096).optional() }).strict();
const stateSchema = z.object({ operation:z.literal('agenda_across_calendars'), fingerprint:z.string(), calendars:z.array(providerId).max(5), directory_cursor:z.string().nullable(), event_cursor:z.string().nullable(), started:z.boolean(), seen:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20), unavailable:z.array(providerId).max(20) });
type State = z.infer<typeof stateSchema>;

/** Explicit traversal of visible calendars. Calendar/provider order, not a fabricated global chronology. */
export class FeishuProviderAgenda {
  constructor(private readonly domains:Pick<FeishuProviderDomains,'calendars'|'agenda'>,private readonly handles:Handles) {}
  async list(identity:Identity,input:z.input<typeof inputSchema>) {
    requireScope(identity,'calendar.read');
    const parsed=inputSchema.parse(input);
    const fingerprint=digest(JSON.stringify({time_range:parsed.time_range,timezone:parsed.timezone,page_size:parsed.page_size,scopes:[...identity.scopes].sort()}));
    let state:State={operation:'agenda_across_calendars',fingerprint,calendars:[],directory_cursor:null,event_cursor:null,started:false,seen:[],unavailable:[]};
    if(parsed.cursor){const cursor=stateSchema.safeParse(this.handles.decode('cursor',identity,parsed.cursor));if(!cursor.success||cursor.data.fingerprint!==fingerprint)throw new DomainError('INVALID_ARGUMENT','Agenda cursor does not match this window, timezone or permissions.');state=cursor.data;}
    let directoryReads=0;let eventReads=0;
    const errors:{calendar_id:string;error_type:string}[]=[];
    let events:(Awaited<ReturnType<FeishuProviderDomains['agenda']>>['events'][number]&{calendar_id:string})[]=[];
    while(eventReads<5){
      if(!state.calendars.length){
        if(state.started&&!state.directory_cursor)break;
        if(directoryReads>=1)break;
        const directory=await this.domains.calendars(identity,{page_size:5,cursor:state.directory_cursor??undefined});directoryReads++;
        for(const calendar of directory.calendars){const hash=digest(calendar.calendar_id);if(state.seen.includes(hash))throw new DomainError('UPSTREAM_ERROR','Provider repeated a calendar during agenda traversal.');if(state.seen.length>=20)throw new DomainError('UNSUPPORTED_CAPABILITY','Agenda traversal exceeds the supported twenty-calendar budget.');state.seen.push(hash);state.calendars.push(calendar.calendar_id);}
        state.started=true;state.directory_cursor=directory.next_cursor;
        if(!state.calendars.length)break;
      }
      const calendarId=state.calendars[0]!;eventReads++;
      try{
        const page=await this.domains.agenda(identity,{calendar_id:calendarId,time_range:parsed.time_range,timezone:parsed.timezone},{page_size:parsed.page_size,cursor:state.event_cursor??undefined});
        events=page.events.map(event=>({...event,calendar_id:calendarId}));state.event_cursor=page.next_cursor;
        if(!page.next_cursor)state.calendars.shift();
        // Do not skip an empty nonterminal event page; its continuation remains explicit.
        if(events.length||page.next_cursor)break;
      }catch(error){
        // Only a known per-calendar visibility failure can be skipped. Malformed data, cursor cycles,
        // transient/provider errors and authorization failures stop instead of fabricating completeness.
        if(!(error instanceof DomainError)||!['PERMISSION_DENIED','NOT_FOUND'].includes(error.type))throw error;
        state.unavailable.push(calendarId);errors.push({calendar_id:calendarId,error_type:error.type});state.calendars.shift();state.event_cursor=null;
      }
    }
    const more=state.calendars.length>0||state.directory_cursor!==null||!state.started;
    const next=more?this.handles.encode('cursor',identity,state):null;
    if(next&&next.length>4096)throw new DomainError('UNSUPPORTED_CAPABILITY','Agenda continuation exceeds the supported reference size.');
    return{events,next_cursor:next,partial:more||state.unavailable.length>0,unavailable_calendar_ids:state.unavailable,errors,traversal_complete:!more,ordering:'calendar_then_provider_order' as const,time_encoding:'provider_timestamp_or_all_day_date' as const,timezone:parsed.timezone,source:'feishu_api' as const,content_trust:'untrusted_source_data' as const};
  }
}
