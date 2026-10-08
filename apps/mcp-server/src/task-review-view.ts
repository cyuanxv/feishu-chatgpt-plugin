import type { CreateTaskInput } from '../../../packages/schemas/src/task-write.js';
import type { TaskReviewSession } from '../../../packages/auth/src/task-review-session.js';
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const json=(value:unknown)=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
export function renderTaskReview(input:CreateTaskInput,session:TaskReviewSession,csrf:string,allowCreate:boolean):string{
 const data={version:1,operation:'create_task',intent_id:session.intent_id,request_hash:session.request_hash,csrf,input,expires_at:session.expires_ms,server_now:Date.now(),allow_create:allowCreate};
 const deadline=!input.due?'不设置截止日期':input.due.kind==='all_day'?escape(input.due.date)+'（全天，按此日期显示）':escape(input.due.at)+'<br><span class="fine">同一时刻，各查看者按其时区显示</span>';
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>确认创建飞书任务</title><link rel="stylesheet" href="/task-review/assets/review.css"><script src="/task-review/assets/review.js" defer></script></head><body>
 <div class="shell"><header class="top"><div><span class="brand">任务确认</span><span class="badge">独立集成 · 开发候选</span></div><span id="expiry" class="expiry">正在核验预览有效期</span></header>
 <main><div class="intro"><p class="eyebrow">CREATE TASK</p><h1>检查这条任务，再确认创建。</h1><p>以当前飞书用户身份创建未完成、未分配的任务。请核对完整描述和截止日期。</p></div>
 <div class="layout"><section class="document card" aria-labelledby="preview-heading"><div class="section-head"><h2 id="preview-heading">任务预览</h2><span>完整原文</span></div><h3 id="document-title">${escape(input.summary)}</h3><pre id="document-body">${escape(input.description??'（无描述）')}</pre><noscript><p class="notice">需要 JavaScript 完成安全状态核验。当前不会创建任务。</p></noscript></section>
 <aside class="card decision"><h2>创建设置</h2><dl><dt>提供方</dt><dd>${session.domain==='feishu'?'飞书':'Lark'}</dd><dt>已验证账户 ID</dt><dd>${escape(session.open_id)}</dd><dt>租户 ID</dt><dd>${escape(session.tenant_id)}</dd><dt>发起应用</dt><dd>${escape(session.client_id)}</dd><dt>负责人 / 关注人</dt><dd>均为空（包括本人）</dd><dt>任务清单</dt><dd>不加入清单</dd><dt>截止日期</dt><dd id="task-deadline">${deadline}</dd><dt>内容版本</dt><dd><code>${escape(session.request_hash.slice(0,12))}</code></dd></dl>
 <p class="notice">不会主动添加提醒。飞书自身的通知行为尚未验证。确认后，关闭页面不会撤销已提交的任务。</p>
 <div id="status" class="status" role="status" aria-live="polite">正在核验当前授权与预览版本…</div>
 <div class="actions"><button id="confirm" class="primary" type="button" disabled>确认创建任务</button><button id="cancel" class="secondary" type="button" disabled>取消并关闭预览</button></div>
 <p id="receipt-id" class="fine" hidden></p><a id="document-link" class="result-link" hidden target="_blank" rel="noopener noreferrer">打开已创建的任务</a><p class="fine">任务标题和描述不会保存在服务器。此页面不要求你输入密钥或访问令牌。</p></aside></div></main>
 <footer>操作绑定当前账户、内容版本和短期会话。不会自动重复创建任务。</footer></div><script id="review-data" type="application/json">${json(data)}</script></body></html>`;
}
export function renderTaskReviewUnavailable(message='请从已认证的宿主重新打开任务预览。'):string{return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>任务预览不可用</title><link rel="stylesheet" href="/task-review/assets/review.css"></head><body><main class="empty card"><p class="eyebrow">TASK REVIEW</p><h1>预览尚未就绪</h1><p>${escape(message)}</p><p class="fine">这里不会创建任务，也不需要输入密钥或令牌。</p></main></body></html>`;}
