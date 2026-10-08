import { parseDocumentReviewHostPublicKey } from '../../../packages/auth/src/document-review-handoff.js';
import { Pool } from 'pg';
import { createDocumentReviewServer } from './document-review-server.js';
import { PostgresTokenStore,TokenCipher,type TokenStore } from '../../../packages/auth/src/vault.js';
import { WriteConfirmationAuthority } from '../../../packages/policy/src/write-confirmation.js';
import { createSafeSdkClient } from '../../../packages/feishu/src/sdk-client.js';
import { DocumentCreateProvider } from '../../../packages/feishu/src/document-create-provider.js';
import type { DocumentWritePrincipal } from '../../../packages/schemas/src/document-write.js';

// No secret/configuration reads before the explicit runtime gate. This entrypoint does not
// issue docs.write grants or host handoffs. Those require a separately reviewed integration.
if(process.env.FEISHU_DOCUMENT_REVIEW_RUNTIME!=='review'){
  console.error('Document review runtime disabled. Trusted browser handoff, existing account grants, HTTPS and secure configuration are required.');
  process.exit(78);
}
const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`Missing document review configuration: ${name}`);return value;};
const key=(name:string)=>{const value=required(name),bytes=Buffer.from(value,'base64');if(bytes.length!==32||bytes.toString('base64')!==value)throw new Error(`Invalid document review key: ${name}`);return bytes;};
const confirmationKey=key('DOCUMENT_REVIEW_CONFIRMATION_KEY_BASE64');
const trustedHostPublicKey=parseDocumentReviewHostPublicKey(required('DOCUMENT_REVIEW_HOST_PUBLIC_KEY_PEM'));
const origin=required('DOCUMENT_REVIEW_ORIGIN'),resource=required('MCP_RESOURCE_URL');
const database=(()=>{try{const url=new URL(required('DATABASE_URL'));if(!['postgres:','postgresql:'].includes(url.protocol)||url.hash)throw new Error();for(const name of url.searchParams.keys())if(name!=='sslmode')throw new Error();const mode=url.searchParams.get('sslmode');if(mode&&!['require','verify-ca','verify-full'].includes(mode))throw new Error();url.searchParams.delete('sslmode');return url.href;}catch{throw new Error('Invalid database configuration. Verified TLS is mandatory.');}})();
const port=Number(process.env.PORT??8080);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid document review port.');
const pool=new Pool({connectionString:database,max:5,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,query_timeout:5000,statement_timeout:5000,ssl:{rejectUnauthorized:true}});
pool.on('error',()=>console.error('Document review database unavailable.'));
const allowCreate=process.env.FEISHU_DOCUMENT_WRITE_RUNTIME==='create_doc';
let tokens:Pick<TokenStore,'snapshot'>={snapshot:async()=>{throw new Error('Provider credentials are unavailable in review-only mode.');}};
let providerFor:(_:DocumentWritePrincipal)=>DocumentCreateProvider=()=>{throw new Error('Provider execution is disabled.');};
if(allowCreate){
  const encryptionKey=key('FEISHU_TOKEN_KEY_BASE64');if(encryptionKey.equals(confirmationKey))throw new Error('Independent token and confirmation keys are required.');
  const appId=required('FEISHU_APP_ID'),appSecret=required('FEISHU_APP_SECRET'),domain=required('FEISHU_DOMAIN');
  if(!['feishu','lark'].includes(domain))throw new Error('Invalid provider domain configuration.');
  tokens=new PostgresTokenStore(pool,new TokenCipher(new Map([['provider-v1',encryptionKey]]),'provider-v1'));
  providerFor=principal=>{if(principal.identity.domain!==domain)throw new Error('Provider account domain changed.');return new DocumentCreateProvider(createSafeSdkClient({appId,appSecret,domain:principal.identity.domain}),principal.identity.domain);};
}
const server=createDocumentReviewServer({origin,resource,db:pool,tokens,trustedHostPublicKey,confirmation:new WriteConfirmationAuthority(confirmationKey),providerFor,enabled:true,allowCreate});
server.listen(port,'127.0.0.1',()=>console.info('Document review candidate started. Host handoff and live creation are not verified.'));
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{server.close(()=>{void pool.end().finally(()=>process.exit(0));});server.closeAllConnections();});
