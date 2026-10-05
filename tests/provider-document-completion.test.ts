import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { FeishuProviderWorkflows } from '../packages/feishu/src/provider-workflows.js';
import { FeishuProviderDomains } from '../packages/feishu/src/provider-domains.js';
import { FeishuProviderReads } from '../packages/feishu/src/provider-reads.js';
import { FeishuSdkReadGateway, bindSdkReads } from '../packages/feishu/src/sdk-reads.js';
import { createSafeSdkClient } from '../packages/feishu/src/sdk-client.js';
import { demoIdentity } from '../packages/feishu/src/fixtures.js';
import { Handles } from '../packages/policy/src/core.js';

const reply = (reply_id: string) => ({ reply_id, user_id: 'ou_fixture', content: { elements: [{ type: 'text_run', text_run: { text: 'Untrusted fixture text.' } }] } });
const meta = (doc_token = 'file1', doc_type = 'file') => ({ doc_token, doc_type, title: 'Synthetic file', owner_id: 'ou_fixture', create_time: '1', latest_modify_time: '2', url: 'https://tenant.feishu.cn/file/'+doc_token });
const requests = [{ doc_token: 'file1', doc_type: 'file' as const }];
function setup() {
  const request = vi.fn(); const get = vi.fn().mockResolvedValue({ accessToken: 'synthetic', refreshToken: 'synthetic', expiresAt: Date.now()+1e6, refreshExpiresAt: Date.now()+2e6 });
  const identity=demoIdentity(); const handles=new Handles(randomBytes(32));
  const client=createSafeSdkClient({appId:'fixture',appSecret:'fixture',domain:'feishu',httpInstance:{request} as never});
  const gateway=new FeishuSdkReadGateway({identity,reads:bindSdkReads(client)},{get});
  const reads=new FeishuProviderReads(gateway,handles); const domains=new FeishuProviderDomains(gateway,handles);
  const workflows=new FeishuProviderWorkflows(reads,domains,gateway,handles);
  async function seed() {
    request.mockResolvedValueOnce({code:0,data:{items:[{comment_id:'comment1',has_more:true,reply_list:{replies:[reply('root')]}}],has_more:false}});
    const result=await workflows.comments(identity,'doc1');return result.comments[0]!.reply_cursor!;
  }
  return {identity,handles,request,get,reads,workflows,seed};
}
describe('provider document completion',()=>{
  it('reads the complete reply sequence from a preview, with the root only on the first full page',async()=>{
    const s=setup();const seed=await s.seed();
    s.request.mockResolvedValueOnce({code:0,data:{items:[reply('root'),reply('r1')],has_more:true,page_token:'second'}}).mockResolvedValueOnce({code:0,data:{items:[reply('r2')],has_more:false}});
    const first=await s.workflows.comments(s.identity,'doc1',{cursor:seed});
    expect(first.coverage).toBe('comment_replies_page');expect(first).toMatchObject({replaces_preview:true,merge_by:'reply_id'});
    expect(first.comments[0]!.replies).toMatchObject([{reply_id:'root',is_root:true},{reply_id:'r1',is_root:false}]);
    const config=s.request.mock.calls[1]![0];expect(config).toMatchObject({method:'GET',url:'https://open.feishu.cn/open-apis/drive/v1/files/doc1/comments/comment1/replies',params:{file_type:'docx',page_size:20,user_id_type:'open_id'}});
    expect(config.headers.Authorization==='Bearer synthetic').toBe(true);
    const second=await s.workflows.comments(s.identity,'doc1',{cursor:first.next_cursor!});
    expect(second.comments[0]!.replies).toMatchObject([{reply_id:'r2',is_root:false}]);expect(second).toMatchObject({partial:true,reply_sequence_complete:true,replaces_preview:false,next_cursor:null});expect(second.comments[0]!.replies_complete).toBe(false);
  });
  it('keeps document-page continuation independent of nested reply cursors',async()=>{
    const s=setup();s.request.mockResolvedValueOnce({code:0,data:{items:[{comment_id:'c1',has_more:true}],has_more:true,page_token:'docpage'}});
    const first=await s.workflows.comments(s.identity,'doc1');expect(first.next_cursor).not.toBe(first.comments[0]!.reply_cursor);
    s.request.mockResolvedValueOnce({code:0,data:{items:[],has_more:false}});await s.workflows.comments(s.identity,'doc1',{cursor:first.next_cursor!});
    expect(s.request.mock.calls[1]![0].url.endsWith('/comments')).toBe(true);expect(s.request.mock.calls[1]![0].params.page_token).toBe('docpage');
  });
  it('rejects replay of reply cursors against another document, page size or connection',async()=>{
    const s=setup();const cursor=await s.seed();
    await expect(s.workflows.comments(s.identity,'other',{cursor})).rejects.toThrow('query');
    await expect(s.workflows.comments(s.identity,'doc1',{cursor,page_size:10})).rejects.toThrow('query');
    await expect(s.workflows.comments(demoIdentity('beta'),'doc1',{cursor})).rejects.toThrow('different');expect(s.request).toHaveBeenCalledTimes(1);
  });
  it('does not call the provider after docs scope is removed',async()=>{const s=setup();const cursor=await s.seed();await expect(s.workflows.comments({...s.identity,scopes:[]},'doc1',{cursor})).rejects.toThrow('permission');expect(s.request).toHaveBeenCalledTimes(1)});
  it.each(['comments','replies'])('rejects A-B-A cursors for %s',async kind=>{
    const s=setup();let cursor=kind==='replies'?await s.seed():undefined;
    for(const token of ['A','B','A']) s.request.mockResolvedValueOnce({code:0,data:{items:[],has_more:true,page_token:token}});
    cursor=(await s.workflows.comments(s.identity,'doc1',{cursor})).next_cursor!;
    cursor=(await s.workflows.comments(s.identity,'doc1',{cursor})).next_cursor!;
    await expect(s.workflows.comments(s.identity,'doc1',{cursor})).rejects.toThrow('repeated');
  });
  it('continues an empty nonterminal reply page rather than claiming completion',async()=>{const s=setup();const cursor=await s.seed();s.request.mockResolvedValue({code:0,data:{items:[],has_more:true,page_token:'next'}});const result=await s.workflows.comments(s.identity,'doc1',{cursor});expect(result.partial).toBe(true);expect(result.next_cursor).not.toBeNull()});
  it.each([{has_more:false},{items:[],has_more:'false'},{items:[],has_more:true},{items:[{reply_id:'x'}],has_more:false},{items:[reply('x'),reply('x')],has_more:false},{items:Array.from({length:21},(_,i)=>reply('r'+i)),has_more:false}])('rejects malformed reply-page output %s',async data=>{const s=setup();const cursor=await s.seed();s.request.mockResolvedValue({code:0,data});await expect(s.workflows.comments(s.identity,'doc1',{cursor})).rejects.toThrow()});
  it('preserves missing previews as partial but gives a first-full-page cursor',async()=>{const s=setup();s.request.mockResolvedValue({code:0,data:{items:[{comment_id:'c1',has_more:false,reply_list:{}}],has_more:false}});const result=await s.workflows.comments(s.identity,'doc1');expect(result.partial).toBe(true);expect(result.comments[0]!.reply_cursor).not.toBeNull()});
  it('uses the official batch metadata endpoint, user token and minimal output projection',async()=>{
    const s=setup();s.request.mockResolvedValue({code:0,data:{metas:[{...meta(),private_extra:'do not project'}]}});
    const result=await s.reads.metadata(s.identity,requests);expect(result.items[0]).toMatchObject({status:'ok',metadata:{title:'Synthetic file'}});
    expect(JSON.stringify(result)).not.toContain('private_extra');const config=s.request.mock.calls[0]![0];expect(config).toMatchObject({method:'POST',url:'https://open.feishu.cn/open-apis/drive/v1/metas/batch_query',data:{request_docs:requests,with_url:true},params:{user_id_type:'open_id'}});expect(config.headers.Authorization==='Bearer synthetic').toBe(true);
  });
  it('preserves partial provider failures and missing responses in request order',async()=>{const s=setup();s.request.mockResolvedValue({code:0,data:{metas:[meta()],failed_list:[{token:'file2',code:123}]}});const result=await s.reads.metadata(s.identity,[...requests,{doc_token:'file2',doc_type:'file'},{doc_token:'file3',doc_type:'file'}]);expect(result.partial).toBe(true);expect(result.items.map(item=>item.status)).toEqual(['ok','failed','unknown']);expect(result.items[1]!.provider_code).toBe(123)});
  it.each([{metas:[meta('unrequested')]},{metas:[meta('file1','docx')]},{metas:[{...meta(),request_doc_info:{doc_token:'other',doc_type:'file'}}]},{metas:[meta(),meta()]},{metas:[meta()],failed_list:[{token:'file1',code:5}]},{metas:[],failed_list:[{token:'other',code:5}]},{metas:[],failed_list:[{token:'file1',code:5},{token:'file1',code:6}]},{failed_list:[]}])('rejects mismatched or malformed metadata %s',async data=>{const s=setup();s.request.mockResolvedValue({code:0,data});await expect(s.reads.metadata(s.identity,requests)).rejects.toThrow('metadata')});
  it('enforces metadata request bounds, uniqueness and scope before transport',async()=>{const s=setup();for(const input of [[],[...requests,...requests],Array.from({length:201},(_,i)=>({doc_token:'f'+i,doc_type:'file'}))])await expect(s.reads.metadata(s.identity,input as typeof requests)).rejects.toThrow();await expect(s.reads.metadata({...s.identity,scopes:[]},requests)).rejects.toThrow('permission');expect(s.get).not.toHaveBeenCalled();expect(s.request).not.toHaveBeenCalled()});
  it('does not retain an external or credentialed metadata URL',async()=>{const s=setup();s.request.mockResolvedValue({code:0,data:{metas:[{...meta(),url:'https://attacker.example/file'}]}});expect((await s.reads.metadata(s.identity,requests)).items[0]!.metadata!.url).toBeNull()});
  it('searches for file metadata then fetches the signed result without downloading a binary',async()=>{
    const s=setup();s.request.mockResolvedValueOnce({code:0,data:{res_units:[{entity_type:'DOC',result_meta:{token:'file1',doc_types:'FILE'},title_highlighted:'File'}],has_more:false}}).mockResolvedValueOnce({code:0,data:{metas:[meta()]}});
    const search=await s.workflows.search(s.identity,{query:'File',types:['file']});expect(s.request.mock.calls[0]![0].data.doc_filter.doc_types).toEqual(['FILE']);
    const result=await s.workflows.fetch(s.identity,{result_id:search.results[0]!.result_id});expect(result).toMatchObject({type:'file',content:null,coverage:'metadata_only',status:'ok',next_cursor:null});expect(s.request).toHaveBeenCalledTimes(2);
    await expect(s.workflows.fetch(demoIdentity('beta'),{result_id:search.results[0]!.result_id})).rejects.toThrow('different');
  });
  it('resolves a Wiki file container before querying its metadata',async()=>{const s=setup();const ref=s.handles.encode('resource',s.identity,{provider:'feishu',kind:'file',id:'wiki1',wiki:true});s.request.mockResolvedValueOnce({code:0,data:{node:{obj_type:'file',obj_token:'file1'}}}).mockResolvedValueOnce({code:0,data:{metas:[meta()]}});const result=await s.workflows.fetch(s.identity,{result_id:ref});expect(result).toMatchObject({coverage:'metadata_only',status:'ok'});expect(s.request.mock.calls[1]![0].data.request_docs).toEqual(requests)});
  it('rejects file body continuation and permission changes before transport',async()=>{const s=setup();const result_id=s.handles.encode('resource',s.identity,{provider:'feishu',kind:'file',id:'file1'});await expect(s.workflows.fetch(s.identity,{result_id,cursor:'fake'})).rejects.toThrow('continuation');await expect(s.workflows.fetch({...s.identity,scopes:['search.read']},{result_id})).rejects.toThrow('permission');expect(s.request).not.toHaveBeenCalled()});
  it('does not return a different document ID with the requested document content',async()=>{const s=setup();s.request.mockImplementation(async config=>({code:0,data:config.url.endsWith('/raw_content')?{content:'fixture'}:{document:{document_id:'other',title:'Mismatch'}}}));await expect(s.reads.document(s.identity,'doc1')).rejects.toThrow('mismatched')});
});
