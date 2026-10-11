// Loopback-only synthetic browser fixture. No real credentials or provider calls.
import {createServer} from 'node:http';
import {setup,P} from '../test/helpers.mjs';
import {Writes,WRITE_SCOPES,SCOPES,createWorker} from '../.test-build/module.mjs';
const s=await setup();await s.grant();s.env.FEISHU_WRITE_ENABLED='true';s.db.sql.prepare('UPDATE connections SET scopes=?').run(JSON.stringify([...SCOPES,...WRITE_SCOPES]));
const fake=async()=>Response.json({code:0,data:{task:{guid:'synthetic-task'}}});const writes=new Writes(s.env,fake,s.now);const prepared=await writes.prepare(P,'create_task',{request_id:crypto.randomUUID(),parameters:{summary:'浏览器验收用任务',description:'这是本地模拟预览。\n不访问真实飞书，也不创建真实任务。'}});const worker=createWorker({fetcher:fake,now:s.now});
const server=createServer(async(req,res)=>{try{if(req.url==='/'){res.writeHead(302,{Location:'/write-review/'+prepared.intent_id});res.end();return;}const chunks=[];for await(const chunk of req)chunks.push(chunk);const headers=new Headers(req.headers);headers.set('oai-authenticated-user-id',P.user);if(headers.has('origin'))headers.set('origin',P.site);const response=await worker.fetch(new Request(P.site+req.url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})}),s.env);const out=Object.fromEntries(response.headers);if(out['set-cookie'])out['set-cookie']=out['set-cookie'].replaceAll('__Host-feishu-write','feishu-write').replace('; Secure','');res.writeHead(response.status,out);res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500);res.end('Synthetic preview error');}});
// Preserve Worker cookie contract while adapting Secure __Host cookies to local HTTP for this fixture only.
server.prependListener('request',req=>{if(req.headers.cookie)req.headers.cookie=req.headers.cookie.replaceAll('feishu-write=','__Host-feishu-write=');});
server.listen(0,'127.0.0.1',()=>console.log('Synthetic preview: http://127.0.0.1:'+server.address().port));
