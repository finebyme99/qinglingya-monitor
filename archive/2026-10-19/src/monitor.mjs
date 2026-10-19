import { dueSlots, hash } from './core.mjs';

export async function monitorAuthorized(request,env) {
  if(!env.MONITOR_TOKEN)return false;
  return await hash(request.headers.get('Authorization')||'')===await hash(`Bearer ${env.MONITOR_TOKEN}`);
}

// Read-only operational summary: never fetch business messages, call AI, send, or expose issues.
export async function monitorStatus(env,store,{now=new Date(),build='unknown'}={}) {
  const [schedule,lastTick,lastError,lastAlert]=await Promise.all(['schedule','last_tick','last_error','last_owner_alert'].map(key=>store.state(key)));
  const faults=[];
  if(!schedule?.enabled)faults.push({key:'schedule_disabled',message:'定时计划未启用'});
  if(!lastTick||now.getTime()-Date.parse(lastTick)>10*60000)faults.push({key:'tick_stalled',message:'超过10分钟未完成运行心跳'});
  if(lastError){const sent=lastError.alert_key?await store.state(`owner_alert:${await hash(lastError.alert_key)}`):null;faults.push({key:'run_error',message:'最近一轮运行异常',notified:sent?.state==='sent'});}
  const cardJobs=(await store.db.prepare("SELECT value FROM state WHERE key GLOB 'card_action:*' AND (json_extract(value,'$.state')='failed' OR json_extract(value,'$.state') IN ('queued','updating','refresh_pending'))").all()).results.map(r=>JSON.parse(r.value));
  for(const job of cardJobs)if(job.state==='failed'||now.getTime()-Date.parse(job.time)>5*60000){
    const notification=await store.state(`owner_alert:${await hash(`card:${job.event_id}`)}`);
    faults.push({key:`card:${job.event_id}`,message:job.data_saved_at?'卡片刷新未完成':'完成按钮任务未完成',notified:notification?.state==='sent'});
  }
  const enabledAt=env.PRODUCTION_START_AT&&Date.parse(env.PRODUCTION_START_AT)>Date.parse(schedule?.enabled_at||0)?env.PRODUCTION_START_AT:schedule?.enabled_at;
  if(schedule?.enabled)for(const slot of dueSlots(new Date(now.getTime()-5*60000),enabledAt)){
    const key=`schedule:${slot.scheduled_at.slice(0,10)}:${slot.id}`,queued=await store.state(`queued:${key}`);
    const rows=(await store.db.prepare('SELECT page,total_pages,state,message_id,target_chat_id FROM deliveries WHERE id LIKE ? ORDER BY page').bind(key+':%').all()).results;
    const expected=queued?.pages;
    if(!expected||rows.length!==expected||rows.some((r,i)=>r.page!==i+1||r.total_pages!==expected||r.state!=='sent'||!r.message_id||r.target_chat_id!==env.PRODUCTION_CHAT_ID))faults.push({key:`delivery:${key}`,message:`${slot.id}汇总尚未确认全部送达`,sent:rows.filter(r=>r.state==='sent'&&r.message_id&&r.target_chat_id===env.PRODUCTION_CHAT_ID).length,total:expected||null});
  }
  return {ok:faults.length===0,build,checked_at:now.toISOString(),schedule_enabled:schedule?.enabled===true,last_tick:lastTick,faults,notification_problem:lastAlert&&['unknown','rejected'].includes(lastAlert.state)?{state:lastAlert.state,time:lastAlert.time}:null};
}
