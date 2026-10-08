import { mkdir,copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const target=resolve('dist/apps/mcp-server/ui');await mkdir(target,{recursive:true});
for(const file of ['review.css','review.js'])await copyFile(resolve('apps/mcp-server/ui',file),resolve(target,file));
