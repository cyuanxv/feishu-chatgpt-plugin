import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
// Explicit clean environment: never inherit/read configured credentials during a build smoke check.
for(const [file,gate,label] of [['main-provider','FEISHU_PROVIDER_RUNTIME','Provider'],['main-issuer','FEISHU_AUTH_RUNTIME','Issuer']]){
  const result=spawnSync(process.execPath,[resolve(`dist/apps/mcp-server/src/${file}.js`)],{env:{[gate]:'disabled'},encoding:'utf8',timeout:10000});
  if(result.error||result.status!==78||!result.stderr.includes(`${label} runtime disabled.`))throw new Error('Production entrypoint did not refuse unconfigured startup.');
}
console.log('Compiled resource and issuer entrypoints import successfully and refuse unconfigured startup. No credentials or live service were used.');
