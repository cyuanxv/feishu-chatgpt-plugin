import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { generateKeyPairSync,randomBytes } from 'node:crypto';
// Explicit clean environment: never inherit/read configured credentials during a build smoke check.
for(const [file,gate,label] of [['main-provider','FEISHU_PROVIDER_RUNTIME','Provider'],['main-issuer','FEISHU_AUTH_RUNTIME','Issuer'],['main-document-review','FEISHU_DOCUMENT_REVIEW_RUNTIME','Document review'],['main-task-review','FEISHU_TASK_REVIEW_RUNTIME','Task review']]){
  const result=spawnSync(process.execPath,[resolve(`dist/apps/mcp-server/src/${file}.js`)],{env:{[gate]:'disabled'},encoding:'utf8',timeout:10000});
  if(result.error||result.status!==78||!result.stderr.includes(`${label} runtime disabled.`))throw new Error('Production entrypoint did not refuse unconfigured startup.');
}
console.log('Compiled resource, issuer, document review and task review entrypoints import successfully and refuse unconfigured startup. No credentials or live service were used.');

// A synthetic private host key must be rejected before any database/provider configuration.
const syntheticHost=generateKeyPairSync('ed25519');
const privateConfig=spawnSync(process.execPath,[resolve('dist/apps/mcp-server/src/main-document-review.js')],{env:{FEISHU_DOCUMENT_REVIEW_RUNTIME:'review',DOCUMENT_REVIEW_CONFIRMATION_KEY_BASE64:randomBytes(32).toString('base64'),DOCUMENT_REVIEW_HOST_PUBLIC_KEY_PEM:syntheticHost.privateKey.export({format:'pem',type:'pkcs8'}).toString()},encoding:'utf8',timeout:10000});
if(privateConfig.error||privateConfig.status===0||!privateConfig.stderr.includes('Only a public SPKI host key is accepted.'))throw new Error('Document review runtime did not reject a private host signing key.');
console.log('Compiled document review runtime rejects private host signing keys before database/provider initialization.');

const privateTaskConfig=spawnSync(process.execPath,[resolve('dist/apps/mcp-server/src/main-task-review.js')],{env:{FEISHU_TASK_REVIEW_RUNTIME:'review',TASK_REVIEW_CONFIRMATION_KEY_BASE64:randomBytes(32).toString('base64'),TASK_REVIEW_HOST_PUBLIC_KEY_PEM:syntheticHost.privateKey.export({format:'pem',type:'pkcs8'}).toString()},encoding:'utf8',timeout:10000});
if(privateTaskConfig.error||privateTaskConfig.status===0||!privateTaskConfig.stderr.includes('Only a public SPKI host key is accepted.'))throw new Error('Task review runtime did not reject a private host signing key.');
console.log('Compiled task review runtime rejects private host signing keys before database/provider initialization.');
