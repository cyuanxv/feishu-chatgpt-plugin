import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
// Explicit clean environment: never inherit/read configured credentials during a build smoke check.
const result=spawnSync(process.execPath,[resolve('dist/apps/mcp-server/src/main-provider.js')],{env:{FEISHU_PROVIDER_RUNTIME:'disabled'},encoding:'utf8',timeout:10000});
if(result.error||result.status!==78||!result.stderr.includes('Provider runtime disabled.'))throw new Error('Production entrypoint did not refuse unconfigured startup.');
console.log('Compiled resource entrypoint imports successfully and refuses unconfigured startup. No credentials or live service were used.');
