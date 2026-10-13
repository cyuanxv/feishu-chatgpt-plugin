import {z} from 'zod';
import {assert,AppError,aad,random,boundedText,hash,Vault,type Env,type Principal} from './security.ts';
import {ReadFailure} from './read-failure.ts';
import type {Fetcher} from './feishu.ts';
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const FILE_SCHEMAS:Record<string,z.ZodType>={
 download_file:z.object({token:id,name:z.string().min(1).max(255),file_type:z.enum(['file','docx','doc','sheet','bitable','slides']).default('file')}).strict(),
 download_message_attachment:z.object({message_id:id,file_key:id,resource_type:z.enum(['file','image']),name:z.string().min(1).max(255)}).strict(),
 download_folder:z.object({folder_token:id}).strict(),
 download_continue:z.object({job_id:id}).strict(),
 download_status:z.object({job_id:id}).strict(),
 download_retry:z.object({job_id:id}).strict(),
};
export const FILE_REQUIREMENTS:Record<string,string[]>={download_file:['drive:file:download','drive:drive:readonly','drive:drive'],download_folder:['drive:drive:readonly','drive:drive','space:document:retrieve'],download_message_attachment:['im:message:readonly','im:message'],download_continue:[],download_status:[],download_retry:[]};
export const FILE_LIMIT=10*1024*1024, JOB_LIMIT=50*1024*1024, CHUNK=128*1024;
const enc=new TextEncoder();
export const safeName=(s:string)=>s.replace(/[\\/\x00-\x1f\x7f:]/g,'_').replace(/^\.+/,'_').slice(0,180)||'file';
const entryName=(name:string,token:string,type:string)=>{const n=safeName(name),dot=n.lastIndexOf('.');return type==='file'&&dot>0?n.slice(0,dot)+'__'+token+n.slice(dot):n+'__'+token};
const b64=(b:Uint8Array)=>{let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode(...b.subarray(i,i+8192));return btoa(s)};
const un64=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
export type FileEntry={token:string;type:string;path:string;message_id?:string;resource_type?:string;page?:string;depth?:number;ticket?:string;polls?:number;status?:string;error?:string;bytes?:number;sha256?:string;chunks?:number;artifact_id?:string;seen_pages?:string[]};
type Job={id:string;connection:string;grant:string;expires:number;queue:FileEntry[];results:FileEntry[];visited:string[];bytes:number;status:string;lease?:string;revision:number};
export class CloudFiles {
 constructor(private env:Env,private vault:Vault,private transport:Fetcher,private now=Date.now){}
 async json(token:string,path:string,body?:unknown){
  let r:Response;try{r=await this.transport('https://open.feishu.cn/open-apis'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(20000)})}catch{throw new ReadFailure('provider_network_error',503)}
  const text=await boundedText(r,2000000);let d:any;try{d=JSON.parse(text)}catch{throw new ReadFailure('provider_invalid_response',502)}
  if(!r.ok||d.code!==0){const denied=[403,401].includes(r.status)||[99991672,99991679,1061003,1061004,234004,234009].includes(d.code);throw new ReadFailure(denied?'resource_access_denied':'provider_operation_rejected',denied?403:502,d.code);}
  assert(d.data&&typeof d.data==='object','provider_invalid_response',502);return d.data;
 }
 async load(p:Principal,id:string){
  const r=await this.env.DB.prepare('SELECT payload,revision,lease_until FROM file_jobs WHERE site=? AND owner=? AND job_id=? AND expires>?').bind(p.site,p.user,id,this.now()).first<{payload:string;revision:number;lease_until:number}>();assert(r,'download_not_found_or_expired',404);
  const j=await this.vault.open<Job>(r.payload,aad(p,'file-job',id),1000000);j.revision=r.revision;return {j,leaseUntil:r.lease_until};
 }
 private async save(p:Principal,j:Job,lease:string){
  const payload=await this.vault.seal(j,aad(p,'file-job',j.id));
  const r=await this.env.DB.prepare('UPDATE file_jobs SET payload=?,revision=revision+1,lease=NULL,lease_until=0 WHERE site=? AND owner=? AND job_id=? AND lease=? RETURNING job_id').bind(payload,p.site,p.user,j.id,lease).first();assert(r,'download_lease_lost',409);
 }
 describe(p:Principal,j:Job){return {job_id:j.id,status:j.status,connection_id:j.connection,expires_at:new Date(j.expires).toISOString(),bytes:j.bytes,pending:j.queue.length,partial:j.status!=='succeeded',traversal_complete:j.queue.length===0,limits:{file_bytes:FILE_LIMIT,total_bytes:JOB_LIMIT,max_entries:200,max_depth:10},archive_url:j.queue.length?null:p.site+'/api/downloads/'+j.id+'/archive',results:j.results.map(e=>({...e,download_url:e.status==='succeeded'?p.site+'/api/downloads/'+j.id+'/files/'+e.artifact_id:null})),content_trust:'untrusted_source_data'};}
 async start(p:Principal,connection:string,grant:string,op:string,a:Record<string,any>){
  // Delete only expired private download artifacts, never Feishu originals.
  assert(this.env.BUCKET,'file_storage_unavailable',503);
  const expired=await this.env.DB.prepare('SELECT payload FROM file_chunks WHERE site=? AND owner=? AND expires<=? LIMIT 100').bind(p.site,p.user,this.now()).all<{payload:string}>();
  for(const entry of expired.results){await this.env.BUCKET.delete(entry.payload);await this.env.DB.prepare('DELETE FROM file_chunks WHERE site=? AND owner=? AND payload=? AND expires<=?').bind(p.site,p.user,entry.payload,this.now()).run()}
  await this.env.DB.prepare('DELETE FROM file_jobs WHERE site=? AND owner=? AND expires<=?').bind(p.site,p.user,this.now()).run();
  const c=await this.env.DB.prepare('SELECT COUNT(*) AS n FROM file_jobs WHERE site=? AND owner=?').bind(p.site,p.user).first<{n:number}>();assert((c?.n??0)<10,'download_job_quota',422);
  const entry:FileEntry=op==='download_folder'?{token:a.folder_token,type:'folder',path:'',depth:0}:op==='download_message_attachment'?{token:a.file_key,type:'message',message_id:a.message_id,resource_type:a.resource_type,path:safeName(a.name)}:{token:a.token,type:a.file_type,path:safeName(a.name)};
  const j:Job={id:random(),connection,grant,expires:this.now()+86400000,queue:[entry],results:[],visited:[],bytes:0,status:'pending',revision:0};
  await this.env.DB.prepare('INSERT INTO file_jobs(site,owner,job_id,payload,expires,revision,lease_until) VALUES(?,?,?,?,?,0,0)').bind(p.site,p.user,j.id,await this.vault.seal(j,aad(p,'file-job',j.id)),j.expires).run();return j;
 }
 private async binary(p:Principal,j:Job,e:FileEntry,token:string,path:string,current:()=>Promise<unknown>){
  let r:Response;try{r=await this.transport('https://open.feishu.cn/open-apis'+path,{headers:{Authorization:'Bearer '+token},redirect:'manual',signal:AbortSignal.timeout(45000)})}catch{throw new AppError('download_network_error',503)}
  if(!r.ok){let d:any;try{d=JSON.parse(await boundedText(r,32768))}catch{};const code=d?.code;throw new AppError(code===234004?'bot_not_in_chat':code===234043?'message_resource_type_unsupported':code===234009?'bot_resource_scope_missing':r.status===403?'resource_access_denied':'download_rejected',403)}
  // API errors are JSON; ordinary JSON files remain valid when the provider supplies an attachment filename.
  if(/json/i.test(r.headers.get('content-type')??'')&&!r.headers.has('content-disposition')){await r.body?.cancel();throw new AppError('download_returned_api_error',502)}
  const declared=r.headers.get('content-length');if(declared!==null)assert(Number.isSafeInteger(Number(declared))&&Number(declared)<=FILE_LIMIT,'file_size_limit_10mb',422);
  const reader=r.body?.getReader();assert(reader,'empty_download',502);let total=0;const pieces:Uint8Array[]=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;assert(total<=FILE_LIMIT,'file_size_limit_10mb',422);assert(j.bytes+total<=JOB_LIMIT,'job_size_limit_50mb',422);pieces.push(value)}}finally{await reader.cancel().catch(()=>{})}
  assert(declared===null||total===Number(declared),'file_size_mismatch',502);
  const bytes=new Uint8Array(total);let offset=0;for(const b of pieces){bytes.set(b,offset);offset+=b.length}
  const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  const file=random();let seq=0;await current();
  assert(this.env.BUCKET,'file_storage_unavailable',503);
  for(let i=0;i<bytes.length;i+=CHUNK){const sealed=await this.vault.seal({base64:b64(bytes.subarray(i,i+CHUNK))},aad(p,'file-chunk',j.id+':'+file+':'+seq));const storageKey='feishu-files/'+await hash(p.site+':'+p.user)+'/'+j.id+'/'+file+'/'+seq;await this.env.BUCKET.put(storageKey,sealed);await this.env.DB.prepare('INSERT INTO file_chunks(site,owner,job_id,file_id,seq,payload,expires) VALUES(?,?,?,?,?,?,?)').bind(p.site,p.user,j.id,file,seq++,storageKey,j.expires).run()}
  await current();e.status='succeeded';e.bytes=total;e.sha256=sha;e.chunks=seq;e.artifact_id=file;j.bytes+=total;
 }
 async step(p:Principal,id:string,connection:string,grant:string,token:string,current:()=>Promise<unknown>,botToken:()=>Promise<string>,retry=false){
  const {j}=await this.load(p,id);assert(j.connection===connection&&j.grant===grant,'download_connection_changed',403);if(!j.queue.length&&!retry)return this.describe(p,j);
  const lease=random();const r=await this.env.DB.prepare('UPDATE file_jobs SET lease=?,lease_until=? WHERE site=? AND owner=? AND job_id=? AND revision=? AND lease_until<? RETURNING job_id').bind(lease,this.now()+180000,p.site,p.user,id,j.revision,this.now()).first();assert(r,'download_busy',409);
  // A bounded step makes long jobs resumable rather than depending on a browser staying open.
  try{if(retry){const failed=j.results.filter(e=>e.status==='failed'&&e.type!=='folder');j.results=j.results.filter(e=>!failed.includes(e));for(const e of failed){delete e.error;delete e.status;e.polls=0;j.queue.push(e)}}for(let n=0;n<3&&j.queue.length;n++){
   await current();const e=j.queue.shift()!;
   try{
    if(e.type==='folder'){
     assert((e.depth??0)<=10,'folder_depth_limit',422);
     if(!e.page){assert(!j.visited.includes(e.token),'folder_cycle_or_duplicate',422);j.visited.push(e.token)}
     const d=await this.json(token,'/drive/v1/files?folder_token='+encodeURIComponent(e.token)+'&page_size=50'+(e.page?'&page_token='+encodeURIComponent(e.page):''));
     assert(Array.isArray(d.files)&&typeof d.has_more==='boolean','folder_page_incomplete',502);
     for(const f of d.files){assert(typeof f.token==='string'&&/^[A-Za-z0-9_-]+$/.test(f.token)&&typeof f.name==='string','invalid_folder_entry',502);assert(j.queue.length+j.results.length<200,'folder_entry_limit_200',422);j.queue.push({token:f.token,type:f.type,path:(e.path?e.path+'/':'')+entryName(f.name,f.token,f.type),depth:(e.depth??0)+1})}
     if(d.has_more){assert(typeof d.next_page_token==='string'&&d.next_page_token && !(e.seen_pages??[]).includes(d.next_page_token)&&d.next_page_token!==e.page,'folder_cursor_invalid',502);j.queue.push({...e,page:d.next_page_token,seen_pages:[...(e.seen_pages??[]),...(e.page?[e.page]:[])]})}
     else j.results.push({...e,status:'listed'});
    }else if(e.type==='message'){
     // Prove this owner can read the exact message before using any bot credential.
     const d=await this.json(token,'/im/v1/messages/'+encodeURIComponent(e.message_id!));
     const msg=d.items?.find((v:any)=>v.message_id===e.message_id);assert(msg&&!msg.deleted,'message_not_readable',403);
     let content:any;try{content=JSON.parse(msg.body?.content)}catch{throw new AppError('message_content_invalid',422)}
     const keys:string[]=[];const walk=(v:any)=>{if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){if(['file_key','image_key'].includes(k)&&typeof x==='string')keys.push(x);else walk(x)}};walk(content);assert(keys.includes(e.token),'file_not_in_message',403);
     await this.binary(p,j,e,await botToken(),'/im/v1/messages/'+encodeURIComponent(e.message_id!)+'/resources/'+encodeURIComponent(e.token)+'?type='+e.resource_type,current);j.results.push(e);
    }else if(e.type==='file') {await this.binary(p,j,e,token,'/drive/v1/files/'+e.token+'/download',current);j.results.push(e)}
    else if(['doc','docx','sheet','bitable','slides'].includes(e.type)){
     const ext=({doc:'docx',docx:'docx',sheet:'xlsx',bitable:'base',slides:'pptx'} as Record<string,string>)[e.type]!;
     if(!e.ticket){const d=await this.json(token,'/drive/v1/export_tasks',{token:e.token,type:e.type,file_extension:ext});assert(typeof d.ticket==='string','export_ticket_missing',502);e.ticket=d.ticket;j.queue.push(e)}
     else {const d=await this.json(token,'/drive/v1/export_tasks/'+encodeURIComponent(e.ticket)+'?token='+e.token);const v=d.result;assert(v&&typeof v.job_status==='number','export_status_missing',502);if(v.job_status===0){assert(typeof v.file_token==='string'&&/^[A-Za-z0-9_-]+$/.test(v.file_token),'export_token_missing',502);e.path+='.'+ext;await this.binary(p,j,e,token,'/drive/v1/export_tasks/file/'+v.file_token+'/download',current);j.results.push(e)}else if([1,2].includes(v.job_status)){e.polls=(e.polls??0)+1;assert(e.polls<=30,'export_poll_limit',422);j.queue.push(e);break}else throw new AppError('export_failed_'+v.job_status,422)}
    }else {throw new AppError('unsupported_resource_type_'+String(e.type).slice(0,30),422)}
   }catch(error){e.status='failed';e.error=error instanceof AppError?error.code:'download_failed';j.results.push(e)}
  }
  await current();j.status=j.queue.length?'pending':j.results.some(e=>e.status==='failed')?'partial':'succeeded';await this.save(p,j,lease);return this.describe(p,j);
  }catch(error){await this.env.DB.prepare('UPDATE file_jobs SET lease=NULL,lease_until=0 WHERE site=? AND owner=? AND job_id=? AND lease=?').bind(p.site,p.user,id,lease).run();throw error}
 }
 async *bytes(p:Principal,j:Job,e:FileEntry){for(let seq=0;seq<(e.chunks??0);seq++){const row=await this.env.DB.prepare('SELECT payload FROM file_chunks WHERE site=? AND owner=? AND job_id=? AND file_id=? AND seq=? AND expires>?').bind(p.site,p.user,j.id,e.artifact_id,seq,this.now()).first<{payload:string}>();assert(row,'download_chunk_missing',410);const object=await this.env.BUCKET?.get(row.payload);assert(object,'download_chunk_missing',410);const v=await this.vault.open<{base64:string}>(await object.text(),aad(p,'file-chunk',j.id+':'+e.artifact_id+':'+seq),300000);yield un64(v.base64)}}
 async deliver(p:Principal,id:string,file:string,current:(connection:string,grant:string)=>Promise<unknown>){const {j}=await this.load(p,id);await current(j.connection,j.grant);assert(!j.queue.length||file!=='archive','download_pending',409);
  const self=this;async function* output(){if(file==='archive'){yield* zipEntries(j.results.filter(e=>e.status==='succeeded').map(e=>({name:e.path,bytes:()=>self.bytes(p,j,e)})).concat(j.results.filter(e=>e.type==='folder'&&e.status==='listed'&&e.path).map(e=>({name:e.path+'/',bytes:async function*(){}}))).concat([{name:'_download_manifest.json',bytes:async function*(){yield enc.encode(JSON.stringify(self.describe(p,j),null,2))}}]))}else{const e=j.results.find(e=>e.artifact_id===file&&e.status==='succeeded');assert(e,'file_not_found',404);yield* self.bytes(p,j,e)}}
  const it=output();const stream=new ReadableStream<Uint8Array>({async pull(controller){try{await current(j.connection,j.grant);const n=await it.next();if(n.done)controller.close();else controller.enqueue(n.value)}catch(e){controller.error(e)}},async cancel(){await it.return(undefined)}});
  const e=j.results.find(e=>e.artifact_id===file);return new Response(stream,{headers:{'Content-Type':file==='archive'?'application/zip':'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file==='archive'?'feishu-download.zip':safeName(e?.path.split('/').pop()??'download')),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }
}
// Uncompressed streaming ZIP; file bytes are read one encrypted chunk at a time.
const table=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);return c>>>0});
function header(size:number,fields:[number,number,number][]){const b=new Uint8Array(size),v=new DataView(b.buffer);for(const [at,n,width]of fields)width===2?v.setUint16(at,n,true):v.setUint32(at,n,true);return b}
export async function* zipEntries(entries:{name:string;bytes:()=>AsyncIterable<Uint8Array>}[]){let offset=0;const records:Uint8Array[]=[];for(const e of entries){const name=enc.encode(e.name),start=offset;const h=header(30,[[0,0x04034b50,4],[4,20,2],[6,0x808,2],[26,name.length,2]]);yield h;yield name;offset+=h.length+name.length;let crc=0xffffffff,size=0;for await(const b of e.bytes()){for(const byte of b)crc=(crc>>>8)^table[(crc^byte)&255]!;size+=b.length;offset+=b.length;yield b}crc=(crc^0xffffffff)>>>0;const desc=header(16,[[0,0x08074b50,4],[4,crc,4],[8,size,4],[12,size,4]]);yield desc;offset+=16;const central=header(46,[[0,0x02014b50,4],[4,20,2],[6,20,2],[8,0x808,2],[16,crc,4],[20,size,4],[24,size,4],[28,name.length,2],[42,start,4]]);records.push(central,name)}const start=offset;for(const b of records){yield b;offset+=b.length}yield header(22,[[0,0x06054b50,4],[8,entries.length,2],[10,entries.length,2],[12,offset-start,4],[16,start,4]])}
