// Synthetic cloud-browser visual/interaction harness only. No real accounts or provider network.
// The HTTP bridge tests production HTML/JS and application handlers, not production TLS/cookies.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createTaskReviewFixture,created,localRequest,input } from './task-review-fixture.js';
if(process.env.FEISHU_SYNTHETIC_TASK_BROWSER!=='1')throw new Error('Synthetic browser fixture must be selected explicitly.');
const sessions=new Map<string,Awaited<ReturnType<Awaited<ReturnType<typeof createTaskReviewFixture>>['open']>>>();
let calls=0;
const fixture=await createTaskReviewFixture(async(config:any)=>{calls++;return{code:0,data:{task:{...created.data.task,summary:config.data.summary,description:config.data.description??'',due:config.data.due}}};});
const bridge=createServer((req,res)=>{void(async()=>{
 const url=new URL(req.url??'/', 'http://127.0.0.1:4179');
 if(req.method==='GET'&&url.pathname==='/fixture'){
  const opened=await fixture.open(undefined,{summary:'核对本周交付清单',description:'这是测试用的虚构任务。\n\n1. 核对方案评审结果\n2. 整理待办事项\n3. 检查最终交付文件\n\n任务不会分配负责人，也不加入清单。',due:{kind:'all_day',date:'2026-10-10'}} as never);
  const id=randomBytes(16).toString('hex');sessions.set(id,opened);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Set-Cookie':`synthetic-review=${id}; Path=/; HttpOnly; SameSite=Strict`});res.end(opened.text);return;
 }
 if(req.method==='GET'&&url.pathname==='/fixture/evidence'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({synthetic_provider_calls:calls,sessions:sessions.size}));return;}
 if(req.method==='GET'){
  const r=await localRequest(fixture.base,url.pathname,undefined,{},'GET');res.writeHead(r.status,{'Content-Type':r.headers.get('content-type')??'text/plain','Cache-Control':'no-store'});res.end(r.text);return;
 }
 const id=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('synthetic-review='))?.split('=')[1],opened=id?sessions.get(id):null;
 if(!opened){res.writeHead(401);res.end('{}');return;}
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
 const r=await localRequest(fixture.base,url.pathname,JSON.parse(Buffer.concat(chunks).toString()),{Cookie:opened.cookie!});res.writeHead(r.status,{'Content-Type':r.headers.get('content-type')??'application/json','Cache-Control':'no-store'});res.end(r.text);
 })().catch(()=>{res.writeHead(500);res.end('{}');});});
bridge.listen(4179,'127.0.0.1',()=>console.log('Synthetic UI fixture: http://127.0.0.1:4179/fixture (no real provider)'));
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{bridge.close();bridge.closeAllConnections();void fixture.close().finally(()=>process.exit(0));});
