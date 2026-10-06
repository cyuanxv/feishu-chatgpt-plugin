import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Client } from '@larksuiteoapi/node-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PostgresResourceAccess, GrantedAgendaTokens } from '../../../packages/auth/src/resource-access.js';
import type { TokenStore } from '../../../packages/auth/src/vault.js';
import { FeishuSdkReadGateway, bindSdkReads } from '../../../packages/feishu/src/sdk-reads.js';
import { FeishuProviderReads } from '../../../packages/feishu/src/provider-reads.js';
import { FeishuProviderDomains } from '../../../packages/feishu/src/provider-domains.js';
import { FeishuProviderAgenda } from '../../../packages/feishu/src/provider-agenda.js';
import { FeishuInstanceAgenda } from '../../../packages/feishu/src/provider-instance-agenda.js';
import { FeishuProviderWorkflows } from '../../../packages/feishu/src/provider-workflows.js';
import { FeishuProviderBases } from '../../../packages/feishu/src/provider-bases.js';
import { FeishuProviderTasks } from '../../../packages/feishu/src/provider-tasks.js';
import { ProviderReadRouter } from '../../../packages/tools/src/provider-router.js';
import { inputSchemas, providerOutputSchema } from '../../../packages/schemas/src/catalog.js';
import { DomainError, Handles, RateLimiter, type Identity } from '../../../packages/policy/src/core.js';
import type { AuditSink } from '../../../packages/observability/src/audit.js';

function json(res:ServerResponse,status:number,body:unknown){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));}
class HttpError extends Error{constructor(readonly status:number){super('Invalid request.');}}
async function body(req:IncomingMessage):Promise<unknown>{
  if(Number(req.headers['content-length']??0)>65536){req.resume();throw new HttpError(413);}
  return new Promise((resolve,reject)=>{let size=0;let rejected=false;const chunks:Buffer[]=[];req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>65536){if(!rejected)reject(new HttpError(413));rejected=true;chunks.length=0;}else if(!rejected)chunks.push(chunk);});req.on('end',()=>{if(!rejected){try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new HttpError(400));}}});req.on('error',()=>reject(new HttpError(400)));req.on('aborted',()=>reject(new HttpError(400)));});
}
function endpoint(value:string):URL{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.href!==value)throw new Error('Canonical HTTPS configuration is required.');return url;}
export interface AgendaServerOptions {
  resource:string; authorizationServer:string; access:PostgresResourceAccess; tokens:Pick<TokenStore,'snapshot'>;
  handles:Handles; client:(identity:Identity)=>Client; audit?:AuditSink;
}

/** One-tool OAuth resource-server candidate. No login, grant creation, token issuance or mock routes.
 * This factory does not listen or load configuration/credentials; callers explicitly own those steps. */
export function createAgendaServer(options:AgendaServerOptions){
  const resource=endpoint(options.resource);endpoint(options.authorizationServer);
  if(resource.pathname!=='/mcp')throw new Error('This candidate requires the exact /mcp resource path.');
  const metadata=new URL('/.well-known/oauth-protected-resource/mcp',resource).href;
  const httpLimiter=new RateLimiter(120,60000);const toolLimiter=new RateLimiter(60,60000);
  const challenge=(res:ServerResponse,error?:string)=>{res.setHeader('WWW-Authenticate',`Bearer resource_metadata="${metadata}"${error?`, error="${error}"`:''}`);};
  const server=createServer((req,res)=>{void handle(req,res).catch(error=>{
    if(res.destroyed)return;
    if(res.headersSent){res.end();return;}
    if(error instanceof HttpError){json(res,error.status,{error:'invalid_request'});return;}
    if(error instanceof DomainError){
      if(error.type==='AUTH_REQUIRED'){challenge(res,'invalid_token');json(res,401,{error:'invalid_token'});return;}
      if(error.type==='INSUFFICIENT_SCOPE'){challenge(res,'insufficient_scope');json(res,403,{error:'insufficient_scope'});return;}
      if(error.type==='PERMISSION_DENIED'){json(res,403,{error:'permission_denied'});return;}
      if(error.type==='RATE_LIMITED'){json(res,429,{error:'rate_limited'});return;}
    }
    json(res,503,{error:'service_unavailable'});
  });});
  server.requestTimeout=15000;server.headersTimeout=10000;
  async function handle(req:IncomingMessage,res:ServerResponse){
    if(req.headers.host!==resource.host||(req.headers.origin&&req.headers.origin!==resource.origin)){json(res,403,{error:'untrusted_origin'});return;}
    const url=new URL(req.url??'/',resource.origin);
    if(url.origin!==resource.origin||url.search)throw new HttpError(400);
    if(req.method==='GET'&&url.pathname==='/health'){json(res,200,{status:'ok',mode:'provider_agenda_candidate',live_verified:false,tools:['get_agenda']});return;}
    if(req.method==='GET'&&['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)){json(res,200,{resource:options.resource,authorization_servers:[options.authorizationServer],scopes_supported:['calendar.read'],bearer_methods_supported:['header']});return;}
    if(url.pathname!=='/mcp'){json(res,404,{error:'not_found'});return;}
    if(req.method!=='POST'){res.setHeader('Allow','POST');json(res,405,{error:'method_not_allowed'});return;}
    res.setTimeout(30000,()=>res.destroy());
    httpLimiter.check(req.socket.remoteAddress??'unknown');
    if(req.rawHeaders.filter((_v,index)=>index%2===0&&req.rawHeaders[index]!.toLowerCase()==='authorization').length!==1){challenge(res);json(res,401,{error:'authorization_required'});return;}
    const matched=/^Bearer +([A-Za-z0-9_-]{43,512})$/i.exec(req.headers.authorization??'');
    if(!matched){challenge(res,'invalid_token');json(res,401,{error:'invalid_token'});return;}
    const bearer=matched[1]!;const grant=await options.access.authenticate(bearer,options.resource);
    if(res.destroyed)return;
    if(req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()!=='application/json')throw new HttpError(415);
    const parsed=await body(req);
    const tokens=new GrantedAgendaTokens(options.access,options.tokens,bearer,grant);
    const connectedTokens={get:async(identity:Identity)=>{if(res.destroyed)throw new DomainError('UPSTREAM_ERROR','Request ended.');const value=await tokens.get(identity);if(res.destroyed)throw new DomainError('UPSTREAM_ERROR','Request ended.');return value;}};
    const gateway=new FeishuSdkReadGateway({identity:grant.identity,reads:bindSdkReads(options.client(grant.identity))},connectedTokens);
    const domains=new FeishuProviderDomains(gateway,options.handles);const instances=new FeishuInstanceAgenda(gateway,options.handles);
    const agenda=new FeishuProviderAgenda({calendars:domains.calendars.bind(domains),agenda:instances.agenda.bind(instances)},options.handles);
    const reads=new FeishuProviderReads(gateway,options.handles);const workflows=new FeishuProviderWorkflows(reads,domains,gateway,options.handles,agenda);
    const router=new ProviderReadRouter(options.resource,grant.identity,{reads,domains,workflows,bases:new FeishuProviderBases(gateway,domains,options.handles),tasks:new FeishuProviderTasks(gateway,options.handles)},options.audit,toolLimiter);
    const mcp=new McpServer({name:'feishu-agenda-resource-candidate',version:'0.1.0-dev.10'});
    mcp.registerTool('get_agenda',{description:'Read authorized calendar event instances in an explicit time window. Development integration candidate; live verification is incomplete.',inputSchema:inputSchemas.get_agenda,outputSchema:providerOutputSchema,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true},_meta:{securitySchemes:[{type:'oauth2',scopes:['calendar.read']}]}},async args=>{
      const result=await router.call('get_agenda',args,{identity:grant.identity,audience:grant.resource,expiresAt:grant.expiresAt});
      return{content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result,isError:!result.ok,...(result.error?.type==='AUTH_REQUIRED'?{_meta:{'mcp/www_authenticate':[`Bearer resource_metadata="${metadata}", error="invalid_token"`]}}:{})};
    });
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.once('close',()=>{void transport.close();void mcp.close();});
    await mcp.connect(transport);await transport.handleRequest(req,res,parsed);
  }
  return server;
}
