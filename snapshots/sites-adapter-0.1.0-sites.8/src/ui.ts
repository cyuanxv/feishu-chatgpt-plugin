import { OAUTH_SOURCE_VERSION } from "./oauth-wire.ts";
import { safeProviderLogId } from "./provider-diagnostics.ts";
export const page = (synthetic = false) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>飞书日程</title><link rel="stylesheet" href="/style.css"></head><body><main><p class="eyebrow">PRIVATE · READ ONLY</p><h1>飞书日程</h1><p>${synthetic ? "仅合成演示：这里展示虚构日程，尚未连接飞书。" : "连接你的飞书账户，在 ChatGPT 中读取你有权限查看的日程。"}</p><section><h2 id="status">正在检查连接</h2><p id="detail" role="status"></p><form id="connect-form" method="post" action="/api/feishu/connect" enctype="application/x-www-form-urlencoded"><input id="connect-csrf" type="hidden" name="csrf" value=""><button id="connect" type="submit" ${synthetic ? "hidden" : ""} disabled>连接飞书</button><button id="connect-documents" type="submit" formaction="/api/feishu/connect-documents" hidden>连接日程并授权文档</button></form><button id="disconnect" hidden>断开连接</button><button id="refresh-token" hidden>检查连接续期</button><button id="demo" ${synthetic ? "" : "hidden"}>查看合成日程</button><div id="demo-result" role="status"></div></section><section id="apps" hidden><h2>飞书应用连接</h2><p>自动识别应用权限并按查询选择连接。新功能提示缺权限时，点击该应用的授权按钮追加只读授权。</p><div id="app-list"></div><form id="app-add"><label for="app-id">App ID</label><input id="app-id" required autocomplete="off"><label for="app-label">连接名称</label><input id="app-label" required maxlength="60"><label for="app-secret">App Secret（仅加密保存，不回显）</label><input id="app-secret" type="password" required autocomplete="new-password"><button type="submit">安全保存并查询权限</button></form><p id="app-message" role="status"></p></section><section id="documents" hidden><h2>搜索 DOCX 文档</h2><p>此处搜索 DOCX；聊天工具还可读取知识库、电子表格、多维表格和任务。</p><form id="doc-search"><label for="doc-query">关键词（最多 30 字）</label><input id="doc-query" required maxlength="60"><button type="submit">搜索文档</button></form><div id="doc-results"></div><button id="doc-more" hidden>更多结果</button><pre id="doc-content" role="status"></pre><button id="doc-next" hidden>继续读取</button></section><p class="note">${synthetic ? "本演示不会向飞书发送请求。数据来源会明确标为 synthetic_fixture。" : "支持读取日程；文档功能开启并授权后，可在聊天中搜索和读取 DOCX 纯文本。授权记录加密保存，断开后不再读取该账户。"}</p></main><script src="/ui.js" defer></script></body></html>`;
export const css = `:root{font:17px/1.6 system-ui,sans-serif;color:#152136;background:#edf3fc}body{margin:0}main{max-width:600px;margin:8vh auto;padding:32px}.eyebrow{font-size:13px;letter-spacing:.12em;color:#375cc4}h1{font-size:40px;line-height:1.2}h2{font-size:21px}section{margin:32px 0;padding:28px;background:white;border:1px solid #cdd9ed;border-radius:16px}button{padding:12px 20px;margin:8px 12px 0 0;border:0;border-radius:8px;font:inherit;background:#2457d5;color:white;cursor:pointer}button:disabled{opacity:.5;cursor:default}button[hidden]{display:none}#disconnect{background:#e9eef9;color:#152136}.note{font-size:14px;color:#506176}pre{white-space:pre-wrap;overflow-wrap:anywhere}input{box-sizing:border-box;max-width:100%;padding:8px;font:inherit}textarea{box-sizing:border-box;width:100%;font:14px/1.5 ui-monospace,monospace;resize:vertical}button:focus-visible{outline:3px solid #ffb83f;outline-offset:3px}@media(max-width:600px){main{margin:3vh auto;padding:24px}}`;
export const script = `
const status=document.querySelector('#status');
const detail=document.querySelector('#detail');
const connect=document.querySelector('#connect');
const connectForm=document.querySelector('#connect-form');
const connectCsrf=document.querySelector('#connect-csrf');
const disconnect=document.querySelector('#disconnect');
const demo=document.querySelector('#demo');
const result=document.querySelector('#demo-result');
let snapshot=null, busy=false;
async function readJSON(response, failure){
  if(response.status===401||response.status===403)throw Error('登录状态已失效，请刷新页面并使用 ChatGPT 重新登录');
  if(!response.ok)throw Error(failure);
  if(!response.headers.get('content-type')?.toLowerCase().includes('application/json'))throw Error(failure);
  try{return await response.json();}catch{throw Error(failure);}
}
async function refresh(){
  const response=await fetch('/api/status',{cache:'no-store'});
  const value=await readJSON(response,'暂时无法读取连接状态，请刷新后重试');
  snapshot=value;
  document.querySelector('#apps').hidden=value.data_mode==='synthetic';
  document.querySelector('#connect-documents').hidden=!value.docx_enabled;
  document.querySelector('#connect-documents').disabled=!value.configured;
  document.querySelector('#documents').hidden=!(value.docx_enabled&&value.docx_authorized&&value.connected);
  connectCsrf.value=typeof value.csrf==='string'?value.csrf:'';
  if(value.data_mode==='synthetic'){
    status.textContent='合成演示模式';detail.textContent=value.notice;
    connect.hidden=true;disconnect.hidden=true;demo.hidden=false;return;
  }
  status.textContent=value.connected?'已连接 '+value.account_name:'尚未连接';
  detail.textContent=value.configured?'连接后可在 ChatGPT 使用日程读取工具':'正在等待安全配置';
  connect.disabled=!value.configured;connect.textContent=value.connected?'重新连接飞书':'连接飞书';
  if(value.docx_enabled){detail.textContent=value.docx_authorized?'已授权日程和 DOCX 文档只读，可在聊天中搜索和读取文档':'日程连接保持可用。点击下方按钮追加文档搜索和读取授权。';connect.textContent='仅连接日程';}
  disconnect.hidden=!value.grant_id;document.querySelector('#refresh-token').hidden=!value.connected;
  demo.hidden=!value.connected;demo.textContent="查看未来 7 天日程";
  if(value.configured)await refreshApps();
}
async function action(path,body){
  if(busy||!snapshot||snapshot.data_mode==='synthetic')return;
  busy=true;connect.disabled=true;disconnect.disabled=true;
  try{
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csrf:snapshot.csrf,...body})});
    const value=await readJSON(response,'操作未完成，请刷新后重试');
    await refresh();if(value.refreshed)detail.textContent='连接续期成功，已安全保存新令牌。';
  }catch(error){await refresh().catch(()=>{});detail.textContent=error.message;}
  finally{busy=false;disconnect.disabled=false;if(snapshot)connect.disabled=!snapshot.configured;}
}
async function showDemo(){
  if(busy||!snapshot)return;
  if(snapshot.data_mode!=='synthetic')return showAgenda();
  busy=true;demo.disabled=true;
  try{
    const start=new Date();start.setUTCHours(0,0,0,0);
    const response=await fetch('/api/demo/agenda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({time_range:{start:start.toISOString(),end:new Date(start.getTime()+86400000).toISOString()},timezone:'UTC'})});
    const data=await readJSON(response,'演示暂时不可用，请刷新后重试');
    if(data?.source!=='synthetic_fixture'||!Array.isArray(data.events))throw Error('演示暂时不可用，请刷新后重试');
    result.textContent=data.notice+' '+data.events.map(event=>event.summary+' '+event.start+' – '+event.end).join('；');
  }catch(error){result.textContent=error.message;}
  finally{busy=false;demo.disabled=false;}
}
async function showAgenda(){
  if(!snapshot)return;
  busy=true;demo.disabled=true;
  try{
    const start=new Date();
    const response=await fetch('/api/agenda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({time_range:{start:start.toISOString(),end:new Date(start.getTime()+7*86400000).toISOString()},timezone:'Asia/Shanghai',page_size:20})});
    if(!response.ok){const failure=await response.json().catch(()=>({}));const label=/^[a-z_]{1,80}$/.test(failure.error)?failure.error:'read_failed';throw Error('飞书读取失败：'+label+'（HTTP '+response.status+'）');}
    const data=await readJSON(response,'飞书日程读取失败，请稍后重试或重新连接');
    if(!Array.isArray(data.events))throw Error('飞书返回格式异常');
    const stamp=t=>t.date||new Date(Number(t.timestamp)*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});
    result.textContent='已从飞书云端读取。'+(data.events.length?data.events.map(e=>(e.summary||'无标题日程')+' '+stamp(e.start)).join('；'):'本页没有日程。')+(data.partial?' 结果尚不完整，请在聊天中继续分页读取。':' 已完成本次范围检查。');
  }catch(error){result.textContent=error.message;}
  finally{busy=false;demo.disabled=false;}
}
let docQuery='', searchCursor=null, resultId=null, contentCursor=null, docConnection=null;
const docResults=document.querySelector('#doc-results'), docContent=document.querySelector('#doc-content'), docMore=document.querySelector('#doc-more'), docNext=document.querySelector('#doc-next');
async function docRequest(path,args){
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
  const value=await response.json();
  if(!response.ok)throw Error('文档读取未完成：'+(/^[a-z_]{1,80}$/.test(value.error)?value.error:'read_failed'));
  return value;
}
async function readDoc(id,more=false){
  if(busy)return;busy=true;
  try{const value=await docRequest('/api/docx/fetch',{result_id:id,...(docConnection?{connection_id:docConnection}:{}),...(more?{cursor:contentCursor}:{})});resultId=id;contentCursor=value.next_cursor;docContent.textContent=(more?docContent.textContent:'')+value.content;docNext.hidden=!contentCursor;}
  catch(e){docContent.textContent=e.message;docNext.hidden=true;}
  finally{busy=false;}
}
async function searchDocs(more=false){
  if(busy)return;busy=true;
  if(!more){docQuery=document.querySelector('#doc-query').value;searchCursor=null;docResults.replaceChildren();docContent.textContent='';docNext.hidden=true;}
  try{const value=await docRequest('/api/docx/search',{query:docQuery,page_size:5,...(more?{cursor:searchCursor,connection_id:docConnection}:{})});
    docConnection=value.connection_id??null;
    for(const item of value.results){const button=document.createElement('button');button.textContent=item.title||'无标题文档';button.addEventListener('click',()=>readDoc(item.result_id));docResults.append(button);}
    searchCursor=value.next_cursor;docMore.hidden=!searchCursor;if(!value.results.length&&!more)docContent.textContent='没有匹配的 DOCX 文档。';
  }catch(e){docContent.textContent=e.message;docMore.hidden=true;}
  finally{busy=false;}
}
document.querySelector('#doc-search').addEventListener('submit',event=>{event.preventDefault();searchDocs();});
docMore.addEventListener('click',()=>searchDocs(true));docNext.addEventListener('click',()=>readDoc(resultId,true));
async function refreshApps(){
  const value=await readJSON(await fetch('/api/apps',{cache:'no-store'}),'无法读取应用连接');
  const list=document.querySelector('#app-list');list.replaceChildren();
  for(const app of value.connections){
    const row=document.createElement('div'), label=document.createElement('p');label.textContent=app.label+' · '+(app.connected?'已连接 '+app.account_name:'待授权')+' · 已授权 '+app.granted_scopes.length+' 项';row.append(label);
    const form=document.createElement('form');form.method='post';form.action='/api/apps/connect';
    for(const [name,value] of Object.entries({csrf:snapshot.csrf,connection_id:app.connection_id})){const field=document.createElement('input');field.type='hidden';field.name=name;field.value=value;form.append(field);}
    const button=document.createElement('button');button.type='submit';button.textContent='授权 '+app.label;form.append(button);row.append(form);
    if(app.connected){const renew=document.createElement('button');renew.textContent='检查 '+app.label+' 续期';renew.addEventListener('click',()=>action('/api/apps/refresh',{connection_id:app.connection_id,grant_id:app.grant_id,epoch:app.epoch}));row.append(renew);
    const remove=document.createElement('button');remove.textContent='断开 '+app.label;remove.addEventListener('click',()=>action('/api/apps/disconnect',{connection_id:app.connection_id,grant_id:app.grant_id,epoch:app.epoch}));row.append(remove);}
    list.append(row);
  }
  const docs=value.connections.some(a=>a.connected&&a.granted_scopes.includes('search:docs:read')&&a.granted_scopes.includes('docx:document:readonly'));
  document.querySelector('#documents').hidden=!snapshot.docx_enabled||!docs;
  demo.hidden=!value.connections.some(a=>a.connected&&a.granted_scopes.includes('calendar:calendar:read')&&a.granted_scopes.includes('calendar:calendar.event:read'));
}
document.querySelector('#app-add').addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!snapshot)return;busy=true;
  const secret=document.querySelector('#app-secret'), message=document.querySelector('#app-message');
  try{const response=await fetch('/api/apps',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csrf:snapshot.csrf,app_id:document.querySelector('#app-id').value.trim(),label:document.querySelector('#app-label').value.trim(),app_secret:secret.value})});secret.value='';const value=await response.json();if(!response.ok)throw Error(/^[a-z_]{1,80}$/.test(value.error)?value.error:'save_failed');message.textContent='已加密保存。飞书 API 查询到 '+value.permission_count+' 项权限，请点击该连接的授权按钮。';await refresh();}
  catch(e){message.textContent='保存未完成：'+e.message;}finally{secret.value='';busy=false;}
});
demo.addEventListener('click',showDemo);
connectForm.addEventListener('submit',event=>{
  if(busy||!snapshot||snapshot.data_mode==='synthetic'||!snapshot.configured||!connectCsrf.value){event.preventDefault();return;}
  busy=true;connect.disabled=true;disconnect.disabled=true;
});
window.addEventListener('pageshow',event=>{
  if(!event.persisted)return;
  busy=false;connect.disabled=true;disconnect.disabled=false;
  return refresh().catch(error=>{detail.textContent=error.message;});
});
document.querySelector('#refresh-token').addEventListener('click',()=>action('/api/feishu/refresh',{grant_id:snapshot.grant_id,epoch:snapshot.epoch}));
disconnect.addEventListener('click',()=>action('/api/feishu/disconnect',{grant_id:snapshot.grant_id,epoch:snapshot.epoch}));
refresh().catch(error=>{status.textContent='暂时无法读取连接';detail.textContent=error.message;});
`;

export function callbackFailurePage(
  code: string,
  correlationId: string,
  providerCode?: number,
  providerLogId?: string,
  failurePath = "/api/feishu/callback",
) {
  // The page accepts only fixed local error labels, an independently generated UUID,
  // and a bounded numeric provider code. Never interpolate provider text or queries.
  const label = /^[a-z_]{1,80}$/.test(code) ? code : "service_unavailable";
  const reference = /^[a-f0-9-]{36}$/.test(correlationId)
    ? correlationId
    : "unavailable";
  const provider =
    Number.isSafeInteger(providerCode) &&
    providerCode! >= 0 &&
    providerCode! <= 999999999
      ? String(providerCode)
      : "未提供";
  const trace = safeProviderLogId(providerLogId) ?? "未提供";
  const cleanupPath =
    failurePath === "/api/feishu/connect"
      ? "/api/feishu/connect"
      : "/api/feishu/callback";
  const receipt = `错误：${label}\n飞书错误码：${provider}\n飞书请求编号：${trace}\n本站关联编号：${reference}\n版本：${OAUTH_SOURCE_VERSION}`;
  const escapedReceipt = receipt
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>飞书连接未完成</title><link rel="stylesheet" href="/style.css"></head><body data-cleanup-path="${cleanupPath}"><main><p class="eyebrow">PRIVATE · READ ONLY</p><h1>飞书连接未完成</h1><p>这次连接没有完成。请把下面的错误信息发给我，先不要重复授权。</p><section><label for="error-receipt">可复制的错误信息</label><textarea id="error-receipt" readonly rows="6" cols="34">${escapedReceipt}</textarea><button id="copy-error" type="button">复制错误信息</button><p id="copy-status" role="status"></p><a href="/">回到连接页</a></section><p class="note">这里不包含授权码、验证值或账户凭据。</p></main><script src="/oauth-error.js" defer></script></body></html>`;
}
export const callbackFailureScript = `
// Remove one-use OAuth query values from the visible URL without another request.
const cleanupPath=document.body?.dataset?.cleanupPath==='/api/feishu/connect'?'/api/feishu/connect':'/api/feishu/callback';
history.replaceState(null,'',cleanupPath);
document.querySelector('#copy-error').addEventListener('click',async()=>{
  const receipt=document.querySelector('#error-receipt');
  const status=document.querySelector('#copy-status');
  try{await navigator.clipboard.writeText(receipt.value);status.textContent='已复制';}
  catch{receipt.focus();receipt.select();status.textContent='请复制已选中的错误信息';}
});
`;
