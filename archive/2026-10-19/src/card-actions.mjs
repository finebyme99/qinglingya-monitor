import { hash, isResolved, localTime } from './core.mjs';
import { BaseLedger, BASE_FIELDS as F, tableIssues } from './ledger.mjs';
import { buildCards, issueCardRow } from './card.mjs';

export const cardActionsEnabled=env=>env.CARD_ACTIONS_ENABLED==='true';
const forbidden=message=>Object.assign(new Error(message),{status:403});
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&[...a].reduce((n,c,i)=>n|(c.charCodeAt(0)^b.charCodeAt(i)),0)===0;
const jobKey=id=>`card_action:${id}`;
async function canonicalAction(store,issueId,recordId) {
  const alias=await store.state(`issue_alias:${issueId}`);
  if(!alias)return {issue_id:issueId,record_id:recordId};
  if(alias.from_record_id!==recordId||!alias.issue_id||!alias.record_id||alias.issue_id===issueId||await store.state(`issue_alias:${alias.issue_id}`))throw forbidden('合并记录关联无效');
  return {issue_id:alias.issue_id,record_id:alias.record_id};
}

export async function decodeCardCallback(request,env,now=Date.now()) {
  if(!env.FEISHU_VERIFICATION_TOKEN)throw forbidden('卡片回调尚未配置');
  const raw=await request.text();if(raw.length>64000)throw forbidden('回调过大');
  let body=JSON.parse(raw);
  if(body.encrypt) {
    if(!env.FEISHU_ENCRYPT_KEY)throw forbidden('缺少回调解密配置');
    const bytes=Uint8Array.from(atob(body.encrypt),c=>c.charCodeAt(0));
    const key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.FEISHU_ENCRYPT_KEY)),'AES-CBC',false,['decrypt']);
    body=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-CBC',iv:bytes.slice(0,16)},key,bytes.slice(16))));
  }
  if(!equal(body.header?.token||body.token,env.FEISHU_VERIFICATION_TOKEN))throw forbidden('回调校验失败');
  if(body.type==='url_verification'&&typeof body.challenge==='string')return {challenge:body.challenge};
  if(env.FEISHU_ENCRYPT_KEY) {
    const timestamp=request.headers.get('X-Lark-Request-Timestamp'),nonce=request.headers.get('X-Lark-Request-Nonce'),signature=request.headers.get('X-Lark-Signature');
    if(!timestamp||!nonce||Math.abs(now/1000-Number(timestamp))>300||!equal(signature,await hash(timestamp+nonce+env.FEISHU_ENCRYPT_KEY+raw)))throw forbidden('回调签名校验失败');
  }
  const h=body.header;
  const stamp=Number(h?.create_time),seconds=stamp/(String(h?.create_time).length>=16?1e6:String(h?.create_time).length>=13?1000:1);
  if(body.schema!=='2.0'||h?.app_id!==env.FEISHU_APP_ID||h?.event_type!=='card.action.trigger'||!Number.isFinite(seconds)||Math.abs(now/1000-seconds)>300||!/^[A-Za-z0-9_-]{1,100}$/.test(h?.event_id||''))throw forbidden('回调来源或时间无效');
  // The app and an external group member can belong to different enterprises.
  // processCardActions checks current membership of the original card's chat before any write.
  return body;
}

function hasAction(node,value) {
  if(!node||typeof node!=='object')return false;
  if(Array.isArray(node))return node.some(n=>hasAction(n,value));
  if(node.type==='callback'&&node.value?.action==='resolve_issue'&&node.value.issue_id===value.issue_id&&node.value.record_id===value.record_id)return true;
  return Object.values(node).some(n=>hasAction(n,value));
}
export async function acceptCardAction(body,env,store,now=new Date()) {
  if(!cardActionsEnabled(env))throw forbidden('卡片操作尚未启用');
  const {action,context,operator}=body.event||{},value=action?.value;
  if(action?.tag!=='button'||value?.action!=='resolve_issue'||typeof value.issue_id!=='string'||!/^rec[A-Za-z0-9_]+$/.test(value.record_id||'')||!/^ou_[A-Za-z0-9]+$/.test(operator?.open_id||''))throw forbidden('无效的完成按钮');
  const delivery=await store.db.prepare("SELECT * FROM deliveries WHERE message_id=? AND state='sent'").bind(context?.open_message_id||'').first();
  if(!delivery||delivery.target_chat_id!==context?.open_chat_id||![env.PRODUCTION_CHAT_ID,env.ALLOWED_TARGET_CHAT_ID].includes(delivery.target_chat_id)||!hasAction(JSON.parse(delivery.card),value))throw forbidden('该按钮不属于已发送的授权卡片');
  const issueIds=await store.state(`queue_issues:${delivery.id}`)||[];
  if(!issueIds.includes(value.issue_id))throw forbidden('该卡片没有这个问题');
  const job={event_id:body.header.event_id,issue_id:value.issue_id,record_id:value.record_id,message_id:delivery.message_id,delivery_id:delivery.id,chat_id:delivery.target_chat_id,actor_id:operator.open_id,state:'queued',attempts:0,time:now.toISOString()};
  await store.db.prepare('INSERT OR IGNORE INTO state(key,value) VALUES(?,?)').bind(jobKey(job.event_id),JSON.stringify(job)).run();
  const saved=await store.state(jobKey(job.event_id));
  if(['issue_id','record_id','message_id','actor_id'].some(k=>saved[k]!==job[k]))throw forbidden('重复回调的内容不一致');
  return saved;
}

async function refreshCard(env,store,api,job,ledger,now) {
  const delivery=await store.delivery(job.delivery_id),members=await store.state('members')||{};
  const all=tableIssues(await ledger.records(),{issues:await store.rows('issues'),members,tableUrl:env.BASE_TABLE_URL});
  const byId=new Map(all.map(i=>[i.id,i])),card=JSON.parse(delivery.card);
  const latest=buildCards(all,{slot:delivery.slot,now,cutoff:now,members,botName:env.BOT_NAME,test:job.chat_id===env.ALLOWED_TARGET_CHAT_ID,scopeLabel:'按数据表最新进展统计，仅列未解决事项',tableUrl:env.BASE_TABLE_URL,actions:true})[0];
  card.body.elements[0]=latest.body.elements[0];card.config.summary=latest.config.summary;
  for(const group of card.body.elements.filter(e=>e.tag==='column_set'&&e.columns?.length===1)) {
    const elements=group.columns[0].elements;
    let unresolved=0,matched=0;
    for(let index=1;index<elements.length;index++) {
      const row=elements[index],button=row.columns?.[0]?.elements?.[0]?.columns?.[1]?.elements?.[0];
      const id=button?.behaviors?.find(b=>b.type==='callback')?.value?.issue_id;
      if(!id)continue;
      const original=button.behaviors.find(b=>b.type==='callback').value,target=await canonicalAction(store,id,original.record_id);
      const issue=byId.get(target.issue_id);if(!issue||issue.record_id!==target.record_id)throw new Error('原卡片记录已删除，无法刷新');
      // Preserve the original signed/authorized button tuple even after an approved record merge.
      elements[index]=issueCardRow({...issue,id,record_id:original.record_id},{now,members,actions:true});matched++;if(!isResolved(issue.status))unresolved++;
    }
    if(matched)elements[0].content=`**${elements[0].content.includes('HRIS')?'HRIS':'IT'}事项 · 未解决${unresolved}项**`;
  }
  const footer=card.body.elements.find(e=>e.tag==='markdown'&&e.content.includes('统计截止'));
  if(footer)footer.content=footer.content.replace(/统计截止 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/,`统计截止 ${localTime(now)}`);
  await api.call(`/im/v1/messages/${job.message_id}`,{method:'PATCH',data:{content:JSON.stringify(card)}});
  await store.set(`card_action_refresh:${job.message_id}`,{event_id:job.event_id,time:now.toISOString()});
  return card;
}

export async function processCardActions(env,store,api,{eventId=null,now=new Date(),ledger=null}={}) {
  if(!cardActionsEnabled(env))return [];
  ledger ||= new BaseLedger(api,env);
  const selected=eventId?[await store.state(jobKey(eventId))]:(await store.db.prepare("SELECT value FROM state WHERE key GLOB 'card_action:*' AND json_extract(value,'$.state') IN ('queued','updating','refresh_pending') ORDER BY json_extract(value,'$.time') LIMIT 5").all()).results.map(r=>JSON.parse(r.value));
  const results=[];
  for(let job of selected.filter(Boolean)) {
    if(['done','already_resolved','failed'].includes(job.state)){results.push(job);continue;}
    if(job.next_attempt&&Date.parse(job.next_attempt)>now.getTime())continue;
    try {
      job={...job,attempts:job.attempts+1};await store.set(jobKey(job.event_id),job);
      if(job.state!=='refresh_pending') {
        const people=await api.members(job.chat_id);
        if(!Object.hasOwn(people,job.actor_id))throw forbidden('操作人不在该群');
        const target=await canonicalAction(store,job.issue_id,job.record_id);
        const row=(await ledger.records()).find(r=>r.id===target.record_id);
        if(!row||!((row.fields[F.key]||`table:${row.id}`)===target.issue_id))throw forbidden('原记录已删除或关联已改变');
        const current=tableIssues([row])[0];
        const ownEvidence=String(row.fields[F.evidence]||'').includes(`"event_id":"${job.event_id}"`);
        job={...job,state:'updating'};await store.set(jobKey(job.event_id),job);
        if(!isResolved(current.status)) {
          const evidence=JSON.stringify({type:'human_card_resolution',event_id:job.event_id,actor_id:job.actor_id,time:now.toISOString(),message_id:job.message_id,chat_id:job.chat_id});
          const combined=[row.fields[F.evidence],evidence].filter(Boolean).join('\n');
          if(combined.length>60000)throw new Error('问题证据记录已满，需要归档');
          await ledger.update(row.id,{[F.status]:['已处理'],[F.manual]:true,[F.evidence]:combined});
          job.changed=true;
        }else job.changed=ownEvidence;
        const verified=(await ledger.records()).find(r=>r.id===target.record_id);
        if(!verified||!isResolved(tableIssues([verified])[0].status))throw new Error('已解决状态尚未读回，稍后自动核对');
        if(job.changed) {
          const cached=(await store.rows('issues')).find(i=>i.id===target.issue_id);
          if(cached)await store.putIssues([{...cached,status:'closed',status_label:'已解决',note:`${localTime(now)} · ${people[job.actor_id]||'群成员'}通过卡片确认已解决。`,updated_at:now.toISOString(),closure_message_id:job.message_id,resolution:{type:'card_button',message_id:job.message_id,chat_id:job.chat_id,actor_id:job.actor_id,time:job.time,event_id:job.event_id}}]);
          const mapKey=`ledger_map:${target.issue_id}`,mapping=await store.state(mapKey);
          if(mapping)await store.set(mapKey,{...mapping,manual:true,flag_seen:true});
        }
        job={...job,state:'refresh_pending',data_saved_at:now.toISOString()};await store.set(jobKey(job.event_id),job);
      }
      const card=await refreshCard(env,store,api,job,ledger,now);
      job={...job,state:job.changed?'done':'already_resolved',finished_at:now.toISOString(),error:null,next_attempt:null};
      await store.set(jobKey(job.event_id),job);await store.set('last_card_action',job);await store.set('last_card_action_error',null);
      results.push({...job,card});
    }catch(error) {
      job={...job,state:error.status===403||job.attempts>=3?'failed':job.state==='refresh_pending'?'refresh_pending':'queued',next_attempt:new Date(now.getTime()+60000).toISOString(),error:error.message};
      await store.set(jobKey(job.event_id),job);await store.set('last_card_action_error',{event_id:job.event_id,error:job.error,time:now.toISOString(),data_saved:!!job.data_saved_at});results.push(job);
    }
  }
  return results;
}

export function actionResponse(job) {
  if(!job||!['done','already_resolved','failed'].includes(job.state))return {toast:{type:'info',content:'正在标记已解决，稍后卡片会自动更新'}};
  if(job.state==='failed')return {toast:{type:'error',content:job.data_saved_at?'已记录已解决，卡片显示更新暂未成功':'标记尚未成功，请稍后重试'}};
  return {toast:{type:'success',content:job.state==='already_resolved'?'该问题已解决，无需重复标记':'已标记已解决'}};
}
