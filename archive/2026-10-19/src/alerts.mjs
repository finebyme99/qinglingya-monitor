import { hash, localTime } from './core.mjs';

export async function notifyOwner(env,store,api,{key,title,detail,now=new Date()}) {
  if(!/^ou_[a-zA-Z0-9]+$/.test(env.ALERT_OWNER_OPEN_ID||''))throw new Error('未配置唯一的告警接收人');
  const stateKey=`owner_alert:${await hash(key)}`;
  const previous=await store.state(stateKey);
  if(previous&&['sent','sending','unknown'].includes(previous.state))return previous;
  if(env.ALERT_NOTIFICATIONS_ENABLED==='false') {
    if(previous?.state==='suppressed')return previous;
    const record={key,title,time:now.toISOString(),state:'suppressed'};
    await store.set(stateKey,record);await store.set('last_owner_alert',record);
    return record;
  }
  if(previous?.next_attempt&&Date.parse(previous.next_attempt)>now.getTime())return previous;
  const text=`【${env.BOT_NAME||'系统问题清零鸭'}异常提醒】${title}\n${localTime(now)}\n${String(detail).slice(0,1200)}\n仅私信通知你；正式群不会额外发消息。`;
  const record={key,title,time:now.toISOString(),state:'sending',uuid:crypto.randomUUID(),recipient:env.ALERT_OWNER_OPEN_ID,content_hash:await hash(text),attempts:(previous?.attempts||0)+1};
  await store.set(stateKey,record);
  try {
    const receipt=await api.call('/im/v1/messages',{method:'POST',params:{receive_id_type:'open_id'},data:{receive_id:env.ALERT_OWNER_OPEN_ID,msg_type:'text',content:JSON.stringify({text}),uuid:record.uuid}});
    if(!receipt?.message_id)throw new Error('私信回执缺少消息ID');
    Object.assign(record,{state:'sent',message_id:receipt.message_id});
  }catch(error){Object.assign(record,{state:error.confirmed?'rejected':'unknown',error:error.message,next_attempt:new Date(now.getTime()+15*60000).toISOString()});}
  await store.set(stateKey,record);await store.set('last_owner_alert',record);
  return record;
}

export async function notifyCardFailures(env,store,api,jobs,now=new Date()) {
  for(const job of jobs)if(job.error)await notifyOwner(env,store,api,{key:`card:${job.event_id}`,title:job.data_saved_at?'已解决已记录，卡片刷新异常':'完成按钮处理异常',detail:`事件：${job.event_id}\n${job.error}\n${job.state==='failed'?'自动重试已停止，需核查；不要盲目重复操作。':'已保留任务，稍后自动核对和重试。'}`,now});
}

export async function checkExternalMonitor(env,store,api,now=new Date()) {
  if(!env.MONITORING_ENABLED_AT||!env.ALERT_OWNER_OPEN_ID)return;
  const heartbeat=await store.state('external_monitor_heartbeat');
  const last=heartbeat?.time||env.MONITORING_ENABLED_AT;
  if(now.getTime()-Date.parse(last)>90*60000)await notifyOwner(env,store,api,{key:`external-monitor:${last}`,title:'外部监测超过90分钟未回报',detail:'独立探测可能因GitHub排队、免费分钟用尽或任务异常而停摆。机器人自身仍在运行，请查看独立监测工作流。',now});
}
