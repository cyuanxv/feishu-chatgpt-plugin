import type { CreateDocumentInput } from '../../../packages/schemas/src/document-write.js';
import type { DocumentReviewSession } from '../../../packages/auth/src/document-review-session.js';

const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const json=(value:unknown)=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
export function renderDocumentReview(input:CreateDocumentInput,session:DocumentReviewSession,csrf:string,allowCreate:boolean):string {
  const data={version:1,operation:'create_doc',intent_id:session.intent_id,request_hash:session.request_hash,csrf,input,expires_at:session.expires_ms,server_now:Date.now(),allow_create:allowCreate};
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>确认创建飞书文档</title><link rel="stylesheet" href="/document-review/assets/review.css"><script src="/document-review/assets/review.js" defer></script></head><body>
  <div class="shell"><header class="top"><div><span class="brand">文档确认</span><span class="badge">独立集成 · 开发候选</span></div><span id="expiry" class="expiry">正在核验预览有效期</span></header>
  <main><div class="intro"><p class="eyebrow">CREATE DOCUMENT</p><h1>最后检查一下，再创建。</h1><p>请确认目标账户、目录和完整正文。只有点击确认后才会提交创建请求。</p></div>
  <div class="layout"><section class="document card" aria-labelledby="preview-heading"><div class="section-head"><h2 id="preview-heading">文档预览</h2><span>完整 Markdown</span></div><h3 id="document-title">${escape(input.title)}</h3><pre id="document-body">${escape(input.markdown)}</pre><noscript><p class="notice">需要 JavaScript 完成安全状态核验。当前不会创建文档。</p></noscript></section>
  <aside class="card decision"><h2>创建到哪里</h2><dl><dt>提供方</dt><dd>${session.domain==='feishu'?'飞书':'Lark'}</dd><dt>已验证账户 ID</dt><dd>${escape(session.open_id)}</dd><dt>租户 ID</dt><dd>${escape(session.tenant_id)}</dd><dt>发起应用</dt><dd>${escape(session.client_id)}</dd><dt>目标目录</dt><dd>${input.folder_token?`指定目录<br><code>${escape(input.folder_token)}</code>`:'我的云文档（my_library）'}</dd><dt>内容版本</dt><dd><code>${escape(session.request_hash.slice(0,12))}</code></dd></dl>
  <p class="notice">采用目标目录现有的可见权限，不会更改共享设置。确认后，关闭页面不会撤销已提交的创建。</p>
  <div id="status" class="status" role="status" aria-live="polite">正在核验当前授权与预览版本…</div>
  <div class="actions"><button id="confirm" class="primary" type="button" disabled>确认创建文档</button><button id="cancel" class="secondary" type="button" disabled>取消并关闭预览</button></div>
  <a id="document-link" class="result-link" hidden target="_blank" rel="noopener noreferrer">打开已创建的文档</a>
  <p class="fine">预览正文不会保存在服务器。此页面不要求你输入密钥或访问令牌。</p></aside></div></main>
  <footer>操作绑定当前账户、内容版本和短期会话。刷新、返回或再次点击不会重复创建。</footer></div>
  <script id="review-data" type="application/json">${json(data)}</script></body></html>`;
}
export function renderReviewUnavailable(message='请从已认证的宿主重新打开文档预览。'):string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>文档预览不可用</title><link rel="stylesheet" href="/document-review/assets/review.css"></head><body><main class="empty card"><p class="eyebrow">DOCUMENT REVIEW</p><h1>预览尚未就绪</h1><p>${escape(message)}</p><p class="fine">这里不会创建文档，也不需要输入密钥或令牌。</p></main></body></html>`;
}
