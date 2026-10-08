import { describe, expect, it, vi } from 'vitest';
import { DocumentCreateProvider } from '../packages/feishu/src/document-create-provider.js';
import { createSafeSdkClient } from '../packages/feishu/src/sdk-client.js';

const input={title:'Fixture',markdown:'Only synthetic text'};
const success={code:0,data:{document:{document_id:'doc_fixture',revision_id:1,url:'https://tenant.feishu.cn/docx/doc_fixture'},warnings:[]}};
function setup(response:unknown=success,domain:'feishu'|'lark'='feishu'){
  const request=vi.fn().mockResolvedValue(response);const client=createSafeSdkClient({appId:'synthetic',appSecret:'synthetic',domain,httpInstance:{request} as never});
  return {request,provider:new DocumentCreateProvider(client,domain)};
}
describe('bounded official-CLI document create wire contract',()=>{
  it.each([
    null,{}, {code:'0',data:success.data},{code:1,data:success.data},{code:0,data:null},{code:0,data:[]},
    {code:0,data:{}},{code:0,data:{document:{document_id:'doc_fixture'}}},
    {code:0,data:{document:{document_id:'../other',revision_id:1}}},
    {code:0,data:{document:{document_id:'doc_fixture',revision_id:-1}}},
    {code:0,data:{...success.data,warnings:'not-an-array'}},
    {code:0,data:{...success.data,result:'unexpected'}},
    {code:0,data:{...success.data,task:{task_id:'task_fixture',type:'create_document',status:'processing'}}},
    {code:0,data:{result:'failed',task:{task_id:'task_fixture',type:'create_document',status:'succeeded',result:{create_document:JSON.stringify(success.data)}}}},
  ])('never claims success from malformed or conflicting data %s',async response=>{
    const s=setup(response);expect((await s.provider.create(input,'synthetic')).status).toBe('uncertain');expect(s.request).toHaveBeenCalledTimes(1);
  });
  it('handles code=0 plus explicit failed business result without claiming no side effects',async()=>{
    const s=setup({code:0,data:{result:'failed',warnings:['untrusted warning']}});expect((await s.provider.create(input,'synthetic')).status).toBe('failed');expect(s.request).toHaveBeenCalledTimes(1);
  });
  it.each(['failed','expired'])('keeps terminal async %s distinct from confirmed creation',async status=>{
    const s=setup({code:0,data:{task:{task_id:'task_fixture',type:'create_document',status,failure:{code:'unknown',message:'raw diagnostic'}}}});
    expect(await s.provider.create(input,'synthetic')).toMatchObject({status:'failed',taskId:'task_fixture',documentId:null});expect(JSON.stringify(await s.provider.poll('task_fixture','synthetic'))).not.toContain('raw diagnostic');
  });
  it.each([
    {task_id:'task_fixture',type:'other',status:'processing'},
    {task_id:'task_fixture',type:'create_document',status:'queued'},
    {task_id:'task_fixture',type:'create_document',status:'succeeded',result:{create_document:{document:success.data.document}}},
    {task_id:'task_fixture',type:'create_document',status:'succeeded',result:{create_document:'{}'}},
    {task_id:'task_fixture',type:'create_document',status:'succeeded',result:{create_document:'not-json'}},
    {task_id:'../evil',type:'create_document',status:'processing'},
    {task_id:'task_fixture',type:'create_document',status:'succeeded',result:{create_document:JSON.stringify(success.data)},failure:{code:'execution_interrupted'}},
    {task_id:'task_fixture',type:'create_document',status:'processing',failure:{code:'failure'}},
    {task_id:'task_fixture',type:'create_document',status:'failed',result:{create_document:JSON.stringify(success.data)}},
  ])('retains uncertainty for unsupported async contracts %s',async task=>{
    const s=setup({code:0,data:{task}});expect((await s.provider.create(input,'synthetic')).status).toBe('uncertain');
  });
  it('checks business failure inside the JSON-encoded async result too',async()=>{
    const s=setup({code:0,data:{task:{task_id:'task_fixture',type:'create_document',status:'succeeded',result:{create_document:'{"result":"failed"}'}}}});
    expect((await s.provider.poll('task_fixture','synthetic')).status).toBe('failed');
  });
  it('retains valid outer warnings on async success rather than reporting pristine success',async()=>{
    const s=setup({code:0,data:{warnings:['outer warning'],task:{task_id:'task_fixture',type:'create_document',status:'succeeded',result:{create_document:JSON.stringify(success.data)}}}});
    expect(await s.provider.create(input,'synthetic')).toMatchObject({status:'partial',warningCount:1,documentId:'doc_fixture'});
  });
  it('rejects malformed outer warnings while retaining the known task ID',async()=>{
    const s=setup({code:0,data:{warnings:'malformed',task:{task_id:'task_fixture',type:'create_document',status:'succeeded',result:{create_document:JSON.stringify(success.data)}}}});
    expect(await s.provider.create(input,'synthetic')).toMatchObject({status:'uncertain',taskId:'task_fixture',documentId:null});
  });
  it('rejects a polled task substitution without adopting its task ID',async()=>{
    const s=setup({code:0,data:{task:{task_id:'other_task',type:'create_document',status:'succeeded',result:{create_document:JSON.stringify(success.data)}}}});
    expect(await s.provider.poll('task_fixture','synthetic')).toMatchObject({status:'uncertain',taskId:'task_fixture',documentId:null});
  });
  it.each(['javascript:alert(1)','http://tenant.feishu.cn/docx/doc_fixture','https://feishu.cn.evil.test/docx/doc_fixture','https://user:pass@tenant.feishu.cn/docx/doc_fixture','https://tenant.feishu.cn/docx/another','https://tenant.feishu.cn/docx/doc_fixture?token=value','https://tenant.feishu.cn/docx/doc_fixture#x','https://tenant.feishu.cn:8443/docx/doc_fixture'])('omits unsafe/unbound document URL %s',async url=>{
    const s=setup({code:0,data:{document:{...success.data.document,url}}});expect(await s.provider.create(input,'synthetic')).toMatchObject({status:'succeeded',url:null});
  });
  it('uses only the fixed matching Lark API origin and does not trust a Feishu-domain receipt URL for Lark',async()=>{
    const s=setup(success,'lark');expect((await s.provider.create(input,'synthetic')).url).toBeNull();expect(s.request.mock.calls[0]![0].url).toBe('https://open.larksuite.com/open-apis/docs_ai/v1/documents');
  });
  it.each(['','bad token','bad\r\nheader'])('refuses invalid user-token input without falling back to app identity %s',async token=>{
    const s=setup();await expect(s.provider.create(input,token)).rejects.toMatchObject({type:'AUTH_REQUIRED'});await expect(s.provider.poll('task_fixture',token)).rejects.toThrow();expect(s.request).not.toHaveBeenCalled();
  });
  it('bounds successful-response parsing and does not echo oversized/raw error data',async()=>{
    const s=setup({code:0,data:{...success.data,tips:'x'.repeat(262145)}});expect((await s.provider.create(input,'synthetic')).status).toBe('uncertain');
  });
});
