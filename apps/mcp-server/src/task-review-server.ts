import { createServer,type IncomingMessage,type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import { PostgresTaskWriteAccess } from '../../../packages/auth/src/task-write-access.js';
import { DocumentReviewHandoffVerifier } from '../../../packages/auth/src/document-review-handoff.js';
import { TaskReviewWriteAccess,PostgresTaskReviewSessions } from '../../../packages/auth/src/task-review-session.js';
import { PostgresTaskWriteStore } from '../../../packages/policy/src/task-write-store.js';
import { WriteConfirmationAuthority } from '../../../packages/policy/src/write-confirmation.js';
import { createTaskInput,taskRequestHash,taskBinding,type TaskWritePrincipal } from '../../../packages/schemas/src/task-write.js';
import { CreateTaskWorkflow } from '../../../packages/tools/src/create-task-workflow.js';
import type { TaskCreateProvider } from '../../../packages/feishu/src/task-create-provider.js';
import type { TokenStore } from '../../../packages/auth/src/vault.js';
import { DomainError,RateLimiter } from '../../../packages/policy/src/core.js';
import { renderTaskReview,renderTaskReviewUnavailable } from './task-review-view.js';

const COOKIE='__Host-feishu-task-review';
const css=readFileSync(new URL('../ui/review.css',import.meta.url),'utf8');
const script=readFileSync(new URL('../ui/review.js',import.meta.url),'utf8');
const action=z.object({version:z.literal(1),intent_id:z.string().uuid(),request_hash:z.string().regex(/^[a-f0-9]{64}$/),csrf:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
const bootstrap=z.object({version:z.literal(1),intent_id:z.string().uuid(),input:createTaskInput}).strict();
const confirm=action.extend({input:createTaskInput}).strict();
const status=action.extend({refresh:z.boolean().default(false)}).strict();
class HttpError extends Error {constructor(readonly status:number){super('Invalid review request.');}}
function singleton(req:IncomingMessage,name:string,required=false):string|undefined {
  const values:string[]=[];for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i]!.toLowerCase()===name)values.push(req.rawHeaders[i+1]!);
  if(values.length>1||(required&&values.length!==1))throw new HttpError(400);return values[0];
}
function browser(req:IncomingMessage):string {
  const cookies=singleton(req,'cookie',true)!.split(';').map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+'='));
  if(cookies.length!==1)throw new HttpError(401);const value=cookies[0]!.slice(COOKIE.length+1);if(!/^[A-Za-z0-9_-]{43}$/.test(value))throw new HttpError(401);return value;
}
async function body(req:IncomingMessage):Promise<unknown> {
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(singleton(req,'content-type',true)??'')||req.headers['content-encoding'])throw new HttpError(415);
  const length=singleton(req,'content-length');if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>131072))throw new HttpError(413);
  const chunks:Buffer[]=[];let size=0;for await(const part of req){const chunk=Buffer.from(part);size+=chunk.length;if(size>131072)throw new HttpError(413);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(400);}
}
const json=(res:ServerResponse,code:number,value:unknown)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
const html=(res:ServerResponse,code:number,value:string)=>{res.writeHead(code,{'Content-Type':'text/html; charset=utf-8'});res.end(value);};
const cookie=(value:string,seconds:number)=>`${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;

/** Standalone confirmation UI candidate. No default executable mounts it. Bootstrap requires
 * both existing MCP authorization and an independent host-signed browser handoff; a bearer-only
 * model caller cannot mint its own confirmation session. Real host delivery remains an integration gate. */
export function createTaskReviewServer(options:{
  origin:string;resource:string;db:Pick<Pool,'query'>;tokens:Pick<TokenStore,'snapshot'>;
  trustedHostPublicKey:KeyObject;confirmation:WriteConfirmationAuthority;
  providerFor:(principal:TaskWritePrincipal)=>TaskCreateProvider;
  enabled?:boolean;allowCreate?:boolean;
}) {
  const sessions=new PostgresTaskReviewSessions(options.db,options.origin);
  const handoffs=new DocumentReviewHandoffVerifier(options.trustedHostPublicKey,options.origin,Date.now,'task_review');
  const baseAccess=new PostgresTaskWriteAccess(options.db,options.tokens,options.resource);
  const store=new PostgresTaskWriteStore(options.db);const origin=new URL(options.origin);const rate=new RateLimiter(120);
  const provider=(principal:TaskWritePrincipal)=>{if(options.allowCreate!==true)throw new DomainError('UNSUPPORTED_CAPABILITY','Real task creation remains disabled.');return options.providerFor(principal);};
  const flow=(intentId:string)=>new CreateTaskWorkflow(new TaskReviewWriteAccess(options.db,options.tokens,options.resource,sessions,intentId),store,options.confirmation,provider,{enabled:true});
  async function context(req:IncomingMessage,fields:z.infer<typeof action>) {
    const secret=browser(req);const session=await sessions.get(secret,fields.csrf);
    if(session.intent_id!==fields.intent_id||session.request_hash!==fields.request_hash)throw new HttpError(409);
    const access=new TaskReviewWriteAccess(options.db,options.tokens,options.resource,sessions,fields.intent_id);
    const principal=await access.authenticate(secret);const intent=await store.get(principal,fields.intent_id);
    if(intent.request_hash!==session.request_hash)throw new HttpError(409);
    return{secret,session,principal,intent};
  }
  async function result(secret:string,fields:z.infer<typeof action>,refresh=false) {
    const current=await sessions.get(secret,fields.csrf);if(current.intent_id!==fields.intent_id||current.request_hash!==fields.request_hash)throw new HttpError(409);
    const access=new TaskReviewWriteAccess(options.db,options.tokens,options.resource,sessions,fields.intent_id);const principal=await access.authenticate(secret);
    const receipt=await flow(fields.intent_id).getReceipt(secret,fields.intent_id,refresh&&current.phase!=='review'&&options.allowCreate===true);
    const intent=await store.get(principal,fields.intent_id);const session=await sessions.get(secret,fields.csrf);
    return{ok:true,phase:session.phase,receipt,remaining_ms:Math.max(0,session.expires_ms-Date.now()),
      can_submit:options.allowCreate===true&&session.phase==='review'&&intent.status==='preview'&&intent.fresh,
      can_refresh:false};
  }
  const server=createServer({maxHeaderSize:16384},(req,res)=>{void handle(req,res).catch(error=>{
    if(res.headersSent||res.destroyed){res.end();return;}
    const code=error instanceof HttpError?error.status:error instanceof z.ZodError?400:error instanceof DomainError?({AUTH_REQUIRED:401,PERMISSION_DENIED:403,INSUFFICIENT_SCOPE:403,CONFLICT:409,NOT_FOUND:404,RATE_LIMITED:429,UNSUPPORTED_CAPABILITY:503,AMBIGUOUS_TARGET:409,INVALID_ARGUMENT:400,TOKEN_EXPIRED:401,UPSTREAM_ERROR:503}[error.type]??503):503;
    json(res,code,{ok:false,error:'review_unavailable',message:'预览、会话或授权暂不可用。请从宿主核对状态；不要重复创建。'});
  });});
  async function handle(req:IncomingMessage,res:ServerResponse):Promise<void> {
    res.setHeader('Cache-Control','no-store');res.setHeader('Pragma','no-cache');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    if(options.enabled!==true){req.resume();html(res,503,renderTaskReviewUnavailable('任务确认页面尚未启用。不会读取凭据或提交创建。'));return;}
    if(singleton(req,'host',true)!==origin.host)throw new HttpError(403);
    if((req.url?.length??0)>16384)throw new HttpError(414);const url=new URL(req.url??'/',origin);
    if(url.origin!==origin.origin||url.search||url.hash)throw new HttpError(400);
    const requestOrigin=singleton(req,'origin');if(requestOrigin!==undefined&&requestOrigin!==origin.origin)throw new HttpError(403);
    rate.check(req.socket.remoteAddress??'unknown');
    if(req.method==='GET'){
      if(url.pathname==='/task-review/assets/review.css'){res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});res.end(css);return;}
      if(url.pathname==='/task-review/assets/review.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(script);return;}
      if(url.pathname==='/task-review'||url.pathname==='/'){html(res,200,renderTaskReviewUnavailable());return;}
      throw new HttpError(404);
    }
    if(req.method!=='POST')throw new HttpError(405);
    if(requestOrigin!==origin.origin)throw new HttpError(403);
    if(!['/task-review','/task-review/confirm','/task-review/close','/task-review/status'].includes(url.pathname))throw new HttpError(404);
    if(url.pathname==='/task-review'){
      const auth=singleton(req,'authorization',true)??'';if(!/^Bearer [A-Za-z0-9_-]{43,512}$/.test(auth))throw new HttpError(401);
      const proof=singleton(req,'x-task-review-handoff',true)??'';
      const fields=bootstrap.parse(await body(req));const bearer=auth.slice(7);const principal=await baseAccess.authenticate(bearer);
      const intent=await store.get(principal,fields.intent_id);const hash=taskRequestHash(fields.input);
      if(intent.request_hash!==hash||intent.status!=='preview'||!intent.fresh)throw new HttpError(409);
      const verified=handoffs.verify(proof,{intent:fields.intent_id,binding:taskBinding(principal),request:hash});
      const pending=await sessions.open(bearer,principal,fields.intent_id,hash,verified.nonceHash);
      res.setHeader('Set-Cookie',cookie(pending.session,Math.max(1,Math.floor((pending.record.expires_ms-Date.now())/1000))));
      html(res,200,renderTaskReview(fields.input,pending.record,pending.csrf,options.allowCreate===true));return;
    }
    if(singleton(req,'authorization')!==undefined||singleton(req,'x-task-review-handoff')!==undefined)throw new HttpError(400);
    const raw=await body(req);
    if(url.pathname==='/task-review/status'){
      const fields=status.parse(raw);const ctx=await context(req,fields);json(res,200,await result(ctx.secret,fields,fields.refresh));return;
    }
    if(url.pathname==='/task-review/close'){
      const fields=action.parse(raw);const ctx=await context(req,fields);
      const cancelled=await sessions.cancel(ctx.secret,fields.csrf,ctx.principal);
      if(cancelled){res.setHeader('Set-Cookie',cookie('',0));json(res,200,{ok:true,cancelled:true,phase:'closed',intent_id:fields.intent_id});}
      else json(res,409,{ok:false,cancelled:false,error:'already_submitted',message:'此操作可能已经提交，关闭页面不会撤销。请查询回执。'});
      return;
    }
    if(options.allowCreate!==true)throw new HttpError(503);
    const fields=confirm.parse(raw);const ctx=await context(req,fields);
    if(taskRequestHash(fields.input)!==ctx.intent.request_hash)throw new HttpError(409);
    if(!await sessions.claim(ctx.secret,fields.csrf)){json(res,200,await result(ctx.secret,fields));return;}
    const proof=options.confirmation.issue({intent:fields.intent_id,binding:taskBinding(ctx.principal),request:ctx.intent.request_hash,decision:'approve',expires:Math.min(ctx.intent.expires_ms,ctx.session.expires_ms)});
    try{
      await flow(fields.intent_id).confirm(ctx.secret,fields.intent_id,proof);
      await flow(fields.intent_id).execute(ctx.secret,fields.intent_id,fields.input);
    }finally{await sessions.receipt(ctx.secret);}
    json(res,200,await result(ctx.secret,fields));
  }
  server.requestTimeout=30000;server.headersTimeout=10000;server.timeout=30000;
  return server;
}
