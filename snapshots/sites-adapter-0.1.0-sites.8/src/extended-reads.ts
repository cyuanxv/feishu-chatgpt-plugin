import {z} from 'zod';
import {assert} from './security.ts';

const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const calendarId=z.string().regex(/^[A-Za-z0-9_.@+-]{1,256}$/);
const page=z.number().int().min(1).max(20).default(10);
const instant=z.iso.datetime({offset:true}).refine(v=>Date.parse(v)%1000===0,'Whole-second timestamp required');
export const timeRange=z.object({start:instant,end:instant}).strict().refine(v=>Date.parse(v.end)>Date.parse(v.start)&&Date.parse(v.end)-Date.parse(v.start)<=31*86400000,'Ordered range up to 31 days required');
const timezone=z.string().max(80).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}});
const fileType=z.enum(['docx','doc','sheet','bitable','file','slides']);
export const EXTENDED_REQUIREMENTS:Record<string,string[]>={
 profile:[],people:['contact:user:search'],chats:['im:chat:read'],messages:['search:message'],message:['im:message:readonly'],thread_messages:['im:message:readonly'],
 doc_comments:['docs:document.comment:read'],comment_replies:['docs:document.comment:read'],
 freebusy:['calendar:calendar.free_busy:read'],room_availability:['calendar:calendar.free_busy:read'],rooms:['calendar:calendar.free_busy:read'],
 event:['calendar:calendar.event:read'],event_attendees:['calendar:calendar.event:read'],
};
export const EXTENDED_SCHEMAS:Record<string,z.ZodType>={
 profile:z.object({}).strict(),
 people:z.object({query:z.string().trim().min(1).max(50),page_size:page}).strict(),
 chats:z.object({query:z.string().trim().min(1).max(100).optional(),page_size:page}).strict(),
 messages:z.object({query:z.string().trim().min(1).max(1000),chat_id:id.optional(),sender_open_id:id.optional(),time_range:timeRange.optional(),page_size:page}).strict(),
 message:z.object({message_id:id}).strict(),thread_messages:z.object({thread_id:id,page_size:page}).strict(),
 doc_comments:z.object({token:id,file_type:fileType.default('docx'),page_size:page}).strict(),
 comment_replies:z.object({token:id,comment_id:id,file_type:fileType.default('docx'),page_size:page}).strict(),
 freebusy:z.object({user_id:id,time_range:timeRange}).strict(),room_availability:z.object({room_id:id,time_range:timeRange}).strict(),
 rooms:z.object({time_range:timeRange,timezone,city:z.string().max(100).optional(),building:z.string().max(100).optional(),floor:z.string().max(100).optional(),room_name:z.string().max(100).optional(),min_capacity:z.number().int().min(1).max(1000).optional()}).strict(),
 event:z.object({calendar_id:calendarId,event_id:id}).strict(),event_attendees:z.object({calendar_id:calendarId,event_id:id,page_size:z.number().int().min(10).max(20).default(20)}).strict(),
};
export type ReadRequest={path:string;body?:unknown;query:URLSearchParams;pageKey?:string;refinementOnly?:boolean;listKey?:string};
export function extendedRequest(op:string,a:Record<string,any>,next:unknown):ReadRequest{
 const q=new URLSearchParams();const paging=()=>{q.set('page_size',String(a.page_size));if(next!==undefined)q.set('page_token',String(next));};
 const out:ReadRequest={path:'',query:q};
 if(op==='profile')out.path='/authen/v1/user_info';
 else if(op==='people'){out.path='/contact/v3/users/search';q.set('page_size',String(a.page_size));out.body={query:a.query};out.refinementOnly=true;out.listKey='items';}
 else if(op==='chats'){out.path='/im/v1/chats'+(a.query?'/search':'');paging();q.set('user_id_type','open_id');if(a.query)q.set('query',a.query);out.pageKey='items';}
 else if(op==='messages'){out.path='/im/v1/messages/search';paging();q.set('user_id_type','open_id');out.pageKey='items';out.body={query:a.query,filter:{...(a.chat_id?{chat_ids:[a.chat_id]}:{}),...(a.sender_open_id?{from_ids:[a.sender_open_id]}:{}),...(a.time_range?{time_range:{start_time:String(Date.parse(a.time_range.start)/1000),end_time:String(Date.parse(a.time_range.end)/1000)}}:{})}};}
 else if(op==='message'){out.path=`/im/v1/messages/${a.message_id}`;q.set('user_id_type','open_id');out.listKey='items';}
 else if(op==='thread_messages'){out.path='/im/v1/messages';paging();q.set('container_id_type','thread');q.set('container_id',a.thread_id);q.set('sort_type','ByCreateTimeAsc');out.pageKey='items';}
 else if(op==='doc_comments'||op==='comment_replies'){out.path=`/drive/v1/files/${a.token}/comments`+(op==='comment_replies'?`/${a.comment_id}/replies`:'');paging();q.set('file_type',a.file_type);q.set('user_id_type','open_id');out.pageKey='items';}
 else if(op==='freebusy'||op==='room_availability'){out.path='/calendar/v4/freebusy/list';q.set('user_id_type','open_id');out.body={time_min:a.time_range.start,time_max:a.time_range.end,...(op==='freebusy'?{user_id:a.user_id}:{room_id:a.room_id}),only_busy:true,include_external_calendar:true};out.listKey='freebusy_list';}
 else if(op==='rooms'){out.path='/calendar/v4/freebusy/room_find';out.body={event_start_time:a.time_range.start,event_end_time:a.time_range.end,timezone:a.timezone,...Object.fromEntries(['city','building','floor','room_name','min_capacity'].filter(k=>a[k]!==undefined).map(k=>[k,a[k]]))};out.listKey='available_rooms';}
 else if(op==='event'||op==='event_attendees'){out.path=`/calendar/v4/calendars/${encodeURIComponent(a.calendar_id)}/events/${a.event_id}`;q.set('user_id_type','open_id');if(op==='event_attendees'){out.path+='/attendees';paging();out.pageKey='items';}}
 else throw Error('Unknown fixed read operation');
 return out;
}
export function validateExtended(op:string,a:Record<string,any>,data:any){
 if(op==='profile')assert(typeof data.name==='string'&&typeof data.open_id==='string'&&typeof data.tenant_key==='string','provider_response_invalid',502);
 if(op==='people')assert(data.items.every((v:any)=>id.safeParse(v?.id).success),'provider_response_invalid',502);
 if(op==='chats')assert(data.items.every((v:any)=>id.safeParse(v?.chat_id).success),'provider_response_invalid',502);
 if(op==='messages')assert(data.items.every((v:any)=>id.safeParse(v?.meta_data?.message_id).success&&(!a.chat_id||v.meta_data.chat_id===a.chat_id)&&(!a.sender_open_id||v.meta_data.from_id===a.sender_open_id)),'provider_response_invalid',502);
 if(op==='freebusy'||op==='room_availability')assert(data.freebusy_list.every((v:any)=>timeRange.safeParse({start:v?.start_time,end:v?.end_time}).success),'provider_response_invalid',502);
 if(op==='rooms')assert(data.available_rooms.every((v:any)=>id.safeParse(v?.room_id).success),'provider_response_invalid',502);
 if(op==='event')assert(data.event?.event_id===a.event_id,'provider_response_invalid',502);
}

export const SUGGEST_TOOL={name:'suggest_meeting_times',description:'Find candidate time slots from complete primary-calendar busy information for explicitly selected people. Requires an explicit offset-aware time range; no booking occurs. Ask the user to choose a candidate before booking.',inputSchema:{type:'object',properties:{connection_id:{type:'string',maxLength:80},people:{type:'array',items:{type:'string',pattern:'^ou_[A-Za-z0-9_-]+$'},minItems:1,maxItems:20},time_range:z.toJSONSchema(timeRange),duration_minutes:{type:'integer',minimum:5,maximum:480},step_minutes:{type:'integer',minimum:5,maximum:120}},required:['people','time_range'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}};
