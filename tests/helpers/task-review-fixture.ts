import { readFile } from 'node:fs/promises';
import { randomBytes,generateKeyPairSync,sign } from 'node:crypto';
import { request as httpRequest,type Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { PostgresConnectionRepository } from '../../packages/auth/src/connection-repository.js';
import { PostgresTokenStore,TokenCipher } from '../../packages/auth/src/vault.js';
import { PostgresTaskWriteAccess } from '../../packages/auth/src/task-write-access.js';
import { PostgresTaskWriteStore } from '../../packages/policy/src/task-write-store.js';
import { WriteConfirmationAuthority } from '../../packages/policy/src/write-confirmation.js';
import { CreateTaskWorkflow } from '../../packages/tools/src/create-task-workflow.js';
import { TaskCreateProvider } from '../../packages/feishu/src/task-create-provider.js';
import { createSafeSdkClient } from '../../packages/feishu/src/sdk-client.js';
import { createTaskReviewServer } from '../../apps/mcp-server/src/task-review-server.js';
import { demoIdentity } from '../../packages/feishu/src/fixtures.js';
import { digest } from '../../packages/policy/src/core.js';
export const reviewOrigin='https://review.example.test',resource='https://mcp.example.test/mcp',bearer='D'.repeat(43);
export const input={summary:'Synthetic unassigned task',description:'Full synthetic task description.',due:{kind:'timed' as const,at:'2026-10-10T17:00:00+08:00'}};
export const identity={...demoIdentity(),scopes:['task.write']};
export const tokenData={accessToken:'synthetic-task-user-token',refreshToken:'synthetic-task-refresh',expiresAt:Date.now()+3600000,refreshExpiresAt:Date.now()+7200000};
export const created={code:0,data:{task:{guid:'11111111-1111-4111-8111-111111111111',summary:input.summary,description:input.description,due:{timestamp:String(Date.parse(input.due.at)),is_all_day:false},members:[],tasklists:[],completed_at:'0',url:'https://applink.feishu.cn/client/todo/detail?guid=11111111-1111-4111-8111-111111111111'}}};
export async function localRequest(base:string,path:string,payload?:unknown,headers:Record<string,string|null>={},method='POST'){
 const defaults:Record<string,string>={Host:'review.example.test',Origin:reviewOrigin,...(payload===undefined?{}:{'Content-Type':'application/json'})};
 for(const [k,v]of Object.entries(headers)){if(v===null)delete defaults[k];else defaults[k]=v;}
 return new Promise<{status:number;headers:Headers;text:string;json:any}>((resolve,reject)=>{const req=httpRequest(base+path,{method,headers:defaults},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(Buffer.from(c)));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let json;try{json=JSON.parse(text);}catch{}const h=new Headers();for(const [k,v]of Object.entries(res.headers))if(v!==undefined)h.set(k,Array.isArray(v)?v.join(','):v);resolve({status:res.statusCode!,headers:h,text,json});});});req.on('error',reject);req.end(payload===undefined?undefined:JSON.stringify(payload));});
}
export async function createTaskReviewFixture(transport:(config:any)=>Promise<any>,options:{enabled?:boolean;allowCreate?:boolean}={enabled:true,allowCreate:true}){
 const db=await PGlite.create();for(const f of ['001_connections.sql','002_oauth_link_attempts.sql','003_resource_access.sql','004_mcp_issuer.sql','005_document_write_intents.sql','006_document_review_sessions.sql','007_task_write_intents.sql','008_task_review_sessions.sql'])await db.exec(await readFile(new URL('../../infra/migrations/'+f,import.meta.url),'utf8'));
 const query=async(sql:string,values?:unknown[])=>{const r=await db.query(sql,values);return{...r,rowCount:r.affectedRows??r.rows.length};};
 const cipher=new TokenCipher(new Map([['fixture',randomBytes(32)]]),'fixture'),tokens=new PostgresTokenStore({query} as never,cipher);
 const connections=new PostgresConnectionRepository({connect:async()=>({query,release:()=>{}})} as never,cipher);
 const access=new PostgresTaskWriteAccess({query} as never,tokens,resource),store=new PostgresTaskWriteStore({query} as never),authority=new WriteConfirmationAuthority(randomBytes(32));
 const provider=new TaskCreateProvider(createSafeSdkClient({appId:'synthetic',appSecret:'synthetic',domain:'feishu',httpInstance:{request:transport} as never}),'feishu');
 const w=new CreateTaskWorkflow(access,store,authority,()=>provider,{enabled:true});
 const host=generateKeyPairSync('ed25519');
 const server=createTaskReviewServer({origin:reviewOrigin,resource,db:{query} as never,tokens,trustedHostPublicKey:host.publicKey,confirmation:authority,providerFor:()=>provider,...options});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 async function reset(){await db.exec('TRUNCATE feishu_connections CASCADE');await connections.link(identity,{openId:'ou_synthetic',tenantId:identity.tenantId,grantedProviderScopes:['task:task:writeonly']},tokenData);await query('INSERT INTO oauth_grants(id,subject,connection_id,scopes,resource,client_id) VALUES($1,$2,$3,$4,$5,$6)',['g_fixture',identity.subject,identity.connectionId,['task.write'],resource,'synthetic_host']);await query("INSERT INTO mcp_access_tokens(token_hash,grant_id,grant_generation,expires_at) VALUES($1,'g_fixture',1,now()+interval '1 hour')",[digest(bearer)]);}
 function proof(preview:any,patch:Record<string,unknown>={}){const bytes=Buffer.from(JSON.stringify({version:1,purpose:'task_review',intent:preview.receipt.intent_id,binding:preview.confirmation_request.binding,request:preview.confirmation_request.request,origin:reviewOrigin,nonce:randomBytes(32).toString('base64url'),issued:Date.now(),expires:Date.now()+60000,...patch}));return bytes.toString('base64url')+'.'+sign(null,bytes,host.privateKey).toString('base64url');}
 async function open(preview?:any,raw=input,headers:Record<string,string|null>={}){const p=preview??await w.preview(bearer,raw,randomBytes(16).toString('hex'));const r=await localRequest(base,'/task-review',{version:1,intent_id:p.receipt.intent_id,input:raw},{Authorization:'Bearer '+bearer,'x-task-review-handoff':proof(p),...headers});const data=r.text.match(/<script id="review-data" type="application\/json">(.*?)<\/script>/s)?.[1];const parsed=data?JSON.parse(data):undefined;return{...r,preview:p,data:parsed,cookie:r.headers.get('set-cookie')?.split(';')[0],fields:parsed?{version:1,intent_id:parsed.intent_id,request_hash:parsed.request_hash,csrf:parsed.csrf}:undefined};}
 async function act(opened:any,path:string,extras:object={},headers:Record<string,string|null>={}){return localRequest(base,'/task-review/'+path,{...opened.fields,...extras},{Cookie:opened.cookie,...headers});}
 await reset();return{db,query,connections,tokens,access,store,w,authority,host,server,base,reset,proof,open,act,close:async()=>{await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();});await db.close();}};
}
