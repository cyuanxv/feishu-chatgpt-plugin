import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { PostgresAgendaIssuer } from '../../../packages/auth/src/durable-issuer.js';
import { FeishuBrowserLogin } from '../../../packages/auth/src/feishu-browser-login.js';
import { PostgresResourceAccess } from '../../../packages/auth/src/resource-access.js';
import { agendaOAuthProvider } from '../../../packages/auth/src/issuer-sdk.js';

interface Request extends IncomingMessage { body?: unknown }
const COOKIE='__Host-feishu-link';
const cookie=(secret:string,maxAge=600)=>`${COOKIE}=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
function browser(req:Request):string {
  const matches=(req.headers.cookie??'').split(';').map(item=>item.trim()).filter(item=>item.startsWith(COOKIE+'='));
  if(matches.length!==1)throw new Error('Browser cookie required.');
  const value=matches[0]!.slice(COOKIE.length+1);if(!/^[A-Za-z0-9_-]{43}$/.test(value))throw new Error('Browser cookie required.');return value;
}
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
function json(res:ServerResponse,status:number,body:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));}
function redirect(res:ServerResponse,url:string){res.writeHead(302,{Location:url});res.end();}
function params(url:URL,allowed:readonly string[]):URLSearchParams {
  const fields=url.searchParams;for(const key of fields.keys())if(!allowed.includes(key)||fields.getAll(key).length!==1)throw new Error('Invalid parameters.');return fields;
}
async function form(req:Request):Promise<URLSearchParams>{
  let size=0;const chunks:Buffer[]=[];for await(const chunk of req){const buffer=Buffer.from(chunk);size+=buffer.length;if(size>8192)throw new Error('Request too large.');chunks.push(buffer);}
  const data=new URLSearchParams(Buffer.concat(chunks).toString('utf8'));for(const key of data.keys())if(!['csrf','decision'].includes(key)||data.getAll(key).length!==1)throw new Error('Invalid form.');return data;
}

/** Unbound issuer HTTP candidate; neither main executable mounts it. Requires an explicit safe SDK,
 * durable stores and approved host configuration. Synthetic integration tests do not create grants
 * or transmit real credentials to any provider. */
export function createAgendaIssuerServer(options:{issuer:PostgresAgendaIssuer;login:FeishuBrowserLogin;access:PostgresResourceAccess}){
  const {issuer,login,access}=options;const origin=new URL(issuer.config.issuer);const app=createMcpExpressApp({host:'0.0.0.0',allowedHosts:[origin.hostname]});
  app.disable('x-powered-by');app.set('trust proxy',false);
  // SDK token/revoke handlers provide their own bounded parser and IP rate limiter. They do not
  // establish user identity; the browser flow below does that via Feishu user_info + explicit consent.
  const provider=agendaOAuthProvider(issuer,access,async()=>{throw new InvalidRequestError('Use the configured browser authorization route.');});
  const hits=new Map<string,{count:number;until:number}>();
  app.use((req:Request,res:ServerResponse,next:()=>void)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Pragma','no-cache');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if(req.headers.host!==origin.host){json(res,403,{error:'invalid_request'});return;}
    if((req.url?.length??0)>16384){json(res,414,{error:'invalid_request'});return;}
    const url=new URL(req.url??'/',origin);const allowed=['/authorize','/token','/revoke','/oauth/feishu/callback','/consent','/.well-known/oauth-authorization-server'];
    if(!allowed.includes(url.pathname)){json(res,404,{error:'not_found'});return;}
    if(req.headers.origin&&req.headers.origin!==origin.origin){json(res,403,{error:'invalid_request'});return;}
    if(['/token','/revoke','/consent'].includes(url.pathname)){
      if(req.method!=='POST'){json(res,405,{error:'invalid_request'});return;}
      if(url.search||!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')||req.headers.authorization||req.headers['content-encoding']){json(res,400,{error:'invalid_request'});return;}
    }else if(req.method!=='GET'){json(res,405,{error:'invalid_request'});return;}
    const now=Date.now();for(const [key,value]of hits)if(value.until<=now)hits.delete(key);
    const ip=req.socket.remoteAddress??'unknown';const bucket=hits.get(ip)??{count:0,until:now+60000};bucket.count++;hits.set(ip,bucket);
    if(bucket.count>120||hits.size>10000){json(res,429,{error:'temporarily_unavailable'});return;}
    next();
  });
  app.get('/.well-known/oauth-authorization-server',(_req:Request,res:ServerResponse)=>json(res,200,{issuer:issuer.config.issuer,authorization_endpoint:new URL('/authorize',origin).href,token_endpoint:new URL('/token',origin).href,revocation_endpoint:new URL('/revoke',origin).href,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],revocation_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:['calendar.read'],authorization_response_iss_parameter_supported:true}));
  app.get('/authorize',async(req:Request,res:ServerResponse)=>{
    let approvedRedirect:string|undefined;let clientState:string|undefined;
    try{
      const fields=params(new URL(req.url!,origin),['client_id','redirect_uri','resource','response_type','code_challenge','code_challenge_method','scope','state']);
      const clientId=fields.get('client_id')??'';const target=fields.get('redirect_uri')??'';const client=issuer.clientsStore.getClient(clientId);
      if(!client?.redirect_uris.includes(target))throw new Error('Invalid client.');approvedRedirect=target;
      const state=fields.get('state');if(state!==null&&state.length<=1024&&!/[\x00-\x1f\x7f]/.test(state))clientState=state;
      if(fields.get('response_type')!=='code'||fields.get('code_challenge_method')!=='S256')throw new Error('Invalid authorization.');
      const pending=await login.begin({clientId,redirectUri:target,resource:fields.get('resource')??'',challenge:fields.get('code_challenge')??'',scopes:(fields.get('scope')??'').split(' '),...(state!==null?{state}:{})});
      res.setHeader('Set-Cookie',cookie(pending.browserSecret));redirect(res,pending.url);
    }catch{
      if(!approvedRedirect){json(res,400,{error:'invalid_request'});return;}
      const target=new URL(approvedRedirect);target.searchParams.set('error','invalid_request');target.searchParams.set('iss',issuer.config.issuer);if(clientState!==undefined)target.searchParams.set('state',clientState);redirect(res,target.href);
    }
  });
  app.get('/oauth/feishu/callback',async(req:Request,res:ServerResponse)=>{
    try{
      const fields=params(new URL(req.url!,origin),['code','state','error','error_description']);if(fields.has('error')||!fields.get('code')||!fields.get('state'))throw new Error('Authorization not completed.');
      const result=await login.callback(browser(req),fields.get('state')!,fields.get('code')!);
      // Browsers may apply form-action to the subsequent OAuth redirect as well as /consent.
      // This value comes from the persisted request and is rechecked against the static client
      // allowlist. Keep the exact path; never allow every registered client or a generic https:.
      res.setHeader('Content-Security-Policy',`default-src 'none'; form-action 'self' ${result.clientRedirectUri}; frame-ancestors 'none'; base-uri 'none'`);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>确认日程读取授权</title><body><main><h1>允许 ${escape(result.clientName)} 读取日程？</h1><p>飞书账户：${escape(result.accountName)}</p><p>允许读取此账户可访问的日历和日程，权限为只读。</p><form method="post" action="/consent"><input type="hidden" name="csrf" value="${result.csrf}"><button name="decision" value="allow">允许读取日程</button><button name="decision" value="deny">取消</button></form></main></body></html>`);
    }catch{res.setHeader('Set-Cookie',cookie('',0));json(res,400,{error:'authorization_failed',message:'Login could not be completed. Start again.'});}
  });
  app.post('/consent',async(req:Request,res:ServerResponse)=>{
    try{
      if(req.headers.origin!==origin.origin)throw new Error('Same-origin consent required.');const fields=await form(req);const decision=fields.get('decision');if(decision!=='allow'&&decision!=='deny')throw new Error('Invalid decision.');
      const target=await login.consent(browser(req),fields.get('csrf')??'',decision==='allow');res.setHeader('Set-Cookie',cookie('',0));redirect(res,target);
    }catch{json(res,400,{error:'authorization_failed',message:'Consent could not be completed. Start again.'});}
  });
  app.use('/token',tokenHandler({provider}));app.use('/revoke',revocationHandler({provider}));
  app.use((_error:unknown,_req:Request,res:ServerResponse,_next:()=>void)=>{if(!res.headersSent)json(res,400,{error:'invalid_request'});else res.end();});
  const server=createServer(app);server.requestTimeout=30000;server.headersTimeout=10000;server.timeout=30000;return server;
}
