import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {downloadEventAttachment,Apps,Vault,random} from '../.test-build/module.mjs';
import {setup,P} from './helpers.mjs';
const args={calendar_id:'cal1',event_id:'event1',token:'token1'};
async function fixture(overrides={}){
 const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();
 const calls=[];const fetcher=async(url,init)=>{calls.push({url,init});assert.equal(init.redirect,'manual');return url.includes('/events/')?Response.json({code:0,data:{event:{event_id:'event1',status:'confirmed',attachments:[{file_token:'token1',name:'test.pdf',file_size:String(bytes.length),...overrides}]}}}):new Response(bytes,{headers:{'content-type':'application/pdf'}})};
 return{bytes,calls,fetcher};
}
test('cloud download parses PDF and verifies exact bytes without returning contents to caller',async()=>{
 const f=await fixture();const r=await downloadEventAttachment(f.fetcher,'test-token',args);assert.equal(r.bytes,f.bytes.length);assert.equal(r.pages,1);assert.match(r.sha256,/^[a-f0-9]{64}$/);assert.equal(f.calls.length,2);
 const s=await setup();await s.grant();const app=new Apps(s.env,f.fetcher,s.now);
 const out=await app.query(P,{operation:'event_attachment_download',parameters:args});assert.equal(out.data.storage,'private_cloud_encrypted');assert.equal(out.data.base64,undefined);
 const saved=s.db.sql.prepare('SELECT payload FROM downloaded_attachments').get();assert(!saved.payload.includes(r.base64));assert(!saved.payload.includes('test.pdf'));
});
test('unassociated token never initiates binary download',async()=>{const f=await fixture();await assert.rejects(()=>downloadEventAttachment(f.fetcher,'t',{...args,token:'other'}),{code:'attachment_not_found'});assert.equal(f.calls.length,1)});
test('mismatched length and oversized attachments fail closed',async()=>{for(const size of [1,600000]){const f=await fixture({file_size:String(size)});await assert.rejects(()=>downloadEventAttachment(f.fetcher,'t',args));}});
test('redirect, HTML and invalid PDF cannot be reported as downloaded',async()=>{for(const response of [new Response(null,{status:302,headers:{location:'https://evil.invalid'}}),new Response('<html>',{headers:{'content-type':'text/html'}}),new Response('notpdf')]){const f=await fixture();await assert.rejects(()=>downloadEventAttachment((u,i)=>u.includes('/events/')?f.fetcher(u,i):Promise.resolve(response),'t',args));}});

test('maximum attachment envelope round-trips without relaxing state token defaults',async()=>{const v=new Vault(random());const value={base64:'x'.repeat(Math.ceil(512*1024/3)*4)};const sealed=await v.seal(value,'test');assert.deepEqual(await v.open(sealed,'test',1000000),value);await assert.rejects(()=>v.open(sealed,'test'));});
