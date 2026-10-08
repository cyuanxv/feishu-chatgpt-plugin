import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
const { Miniflare } = createRequire(import.meta.url)(
  "../runtime-check/node_modules/miniflare",
);
const output = await build({
  stdin: {
    contents: `
import './src/runtime.ts';
import {DocxCandidate,DocxCandidateProvider} from './src/docx-candidate.ts';
import {Vault,random} from './src/security.ts';
export default {async fetch(){
 const calls=[];
 const p={site:'https://synthetic.example.test',user:'synthetic-owner'};
 const api=new DocxCandidateProvider(async(url,init)=>{
  calls.push({url,method:init.method,redirect:init.redirect});
  if(url.endsWith('/search/v2/doc_wiki/search'))return Response.json({code:0,data:{res_units:[{entity_type:'DOC',result_meta:{token:'doc1',doc_types:'DOCX'},title_highlighted:'Synthetic'}],has_more:false}});
  return Response.json({code:0,data:{content:'甲😀乙'}});
 });
 const service=new DocxCandidate(api,async()=>({grant:'synthetic-grant',scopes:['search:docs:read','docx:document:readonly'],token:'synthetic-token'}),new Vault(random()));
 const found=await service.search(p,{query:'synthetic'});
 const result_id=found.results[0].result_id;
 const first=await service.fetch(p,{result_id,max_chars:2});
 const second=await service.fetch(p,{result_id,max_chars:2,cursor:first.next_cursor});
 let isolated=false;
 try{await service.fetch({...p,user:'other-owner'},{result_id});}catch{isolated=true;}
 return Response.json({first,second,calls,isolated});
}};`,
    resolveDir: process.cwd(),
    sourcefile: "docx-workerd-fixture.ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
const mf = new Miniflare({
  modules: true,
  script: output.outputFiles[0].text,
  compatibilityDate: "2026-07-30",
  cf: false,
  outboundService: () => {
    throw Error("Unexpected live outbound request");
  },
});
try {
  const result = await (
    await mf.dispatchFetch("https://synthetic.example.test/")
  ).json();
  assert.equal(result.first.content, "甲😀");
  assert.equal(result.first.truncated, true);
  assert.equal(result.second.content, "乙");
  assert.equal(result.second.next_cursor, null);
  assert.equal(result.isolated, true);
  assert.equal(result.calls.length, 3);
  assert(
    result.calls.every(
      (c) =>
        c.redirect === "manual" &&
        c.url.startsWith("https://open.feishu.cn/open-apis/"),
    ),
  );
  console.log(
    JSON.stringify({
      runtime: "official Miniflare/workerd",
      candidate_only: true,
      passed: 7,
      real_provider_requests: 0,
      production_registration_changed: false,
    }),
  );
} finally {
  await mf.dispose();
}
