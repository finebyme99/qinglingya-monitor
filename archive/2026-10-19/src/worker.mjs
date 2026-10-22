import { SLOTS, STATUS, ANALYSIS_PROMPT, assertTarget, assertDeliveryTarget, deliveryRoute, dueSlots, hash, normalize, localTime, isWeekday, analysisInput, isResolved } from './core.mjs';
import { buildCards, buildCardPages } from './card.mjs';
import { Store } from './store.mjs';
import { Feishu } from './api.mjs';
import { analyzeIssues, analysisImages } from './analysis.mjs';
import { previousPeriodStart, scopeIssues, isResolutionCommand, resolveCommand, hasResolutionText } from './tracking.mjs';
import { BaseLedger, ledgerEnabled, syncLedger, tableIssues } from './ledger.mjs';
import { cardActionsEnabled, decodeCardCallback, acceptCardAction, processCardActions, actionResponse } from './card-actions.mjs';
import { notifyOwner, notifyCardFailures, checkExternalMonitor } from './alerts.mjs';
import { monitorAuthorized, monitorStatus } from './monitor.mjs';
const BUILD='20261022-prepush-analysis-v18';
const COMMAND_RULES='20261016-any-member-and-transfer-v2';
const TABLE_SCOPE='按数据表最新进展统计，仅列未解决事项';
async function tableData(env,store,api=new Feishu(env)) {
  const rows=await new BaseLedger(api,env).records(),members=await store.state('members')||{};
  return {issues:tableIssues(rows,{issues:await store.rows('issues'),members,tableUrl:env.BASE_TABLE_URL}),members,cutoff:new Date(),ledger:true};
}

async function scopedData(store,issues,slot,now,save=false) {
  let policy=await store.state('tracking_policy');
  if(!policy){policy={start_day:previousPeriodStart(now)};if(save)await store.set('tracking_policy',policy);}
  const day=localTime(now).slice(0,10),key=`morning:${day}`;
  let morning=await store.state(key);
  if(!morning&&save){morning={ids:issues.filter(i=>!isResolved(i.status)&&localTime(new Date(i.created_at)).slice(0,10)>=policy.start_day&&localTime(new Date(i.created_at)).slice(0,10)<day).map(i=>i.id),time:new Date().toISOString()};await store.set(key,morning);}
  return {issues:scopeIssues(issues,{now,slot,startDay:policy.start_day,morningIds:morning?.ids||[]}),scopeLabel:slot==='0930'?'前一日（周一合并周五及周末）＋已提醒未解决遗留':'当天新增＋早间及跨日未解决遗留'};
}
export async function processCommands(env,store,api,now=new Date()) {
  if(!env.BOT_OPEN_ID)return [];
  const last=await store.state('last_command_poll');
  const rulesCurrent=await store.state('command_rules_version')===COMMAND_RULES;
  const start=last&&rulesCurrent?Date.parse(last)-300000:now.getTime()-86400000;
  const groups=await Promise.all([api.list(env.SOURCE_CHAT_ID,'chat',start,{allReplies:true}),api.list(env.TARGET_CHAT_ID,'chat',start,{allReplies:true})]);
  const members=await store.state('members')||{};
  const commands=groups.flat().map(m=>normalize(m,members)).filter(m=>!m.deleted&&[env.SOURCE_CHAT_ID,env.TARGET_CHAT_ID].includes(m.chat_id)&&hasResolutionText(m)).sort((a,b)=>a.created_at.localeCompare(b.created_at));
  const results=[];
  for(const command of commands) {
    const key=`command:${command.id}`;if(await store.state(key))continue;
    const refs=[command.parent_id,command.root_id].filter(Boolean);const cardIds=[];
    for(const id of refs)cardIds.push(...await store.state(`card_issues:${id}`)||[]);
    const issues=await store.rows('issues');const target=resolveCommand(command,issues,cardIds);
    const selected=target.issues||[];
    if(!selected.length&&!isResolutionCommand(command,env.BOT_OPEN_ID))continue;
    let reply;
    const result={message_id:command.id,chat_id:command.chat_id,actor_id:command.sender_id,time:command.created_at,uuid:crypto.randomUUID(),state:selected.length?'resolved':'needs_target'};
    if(selected.length) {
      const updated=selected.map(issue=>{const status=target.outcomes?.[issue.id]||'closed';return {...issue,status,status_label:STATUS[status],updated_at:new Date().toISOString(),closure_message_id:command.id,note:status==='converted'?'已转需求后续跟进，本轮问题已闭环。':'群成员已明确确认完成或验收无误。',resolution:{type:isResolutionCommand(command,env.BOT_OPEN_ID)?'mention_command':'message_confirmation',message_id:command.id,chat_id:command.chat_id,actor_id:command.sender_id,time:command.created_at}};});
      await store.putIssues(updated);result.issue_ids=updated.map(i=>i.id);if(updated.length===1)result.issue_id=updated[0].id;
      reply=`已更新${updated.map(i=>`「${i.title}」：${STATUS[i.status]}`).join('；')}。下一次汇总会更新指标。`;
    }else reply=target.reason;
    await store.set(key,{...result,ack:'started'});
    // Business-group confirmations only update the ledger; replies stay in the test chat.
    if(command.chat_id===env.ALLOWED_TARGET_CHAT_ID) {
      try {
        assertDeliveryTarget(env,command.chat_id,now);
        const receipt=await api.call(`/im/v1/messages/${command.id}/reply`,{method:'POST',data:{msg_type:'text',content:JSON.stringify({text:reply}),uuid:result.uuid}});
        if(!receipt?.message_id||receipt.chat_id!==command.chat_id)throw new Error('完成确认回执不完整');
        result.ack='sent';result.reply_message_id=receipt.message_id;
      }catch(error){result.ack='unknown';result.ack_error=error.message;await store.event('command_ack_error',result);}
    }else result.ack='source-silent';
    await store.set(key,result);await store.set('last_command',result);await store.event('resolution_command',result);results.push(result);
  }
  await store.set('last_command_poll',now.toISOString());await store.set('command_rules_version',COMMAND_RULES);return results;
}

async function sync(env, store, api, now,ledgerRows=null) {
  const last=await store.state('last_sync');
  const bootstrap=Number(env.BOOTSTRAP_DAYS||7)*86400000;
  const start=last?Math.max(Date.parse(last)-300000,now.getTime()-bootstrap):now.getTime()-bootstrap;
  const members=await api.members(env.SOURCE_CHAT_ID);
  const raw=await api.list(env.SOURCE_CHAT_ID,'chat',start,{allReplies:true});
  const previous=await store.rows('issues');
  const known=await store.rows('messages');
  const policy=await store.state('tracking_policy')||{start_day:previousPeriodStart(now)};
  const active=i=>localTime(new Date(i.created_at)).slice(0,10)>=policy.start_day;
  const pinned=new Set(previous.filter(i=>active(i)&&!isResolved(i.status)).map(i=>i.root_id));
  const refresh=known.filter(m=>pinned.has(m.id)&&Date.parse(m.created_at)<start).map(m=>m.id);
  if(refresh.length) raw.push(...await api.getMessages(refresh));
  const threads=[...new Set(raw.filter(m=>m.thread_id).map(m=>m.thread_id))];
  for(const thread of threads) raw.push(...await api.list(thread,'thread'));
  const have=new Set([...known.map(m=>m.id),...raw.map(m=>m.message_id)]);
  for(let depth=0;depth<8;depth++) {
    const parents=[...new Set(raw.flatMap(m=>[m.parent_id,m.root_id]).filter(id=>id&&!have.has(id)))];
    if(!parents.length) break;
    const ancestors=await api.getMessages(parents);
    if(!ancestors.length) throw new Error('回复所引用的原消息无法读取，需要核对');
    for(const m of ancestors) have.add(m.message_id);
    raw.push(...ancestors);
  }
  const incoming=new Map((await api.expandForwards(raw)).map(m=>{const n=normalize(m,members);return [n.id,n];}));
  if([...incoming.values()].some(m=>m.chat_id!==env.SOURCE_CHAT_ID)) throw new Error('飞书返回了来源群之外的消息，本轮停止');
  const merged=new Map(known.map(m=>[m.id,m]));
  for(const [id,m] of incoming) merged.set(id,m);
  const all=[...merged.values()].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
  const signature=await hash(JSON.stringify(all.map(m=>[m.id,m.updated_at,m.deleted,m.text,m.parent_id,m.mentions,m.image_refs||[]])));
  const analyzed=await store.state('analyzed_signature');
  await store.putMessages([...incoming.values()],hash);
  if(signature!==analyzed) {
    const pending=await store.unanalyzed();
    const human=pending.filter(m=>m.sender_type==='user'&&!m.deleted&&!isResolutionCommand(m,env.BOT_OPEN_ID));
    await store.markAnalyzed(pending.filter(m=>m.sender_type!=='user'||m.deleted||isResolutionCommand(m,env.BOT_OPEN_ID)).map(m=>m.id));
    for(let offset=0;offset<human.length;offset+=50) {
      const batch=human.slice(offset,offset+50);
      const cached=(await store.rows('issues')).filter(active);
      const authoritative=ledgerRows?tableIssues(ledgerRows,{issues:cached,members,tableUrl:env.BASE_TABLE_URL}):[];
      const byId=new Map(authoritative.map(i=>[i.id,i]));
      const current=cached.map(i=>{const row=byId.get(i.id);return row?{...i,title:row.title,status:row.status,note:row.note,owner_ids:row.owner_ids}:i;});
      const contextIds=new Set(current.flatMap(i=>[i.root_id,...i.evidence_ids]));
      for(const m of batch) { contextIds.add(m.id);if(m.root_id) contextIds.add(m.root_id);if(m.parent_id) contextIds.add(m.parent_id); }
      const through=Math.max(...batch.map(m=>Date.parse(m.created_at)));
      const nearby=all.filter(m=>m.sender_type==='user'&&Date.parse(m.created_at)<=through).slice(-35);
      for(const m of nearby) contextIds.add(m.id);
      // Include reply ancestors, while never asking the model to invent a missing original report.
      for(let depth=0;depth<8;depth++) for(const m of all) if(contextIds.has(m.id)) {if(m.parent_id)contextIds.add(m.parent_id);if(m.root_id)contextIds.add(m.root_id);}
      const context=all.filter(m=>m.sender_type==='user'&&contextIds.has(m.id));
      await store.set('analysis_progress',{phase:'analyzing',batch:Math.floor(offset/50)+1,total_batches:Math.ceil(human.length/50),messages:human.length,time:new Date().toISOString()});
      const input=analysisInput(now,current,context,batch);
      input.image_inputs=await analysisImages(api,context,batch,current);
      if(ledgerRows)input.ledger_records=authoritative.map(({id,title,status,note,manual,source_url})=>({id,title,status,note,manual,source_url}));
      const result=await analyzeIssues(env,input,ANALYSIS_PROMPT+'\n本次是增量批次，只分析focus_message_ids中的新增消息及其对已有事项的影响。其他messages是理解引用关系的背景，不要把背景里的每个问题重新输出。',{messages:all,previous:current,members,onInvalid:async diagnostic=>{await store.set('analysis_validation_failure',diagnostic);if(diagnostic.kind==='model_output')await store.event('ai_output_invalid',diagnostic);}});
      const changes=[];
      for(const change of result.changes)if(!await store.state(`issue_alias:${change.id}`))changes.push(change);
      for(const i of changes) if(!i.source_url) throw new Error('原消息缺少可用跳转链接，停止发送以免误导');
      await store.putIssues(changes);
      await store.markAnalyzed(batch.map(m=>m.id));
      await store.set('last_ai',{time:new Date().toISOString(),model:result.model,usage:result.usage,changes:changes.length,repairs:result.repairs,format_retries:result.format_retries});
    }
    await store.set('analyzed_signature',signature);
    await store.set('analysis_progress',{phase:'complete',time:new Date().toISOString()});
    await store.set('analysis_validation_failure',null);
  }
  await store.set('members',members);
  await store.set('last_sync',now.toISOString());
  await store.set('last_error',null);
  return {issues:await store.rows('issues'),members,cutoff:now};
}
export async function sendQueued(store, api, env, now=new Date(),{testOnly=false}={}) {
  assertTarget(env);
  const pending=await store.pending();
  const result=[];
  for(const d of pending) {
    if(testOnly&&d.target_chat_id!==env.ALLOWED_TARGET_CHAT_ID)continue;
    assertDeliveryTarget(env,d.target_chat_id,now);
    if(d.state==='sending') { await store.mark(d.id,'unknown',null,'上次请求没有留下确定回执，需要核对'); continue; }
    if(d.state==='unknown') continue;
    if(d.attempts>=3) continue;
    if(d.state==='failed'&&now.getTime()-Date.parse(d.updated_at)<60000) continue;
    await store.mark(d.id,'sending');
    try {
      const receipt=await api.sendCard(JSON.parse(d.card),d.uuid,d.target_chat_id);
      if(!receipt?.message_id || receipt.chat_id!==d.target_chat_id) throw new Error('飞书回执不完整或目标不匹配');
      await store.mark(d.id,'sent',receipt.message_id);
      await store.set(`card_issues:${receipt.message_id}`,await store.state(`queue_issues:${d.id}`)||[]);
      result.push({id:d.id,message_id:receipt.message_id});
    } catch(error) {
      await store.mark(d.id,error.confirmed?'failed':'unknown',null,error.message);
      // Only explicit platform rejection is eligible for a later retry.
      await store.event('delivery_error',{id:d.id,confirmed:!!error.confirmed,error:error.message});
    }
  }
  return result;
}
export async function queueSlot(env,store,data,{id,scheduled_at},prefix='schedule',now=new Date()) {
  const key=`${prefix}:${scheduled_at.slice(0,10)}:${id}`;
  if(await store.state(`queued:${key}`)) return key;
  const route=deliveryRoute(env,now,{test:prefix!=='schedule'});
  const scope=data.ledger?{issues:data.issues,scopeLabel:TABLE_SCOPE}:await scopedData(store,data.issues,id,now,true);
  const pages=buildCardPages(scope.issues,{slot:id,now,cutoff:data.cutoff,members:data.members,botName:env.BOT_NAME,test:route.test,scopeLabel:scope.scopeLabel,tableUrl:data.ledger?env.BASE_TABLE_URL:null,actions:cardActionsEnabled(env)});
  for(const [index,{card,issues}] of pages.entries()){const deliveryId=`${key}:${index+1}`;await store.queue({id:deliveryId,slot:id,scheduled_at,card,page:index+1,total_pages:pages.length,target:route.target_chat_id});await store.set(`queue_issues:${deliveryId}`,issues.map(i=>i.id));}
  await store.set(`queued:${key}`,{pages:pages.length,time:new Date().toISOString()});
  return key;
}
async function incident(env,store,api,error,notify=true) {
  const info={time:new Date().toISOString(),message:error.message,alert_key:`run:${localTime().slice(0,10)}:${await hash(error.message)}`};
  await store.set('last_error',info);
  await store.event('run_error',info);
  if(!notify||!env.ALERT_OWNER_OPEN_ID)return;
  await notifyOwner(env,store,api,{key:info.alert_key,title:'运行或汇总投递异常',detail:`${error.message}\n已保留处理进度，未确认送达的正式卡片不会盲目重发。`});
}
export async function tick(env,{now=new Date(),force=false,sendTest=null,maintenance=false,api=new Feishu(env)}={}) {
  assertTarget(env);
  const store=new Store(env.DB);
  const owner=await store.lock(now.getTime());
  if(!owner) return {busy:true};
  try {
    await checkExternalMonitor(env,store,api,now);
    const cardJobs=await processCardActions(env,store,api,{now});
    if(env.ALERT_OWNER_OPEN_ID)await notifyCardFailures(env,store,api,cardJobs,now);
    await store.set('last_tick',now.toISOString());
    const schedule=await store.state('schedule');
    const enabled=schedule?.enabled===true;
    if(!enabled&&!force&&!sendTest) return {paused:true};
    if(!await store.state('tracking_policy'))await store.set('tracking_policy',{start_day:previousPeriodStart(now),started_at:now.toISOString()});
    const weekend=!force&&!sendTest&&!isWeekday(now);
    const automatic=enabled&&!sendTest&&!maintenance&&!weekend;
    const due=automatic?dueSlots(now,schedule.enabled_at):[];
    const preparationDue=automatic?dueSlots(new Date(now.getTime()+10*60000),schedule.enabled_at):[];
    const unsent=[],toPrepare=[];
    for(const slot of due)if(!await store.state(`queued:schedule:${slot.scheduled_at.slice(0,10)}:${slot.id}`))unsent.push(slot);
    for(const slot of preparationDue){
      const key=`schedule:${slot.scheduled_at.slice(0,10)}:${slot.id}`;
      if(!await store.state(`queued:${key}`)&&!await store.state(`prepared:${key}`))toPrepare.push(slot);
    }
    let data;
    // One preparation per slot; a missed/failed wake-up catches up before delivery, never from stale AI state.
    if(force||sendTest||toPrepare.length){
      const ledger=ledgerEnabled(env)?new BaseLedger(api,env):null;
      const ledgerRows=ledger?await ledger.records():null;
      await processCommands(env,store,api,now);
      data=await sync(env,store,api,now,ledgerRows);
      if(ledger){
        const policy=await store.state('tracking_policy'),cached=await store.rows('issues');
        const active=cached.filter(i=>localTime(new Date(i.created_at)).slice(0,10)>=policy.start_day);
        const result=await syncLedger({ledger,store,issues:active,members:await store.state('members')||{},messages:await store.rows('messages'),now});
        data={issues:tableIssues(result.rows,{issues:cached,members:await store.state('members')||{},tableUrl:env.BASE_TABLE_URL}),members:await store.state('members')||{},cutoff:now,ledger:true};
      }
      for(const slot of toPrepare)await store.set(`prepared:schedule:${slot.scheduled_at.slice(0,10)}:${slot.id}`,{time:now.toISOString(),message_cutoff:await store.state('last_sync')});
    }
    if(weekend)return {weekend:true};
    // Manual table edits after preparation take precedence; delivery itself does not query chats or run AI.
    if(unsent.length)data=ledgerEnabled(env)?await tableData(env,store,api):{issues:await store.rows('issues'),members:await store.state('members')||{},cutoff:new Date(await store.state('last_sync'))};
    if(sendTest) await queueSlot(env,store,data,{id:sendTest.slot,scheduled_at:now.toISOString()},`test-${sendTest.request_id}`,now);
    for(const slot of unsent) await queueSlot(env,store,data,slot,'schedule',now);
    const receipts=await sendQueued(store,api,env,now,{testOnly:!!sendTest||maintenance});
    const unresolved=(await store.pending()).filter(d=>['unknown','sending'].includes(d.state)||d.attempts>=3);
    if(unresolved.length) throw new Error(`有${unresolved.length}条提醒发送结果待核对或重试次数用尽`);
    return {ok:true,synced:!!data,receipts,open_issues:data?(data.ledger?data.issues:(await scopedData(store,await store.rows('issues'),sendTest?.slot||'1600',now)).issues).filter(i=>!isResolved(i.status)).length:undefined};
  } catch(error) { await store.event('error_diagnostic',{message:error.message,stack:error.stack});await incident(env,store,api,error); throw error; }
  finally { await store.unlock(owner); }
}
async function authorized(request,env) {
  if(!env.ADMIN_TOKEN) return false;
  const actual=request.headers.get('Authorization')||'';
  const [a,b]=await Promise.all([hash(actual),hash(`Bearer ${env.ADMIN_TOKEN}`)]);
  return a===b;
}
export default {
  async scheduled(controller,env,ctx) {
    ctx.waitUntil(tick(env).catch(error=>{console.error(JSON.stringify({type:'run_failed',message:error.message}));throw error;}));
  },
  async fetch(request,env,ctx) {
    const url=new URL(request.url);
    if(url.pathname==='/monitor/heartbeat'&&request.method==='POST') {
      if(!await monitorAuthorized(request,env))return new Response('Unauthorized',{status:401});
      const time=new Date().toISOString();await new Store(env.DB).set('external_monitor_heartbeat',{time});
      return Response.json({ok:true,time},{headers:{'Cache-Control':'no-store'}});
    }
    if(url.pathname==='/monitor/health'&&request.method==='GET') {
      if(!await monitorAuthorized(request,env))return new Response('Unauthorized',{status:401});
      try{return Response.json(await monitorStatus(env,new Store(env.DB),{build:BUILD}),{headers:{'Cache-Control':'no-store'}});}
      catch {return Response.json({ok:false,checked_at:new Date().toISOString(),faults:[{key:'monitor_read_error',message:'无法读取机器人运行状态'}]},{status:503,headers:{'Cache-Control':'no-store'}});}
    }
    if(url.pathname==='/feishu/card-actions'&&request.method==='POST') {
      try {
        const body=await decodeCardCallback(request,env);
        ctx?.waitUntil(new Store(env.DB).set('last_card_callback_received',{time:new Date().toISOString(),type:body.challenge?'url_verification':'card.action.trigger'}));
        if(body.challenge)return Response.json(body);
        const job=await acceptCardAction(body,env,new Store(env.DB));
        if(['done','already_resolved','failed'].includes(job.state))return Response.json(actionResponse(job));
        const work=env.SCHEDULER.get(env.SCHEDULER.idFromName('test-group')).fetch('https://scheduler/card-action',{method:'POST',body:JSON.stringify({event_id:job.event_id})}).then(r=>r.json()).then(r=>r.jobs?.[0]||job);
        ctx.waitUntil(work.catch(error=>new Store(env.DB).set('last_card_action_error',{event_id:job.event_id,error:error.message,time:new Date().toISOString()})));
        let timer;try{return Response.json(actionResponse(await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>resolve(job),2000);})])));}finally{clearTimeout(timer);}
      }catch(error){return Response.json({error:error.status===403?error.message:'卡片操作尚未确认，请稍后重试'},{status:error.status||500});}
    }
    if(url.pathname==='/health'&&request.method==='GET') return Response.json({service:env.BOT_NAME,mode:deliveryRoute(env).mode,production_start_at:env.PRODUCTION_START_AT||null,timezone:'Asia/Shanghai',weekdays:[1,2,3,4,5],slots:SLOTS.map(s=>({time:s.time,title:s.title}))});
    if(!url.pathname.startsWith('/admin/')||!await authorized(request,env)) return new Response('Unauthorized',{status:401});
    const store=new Store(env.DB);
    try {
      assertTarget(env);
      if(url.pathname==='/admin/status'&&request.method==='GET') {
        const scheduler=env.SCHEDULER.get(env.SCHEDULER.idFromName('test-group'));
        const alarm=await (await scheduler.fetch('https://scheduler/status')).json();
        const all=await store.rows('issues');const scope=ledgerEnabled(env)?await tableData(env,store):await scopedData(store,all,'1600',new Date());
        const route=deliveryRoute(env);
        return Response.json({build:BUILD,schedule:await store.state('schedule'),alarm,card_actions:{enabled:cardActionsEnabled(env),last_callback_received:await store.state('last_card_callback_received'),last_action:await store.state('last_card_action'),last_error:await store.state('last_card_action_error')},ledger:{enabled:ledgerEnabled(env),last_sync:await store.state('last_ledger_sync'),table_url:env.BASE_TABLE_URL||null},rollout:{...route,test_chat_id:env.TARGET_CHAT_ID,production_chat_id:env.PRODUCTION_CHAT_ID||null,production_start_at:env.PRODUCTION_START_AT||null},tracking_policy:await store.state('tracking_policy'),analysis_progress:await store.state('analysis_progress'),last_tick:await store.state('last_tick'),last_sync:await store.state('last_sync'),last_ai:await store.state('last_ai'),last_command:await store.state('last_command'),last_error:await store.state('last_error'),archived_issue_count:Math.max(0,all.length-scope.issues.length),issues:scope.issues.map(i=>({title:i.title,status:i.status,created_at:i.created_at,record_id:i.record_id,manual:i.manual})),deliveries:(await env.DB.prepare('SELECT id,slot,state,message_id,target_chat_id,attempts,updated_at,error FROM deliveries ORDER BY updated_at DESC LIMIT 30').all()).results,target_chat_id:route.target_chat_id});
      }
      if(url.pathname==='/admin/sync'&&request.method==='POST') return env.SCHEDULER.get(env.SCHEDULER.idFromName('test-group')).fetch('https://scheduler/sync',{method:'POST'});
      if(url.pathname==='/admin/connectivity'&&request.method==='POST') return env.SCHEDULER.get(env.SCHEDULER.idFromName('test-group')).fetch('https://scheduler/connectivity',{method:'POST'});
      if(url.pathname==='/admin/send-test'&&request.method==='POST') {
        const body=await request.json();
        if(!SLOTS.some(s=>s.id===body.slot)||!/^[a-z0-9_-]{1,40}$/i.test(body.request_id||'')) return Response.json({error:'需要有效节点和本次测试标识'},{status:400});
        return env.SCHEDULER.get(env.SCHEDULER.idFromName('test-group')).fetch('https://scheduler/send-test',{method:'POST',body:JSON.stringify(body)});
      }
      if(url.pathname==='/admin/preview'&&request.method==='GET') {
        const cutoff=await store.state('last_sync'); if(!cutoff) throw new Error('尚未同步消息');
        const slot=url.searchParams.get('slot')||'1600',now=url.searchParams.has('at')?new Date(url.searchParams.get('at')):new Date();
        if(!Number.isFinite(now.getTime()))return Response.json({error:'预览时间无效'},{status:400});
        const route=deliveryRoute(env,now),scope=ledgerEnabled(env)?await tableData(env,store):await scopedData(store,await store.rows('issues'),slot,now);
        return Response.json(buildCards(scope.issues,{slot,now,cutoff:scope.ledger?scope.cutoff:new Date(cutoff),members:await store.state('members')||{},botName:env.BOT_NAME,test:route.test,scopeLabel:scope.ledger?TABLE_SCOPE:scope.scopeLabel,tableUrl:scope.ledger?env.BASE_TABLE_URL:null,actions:cardActionsEnabled(env)}));
      }
      if(['/admin/enable','/admin/disable'].includes(url.pathname)&&request.method==='POST') {
        const enabled=url.pathname.endsWith('enable');
        if(enabled&&(!await store.state('last_sync')||!await store.state('analyzed_signature'))) throw new Error('请先完成同步和AI分析验证');
        const pending=await store.pending();if(enabled&&pending.some(d=>d.state!=='sent')) throw new Error('仍有发送结果未核对，暂不启用定时');
        const schedule={enabled,enabled_at:new Date().toISOString()};await store.set('schedule',schedule);
        const scheduler=env.SCHEDULER.get(env.SCHEDULER.idFromName('test-group'));
        await scheduler.fetch(`https://scheduler/${enabled?'start':'stop'}`,{method:'POST'});
        await store.event('schedule',schedule);return Response.json(schedule);
      }
      return new Response('Not found',{status:404});
    } catch(error) { return Response.json({error:error.message,stack:error.stack},{status:500}); }
  }
};

// Persistent alarms do not consume the account's limited Cron Trigger slots.
export class Scheduler {
  constructor(ctx,env) { this.ctx=ctx; this.env=env; }
  async runCardActions(eventId=null) {
    const store=new Store(this.env.DB),owner=await store.lock(Date.now());if(!owner)return {busy:true,jobs:[]};
    try{const api=new Feishu(this.env),jobs=await processCardActions(this.env,store,api,{eventId});if(this.env.ALERT_OWNER_OPEN_ID)await notifyCardFailures(this.env,store,api,jobs);return {jobs};}finally{await store.unlock(owner);}
  }
  async fetch(request) {
    const path=new URL(request.url).pathname;
    try {
      if(path==='/connectivity') {
        const started=Date.now();
        const response=await fetch(`${this.env.MIMO_BASE_URL}/chat/completions`,{method:'POST',headers:{'api-key':this.env.MIMO_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:this.env.MIMO_MODEL,messages:[{role:'user',content:'只返回JSON：{"connected":true}'}],thinking:{type:'disabled'},response_format:{type:'json_object'},max_completion_tokens:64}),signal:AbortSignal.timeout(20000)});
        const data=await response.json();return Response.json({status:response.status,elapsed_ms:Date.now()-started,model:data.model,content:data.choices?.[0]?.message?.content,error:data.error?.code});
      }
      if(path==='/sync') { this.ctx.waitUntil(tick(this.env,{force:true,maintenance:true}).catch(error=>console.error(JSON.stringify({type:'sync_error',message:error.message}))));return Response.json({accepted:true,check:'/admin/status'},{status:202}); }
      if(path==='/card-action') {
        await this.ctx.storage.setAlarm(Math.floor(Date.now()/60000)*60000+60000);
        return Response.json(await this.runCardActions((await request.json()).event_id));
      }
      if(path==='/send-test') return Response.json(await tick(this.env,{sendTest:await request.json()}));
    } catch(error) { return Response.json({error:error.message,stack:error.stack},{status:500}); }
    if(path==='/start') await this.ctx.storage.setAlarm(Math.floor(Date.now()/60000)*60000+60000);
    else if(path==='/stop') await this.ctx.storage.deleteAlarm();
    return Response.json({build:BUILD,card_actions_enabled:cardActionsEnabled(this.env),next_alarm:await this.ctx.storage.getAlarm(),mechanism:'cloudflare-durable-alarm'});
  }
  async alarm() {
    const schedule=await new Store(this.env.DB).state('schedule');
    if(!schedule?.enabled) {
      const store=new Store(this.env.DB),pending=await store.db.prepare("SELECT count(*) AS n FROM state WHERE key GLOB 'card_action:*' AND json_extract(value,'$.state') IN ('queued','updating','refresh_pending')").first();
      if(!pending.n)return;
      await this.ctx.storage.setAlarm(Math.floor(Date.now()/60000)*60000+60000);await this.runCardActions();return;
    }
    // Set the next alarm before network/model work, so one failed cycle cannot stop future cycles.
    await this.ctx.storage.setAlarm(Math.floor(Date.now()/60000)*60000+60000);
    await tick(this.env);
  }
}
