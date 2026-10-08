import { Pool } from 'pg';
import { z } from 'zod';
import { createAgendaIssuerServer } from './issuer-server.js';
import { PostgresAgendaIssuer } from '../../../packages/auth/src/durable-issuer.js';
import { FeishuBrowserLogin, FEISHU_LOGIN_SCOPES } from '../../../packages/auth/src/feishu-browser-login.js';
import { PostgresResourceAccess } from '../../../packages/auth/src/resource-access.js';
import { PostgresConnectionRepository } from '../../../packages/auth/src/connection-repository.js';
import { AuthorizationStateCipher, PostgresAuthorizationStateStore, FeishuOAuthExchange, bindFeishuTokenSdk } from '../../../packages/auth/src/feishu-exchange.js';
import { TokenCipher } from '../../../packages/auth/src/vault.js';
import { createSafeSdkClient } from '../../../packages/feishu/src/sdk-client.js';

if (process.env.FEISHU_AUTH_RUNTIME !== 'issuer') {
  console.error('Issuer runtime disabled. Approved OAuth clients, HTTPS, Feishu app permissions and secure configuration are required.');
  process.exit(78);
}
// No .env loading or credentials are inspected before the explicit operator gate above.
try {
  const required=(name:string):string=>{const value=process.env[name];if(!value)throw new Error();return value;};
  const key=(name:string):Buffer=>{const value=required(name);const bytes=Buffer.from(value,'base64');if(bytes.length!==32||bytes.toString('base64')!==value)throw new Error();return bytes;};
  const tokenKey=key('FEISHU_TOKEN_KEY_BASE64');const stateKey=key('FEISHU_STATE_KEY_BASE64');if(tokenKey.equals(stateKey))throw new Error();
  if(required('FEISHU_DOMAIN')!=='feishu')throw new Error();
  const issuerUrl=required('MCP_AUTHORIZATION_SERVER');const resource=required('MCP_RESOURCE_URL');const clientConfig=required('MCP_OAUTH_CLIENTS_JSON');if(clientConfig.length>8192)throw new Error();
  const clients=z.array(z.object({clientId:z.string(),name:z.string(),redirects:z.array(z.string())}).strict()).min(1).max(20).parse(JSON.parse(clientConfig));
  const port=Number(process.env.PORT??8081);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error();
  const database=new URL(required('DATABASE_URL'));if(!['postgres:','postgresql:'].includes(database.protocol)||database.hash)throw new Error();
  for(const name of database.searchParams.keys())if(name!=='sslmode')throw new Error();const mode=database.searchParams.get('sslmode');if(mode&&!['require','verify-ca','verify-full'].includes(mode))throw new Error();database.searchParams.delete('sslmode');
  const pool=new Pool({connectionString:database.href,max:5,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,query_timeout:5000,statement_timeout:5000,ssl:{rejectUnauthorized:true}});
  pool.on('error',()=>console.error('Issuer database connection unavailable.'));
  const issuer=new PostgresAgendaIssuer(pool,{issuer:issuerUrl,resource,clients});const cipher=new TokenCipher(new Map([['provider-v1',tokenKey]]),'provider-v1');
  const appId=required('FEISHU_APP_ID');const client=createSafeSdkClient({appId,appSecret:required('FEISHU_APP_SECRET'),domain:'feishu'});
  const states=new PostgresAuthorizationStateStore(pool,new AuthorizationStateCipher(stateKey));
  const exchange=new FeishuOAuthExchange(bindFeishuTokenSdk(client),states,{domain:'feishu',redirectUri:new URL('/oauth/feishu/callback',issuerUrl).href,allowedProviderScopes:FEISHU_LOGIN_SCOPES});
  const login=new FeishuBrowserLogin(pool,issuer,exchange,cipher,new PostgresConnectionRepository(pool,cipher),client,appId);
  const server=createAgendaIssuerServer({issuer,login,access:new PostgresResourceAccess(pool)});
  server.listen(port,'0.0.0.0',()=>console.info('Agenda issuer candidate started. Live verification remains incomplete.'));
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{server.close(()=>{void pool.end().finally(()=>process.exit(0));});server.closeAllConnections();});
} catch {
  console.error('Issuer configuration is invalid or unavailable. Review approved secure configuration; no sensitive values are logged.');
  process.exit(78);
}
