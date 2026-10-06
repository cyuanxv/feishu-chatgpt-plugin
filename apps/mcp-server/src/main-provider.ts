import { Pool } from 'pg';
import { createAgendaServer } from './agenda-server.js';
import { PostgresResourceAccess } from '../../../packages/auth/src/resource-access.js';
import { PostgresTokenStore, TokenCipher } from '../../../packages/auth/src/vault.js';
import { createSafeSdkClient } from '../../../packages/feishu/src/sdk-client.js';
import { Handles } from '../../../packages/policy/src/core.js';

// No secret is inspected unless the operator explicitly selects this separately reviewed runtime.
if(process.env.FEISHU_PROVIDER_RUNTIME!=='agenda'){
  console.error('Provider runtime disabled. Reviewed identity issuer, account grants, HTTPS and secure configuration are required.');
  process.exit(78);
}
const required=(name:string):string=>{const value=process.env[name];if(!value)throw new Error(`Missing required provider configuration: ${name}`);return value;};
const key=(name:string):Buffer=>{const value=required(name);const bytes=Buffer.from(value,'base64');if(bytes.length!==32||bytes.toString('base64')!==value)throw new Error(`Invalid provider key configuration: ${name}`);return bytes;};
const encryptionKey=key('FEISHU_TOKEN_KEY_BASE64');const handleKey=key('FEISHU_HANDLE_KEY_BASE64');
if(encryptionKey.equals(handleKey))throw new Error('Independent token and reference keys are required.');
const appId=required('FEISHU_APP_ID');const appSecret=required('FEISHU_APP_SECRET');const domain=required('FEISHU_DOMAIN');
if(!['feishu','lark'].includes(domain))throw new Error('Invalid provider domain configuration.');
const port=Number(process.env.PORT??8080);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid provider port configuration.');
const database=(()=>{try{const url=new URL(required('DATABASE_URL'));if(!['postgres:','postgresql:'].includes(url.protocol)||url.hash)throw new Error();for(const name of url.searchParams.keys())if(name!=='sslmode')throw new Error();const mode=url.searchParams.get('sslmode');if(mode&&!['require','verify-ca','verify-full'].includes(mode))throw new Error();url.searchParams.delete('sslmode');return url.href;}catch{throw new Error('Invalid database configuration. Verified TLS is mandatory; unsupported URL options are rejected.');}})();
// Remove parsed sslmode so pg connection-string parsing cannot replace rejectUnauthorized=true.
const pool=new Pool({connectionString:database,max:5,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,query_timeout:5000,statement_timeout:5000,ssl:{rejectUnauthorized:true}});
pool.on('error',()=>console.error('Provider database connection unavailable.'));
const cipher=new TokenCipher(new Map([['provider-v1',encryptionKey]]),'provider-v1');
const server=createAgendaServer({resource:required('MCP_RESOURCE_URL'),authorizationServer:required('MCP_AUTHORIZATION_SERVER'),access:new PostgresResourceAccess(pool),tokens:new PostgresTokenStore(pool,cipher),handles:new Handles(handleKey),client:identity=>{
  if(identity.domain!==domain)throw new Error('Configured provider domain does not match the linked account.');
  // The official SDK requires app credentials at construction; every read still forces the stored
  // user access token. No bot-token acquisition or OAuth exchange is exposed by this server.
  return createSafeSdkClient({appId,appSecret,domain:identity.domain});
}});
server.listen(port,'0.0.0.0',()=>console.info('Agenda resource candidate started. Live verification remains incomplete.'));
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{server.close(()=>{void pool.end().finally(()=>process.exit(0));});server.closeAllConnections();});
