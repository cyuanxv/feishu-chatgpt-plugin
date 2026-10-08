/* No browser storage, secrets, automatic create retry or markup evaluation. */
(() => {
  'use strict';
  const dataNode=document.getElementById('review-data');if(!dataNode)return;
  let data;try{data=JSON.parse(dataNode.textContent);}catch{return;}
  const operation=data.operation??'create_doc';if(!['create_doc','create_task'].includes(operation))return;
  const isTask=operation==='create_task',basePath=isTask?'/task-review/':'/document-review/';
  const confirm=document.getElementById('confirm'),cancel=document.getElementById('cancel'),status=document.getElementById('status'),expiry=document.getElementById('expiry'),link=document.getElementById('document-link'),receiptId=document.getElementById('receipt-id');
  document.getElementById('document-title').textContent=isTask?data.input.summary:data.input.title;
  document.getElementById('document-body').textContent=isTask?(data.input.description??'（无描述）'):data.input.markdown;
  let state='checking',generation=0,pollTimer=null,remaining=Math.max(0,data.expires_at-data.server_now),measured=performance.now(),submitted=false;
  const base=()=>({version:1,intent_id:data.intent_id,request_hash:data.request_hash,csrf:data.csrf});
  const message=(text,tone='')=>{status.textContent=isTask?text.replaceAll('文档','任务').replaceAll('正文','内容'):text;status.dataset.tone=tone;};
  const stopPolling=()=>{if(pollTimer!==null){clearTimeout(pollTimer);pollTimer=null;}};
  const inert=(text,tone='error')=>{state='ended';generation++;stopPolling();confirm.disabled=true;cancel.disabled=true;document.body.classList.add('ended');message(text,tone);};
  async function post(path,payload){const response=await fetch(basePath+path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});let result;try{result=await response.json();}catch{throw new Error('invalid_response');}return{response,result};}
  function renderReceipt(result){
    confirm.disabled=true;cancel.disabled=true;state='receipt';const receipt=result.receipt;if(['succeeded','partial','failed','cancelled','expired'].includes(receipt?.status)||(receipt?.status==='uncertain'&&!result.can_refresh))state='complete';
    const messages={preview:submitted?'提交结果尚未确认，正在只读核对。不会重复提交。':'预览尚未提交。',approved:'确认已记录，等待提交状态。',cancelled:'已取消，未创建文档。',expired:'预览已过期，请重新打开。',executing:'创建已提交，正在确认结果。关闭页面不会撤销它。',pending:'飞书正在处理文档，请等待状态更新。',succeeded:'飞书已返回创建成功回执。正文尚未回读核验。',partial:'文档已创建，但存在内容警告，请打开文档检查。',failed:receipt?.may_have_created?'创建未确认成功，仍可能有部分结果。请先核对，不要重复创建。':'未能提交创建，当前授权可能已改变。',uncertain:'创建结果暂不确定。不会自动重复创建，请先核对已有结果。'};
    if(isTask&&receipt?.status==='partial'){messages.partial='飞书已返回任务编号，但部分字段未核对。请检查已有任务，不要重复创建。';const labels={summary:'标题',description:'描述',due:'截止日期',members:'负责人和关注人',tasklists:'清单',completed_at:'未完成状态',url:'任务链接'};const fields=Array.isArray(receipt.unverified_fields)?receipt.unverified_fields.map(field=>labels[field]).filter(Boolean):[];if(fields.length)messages.partial+=' 待核对：'+fields.join('、')+'。';}
    if(receiptId){receiptId.hidden=!receipt?.task_guid;receiptId.textContent=receipt?.task_guid?'任务 ID：'+receipt.task_guid:'';}
    message(messages[receipt?.status]||'结果暂不可用，请从宿主查询回执。',['succeeded','cancelled'].includes(receipt?.status)?'success':['failed','uncertain','partial'].includes(receipt?.status)?'error':'');
    link.hidden=true;if(receipt?.url){try{const url=new URL(receipt.url);if(url.protocol==='https:'&&!url.username&&!url.password){link.href=url.href;link.hidden=false;}}catch{}}
    if((result.can_refresh||['executing','approved'].includes(receipt?.status)||(submitted&&receipt?.status==='preview'))&&Math.max(0,remaining-(performance.now()-measured))>0){stopPolling();pollTimer=setTimeout(()=>check(Boolean(result.can_refresh)),3000);}
  }
  async function check(refresh=false){
    const epoch=++generation;confirm.disabled=true;cancel.disabled=true;if(state!=='receipt')state='checking';
    try{const {response,result}=await post('status',{...base(),refresh});if(epoch!==generation||state==='ended')return;
      if(!response.ok||!result.ok){inert('预览、账户或会话已失效。请从宿主重新打开，不会再次创建。');return;}
      remaining=result.remaining_ms;measured=performance.now();
      if(!submitted&&result.phase==='review'&&result.receipt.status==='preview'){
        state='ready';confirm.disabled=!result.can_submit;cancel.disabled=false;
        message(result.can_submit?(isTask?'账户和内容版本已核验。请核对未分配状态、截止日期及完整描述。':'账户和内容版本已核验。请核对目标目录及完整正文。'):'当前仅能预览，真实创建入口仍关闭。');
      }else{renderReceipt(result);}
    }catch{if(epoch===generation&&state!=='ended'){confirm.disabled=true;cancel.disabled=true;message(submitted?'提交结果尚未确认。只查询回执，不会重复提交。':'无法核验预览状态，请稍后从宿主重新打开。','error');if(submitted&&Math.max(0,remaining-(performance.now()-measured))>0){stopPolling();pollTimer=setTimeout(()=>check(false),3000);}}}
  }
  confirm.addEventListener('click',async()=>{
    if(state!=='ready'||confirm.disabled||submitted)return;submitted=true;state='submitting';const epoch=++generation;stopPolling();confirm.disabled=true;cancel.disabled=true;message('正在提交一次创建请求…');
    try{const {response,result}=await post('confirm',{...base(),input:data.input});if(epoch!==generation||state==='ended'||state==='suspended')return;
      if(response.ok&&result.ok){remaining=result.remaining_ms;measured=performance.now();renderReceipt(result);}else{message('提交状态需要核对，只查询回执，不会重复创建。','error');await check(false);}
    }catch{if(epoch===generation&&state!=='ended'&&state!=='suspended'){message('网络中断，提交结果尚未确认。不会重复创建。','error');await check(false);}}
  });
  cancel.addEventListener('click',async()=>{
    if(state!=='ready'||submitted)return;state='closing';const epoch=++generation;stopPolling();confirm.disabled=true;cancel.disabled=true;
    try{const {response,result}=await post('close',base());if(epoch!==generation||state==='suspended')return;if(response.ok&&result.cancelled){inert('已取消并关闭预览，未创建文档。','success');}else{inert('此操作可能已经提交，关闭页面不会撤销。请从宿主查询回执。');}}catch{if(epoch===generation&&state!=='suspended')inert('关闭请求未获确认。此页面不会再提交，请从宿主核对状态。');}
  });
  window.addEventListener('pagehide',()=>{
    generation++;stopPolling();confirm.disabled=true;cancel.disabled=true;
    if(!submitted&&['ready','checking'].includes(state)){try{navigator.sendBeacon(basePath+'close',new Blob([JSON.stringify(base())],{type:'application/json'}));}catch{}}
    state='suspended';
  });
  window.addEventListener('pageshow',event=>{if(event.persisted){state='checking';check(false);}});
  function tick(){const left=Math.max(0,remaining-(performance.now()-measured));expiry.textContent=left>0?'剩余 '+Math.floor(left/60000)+':'+String(Math.floor(left/1000)%60).padStart(2,'0'):'预览已到期';if(left<=0&&state!=='ended'&&state!=='suspended'&&state!=='complete')inert(submitted?'会话已到期，请从宿主查询创建回执。不会重复创建。':'预览已到期，未提交创建。请重新打开。');}
  setInterval(tick,1000);tick();
  check(false);
})();
