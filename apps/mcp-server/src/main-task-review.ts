import { parseDocumentReviewHostPublicKey } from '../../../packages/auth/src/document-review-handoff.js';
import { Pool } from 'pg';
import { createTaskReviewServer } from './task-review-server.js';
import { PostgresTokenStore,TokenCipher,type TokenStore } from '../../../packages/auth/src/vault.js';
import { WriteConfirmationAuthority } from '../../../packages/policy/src/write-confirmation.js';
import { createSafeSdkClient } from '../../../packages/feishu/src/sdk-client.js';
import { TaskCreateProvider } from '../../../packages/feishu/src/task-create-provider.js';
import type { TaskWritePrincipal } from '../../../packages/schemas/src/task-write.js';

// No secret/configuration reads before the explicit runtime gate. This entrypoint does not
// issue task.write grants or host handoffs. Those require a separately reviewed integration.
if(process.env.FEISHU_TASK_REVIEW_RUNTIME!=='review'){
  console.error('Task review runtime disabled. Trusted browser handoff, existing account grants, HTTPS and secure configuration are required.');
  process.exit(78);
}
const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`Missing task review configuration: ${name}`);return value;};
const key=(name:string)=>{const value=required(name),bytes=Buffer.from(value,'base64');if(bytes.length!==32||bytes.toString('base64')!==value)throw new Error(`Invalid task review key: ${name}`);return bytes;};
const confirmationKey=key('TASK_REVIEW_CONFIRMATION_KEY_BASE64');
const trustedHostPublicKey=parseDocumentReviewHostPublicKey(required('TASK_REVIEW_HOST_PUBLIC_KEY_PEM'));
const origin=required('TASK_REVIEW_ORIGIN'),resource=required('MCP_RESOURCE_URL');
const database=(()=>{try{const url=new URL(required('DATABASE_URL'));if(!['postgres:','postgresql:'].includes(url.protocol)||url.hash)throw new Error();for(const name of url.searchParams.keys())if(name!=='sslmode')throw new Error();const mode=url.searchParams.get('sslmode');if(mode&&!['require','verify-ca','verify-full'].includes(mode))throw new Error();url.searchParams.delete('sslmode');return url.href;}catch{throw new Error('Invalid database configuration. Verified TLS is mandatory.');}})();
const port=Number(process.env.PORT??8080);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid task review port.');
const pool=new Pool({connectionString:database,max:5,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,query_timeout:5000,statement_timeout:5000,ssl:{rejectUnauthorized:true}});
pool.on('error',()=>console.error('Task review database unavailable.'));
const allowCreate=process.env.FEISHU_TASK_WRITE_RUNTIME==='create_task';
let tokens:Pick<TokenStore,'snapshot'>={snapshot:async()=>{throw new Error('Provider credentials are unavailable in review-only mode.');}};
let providerFor:(_:TaskWritePrincipal)=>TaskCreateProvider=()=>{throw new Error('Provider execution is disabled.');};
if(allowCreate){
  const encryptionKey=key('FEISHU_TOKEN_KEY_BASE64');if(encryptionKey.equals(confirmationKey))throw new Error('Independent token and confirmation keys are required.');
  const appId=required('FEISHU_APP_ID'),appSecret=required('FEISHU_APP_SECRET'),domain=required('FEISHU_DOMAIN');
  if(!['feishu','lark'].includes(domain))throw new Error('Invalid provider domain configuration.');
  tokens=new PostgresTokenStore(pool,new TokenCipher(new Map([['provider-v1',encryptionKey]]),'provider-v1'));
  providerFor=principal=>{if(principal.identity.domain!==domain)throw new Error('Provider account domain changed.');return new TaskCreateProvider(createSafeSdkClient({appId,appSecret,domain:principal.identity.domain}),principal.identity.domain);};
}
const server=createTaskReviewServer({origin,resource,db:pool,tokens,trustedHostPublicKey,confirmation:new WriteConfirmationAuthority(confirmationKey),providerFor,enabled:true,allowCreate});
server.listen(port,'127.0.0.1',()=>console.info('Task review candidate started. Host handoff and live creation are not verified.'));
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{server.close(()=>{void pool.end().finally(()=>process.exit(0));});server.closeAllConnections();});
