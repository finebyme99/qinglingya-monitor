import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const OWNER='ou_0121f356ab8eee1a18ebe80794302bf1';
const ACCOUNT='f0cfb029f521007125f8d199b0876f4b',ORIGIN='https://hris-qinglingya-callback.pages.dev';
const digest=v=>createHash('sha256').update(v).digest('hex');
export function usageFaults(usage,day){
 const faults=[];
 for(const [name,value,limit] of [['Workers请求',usage.requests,100000],['D1读取行',usage.rowsRead,5000000],['D1写入行',usage.rowsWritten,100000],['Durable Objects请求',usage.doRequests,100000],['Durable Objects运行时长GB秒',usage.doDuration,13000],['Durable Objects读取行',usage.doRowsRead,5000000],['Durable Objects写入行',usage.doRowsWritten,100000]]){
  if(!Number.isFinite(value)||value<0)throw new Error('用量数据不完整');
  const level=value>=limit?100:value>=limit*.95?95:value>=limit*.8?80:0;
  if(level)faults.push({key:`quota:${day}:${name}:${level}`,message:`${name}达到${level}%预警线：${Math.round(value).toLocaleString('zh-CN')} / ${limit.toLocaleString('zh-CN')}，每天北京时间08:00重置。`});
 }
 return faults;
}
export async function jsonRequest(url,options={},request=fetch){
 const r=await request(url,{...options,signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw new Error(`HTTP ${r.status}`);
 return r.json();
}
export async function probe(env,request=fetch){
 const nonce=randomUUID(),start=Date.now();
 let last;
 for(let attempt=0;attempt<2;attempt++){
  try{
   const d=await jsonRequest(ORIGIN+'/feishu/card-actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'url_verification',token:env.FEISHU_VERIFICATION_TOKEN,challenge:nonce})},request);
   if(d.challenge!==nonce)throw new Error('回调校验响应不匹配');
   return {elapsed_ms:Date.now()-start};
  }catch(e){last=e;}
 }
 throw new Error(`回调入口连续两次探测失败（${last?.message||'未知错误'}）`);
}
export async function accountUsage(env,now=new Date(),request=fetch){
 const day=now.toISOString().slice(0,10),query=`query { viewer { accounts(filter:{accountTag:"${ACCOUNT}"}) { workersInvocationsAdaptive(limit:100,filter:{datetime_geq:"${day}T00:00:00Z",datetime_lt:"${now.toISOString()}"}) { sum { requests errors } } pagesFunctionsInvocationsAdaptiveGroups(limit:100,filter:{datetime_geq:"${day}T00:00:00Z",datetime_lt:"${now.toISOString()}"}) { sum { requests } } d1AnalyticsAdaptiveGroups(limit:100,filter:{date_geq:"${day}",date_leq:"${day}"}) { sum { rowsRead rowsWritten } } durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{date_geq:"${day}",date_leq:"${day}"}) { sum { requests } } durableObjectsPeriodicGroups(limit:100,filter:{datetime_geq:"${day}T00:00:00Z",datetime_lt:"${now.toISOString()}"}) { sum { duration rowsRead rowsWritten } } } } }`;
 const d=await jsonRequest('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({query})},request);
 if(d.errors?.length)throw new Error('Cloudflare用量查询被拒绝或返回异常');
 const a=d.data?.viewer?.accounts;if(a?.length!==1)throw new Error('Cloudflare用量账号不完整');
 const sum=(group,key)=>{if(!Array.isArray(group))throw new Error('Cloudflare用量缺失');return group.reduce((n,r)=>{const v=r.sum?.[key];if(!Number.isFinite(v))throw new Error('Cloudflare用量字段缺失');return n+v;},0);};
 const workerRequests=sum(a[0].workersInvocationsAdaptive,'requests'),pagesRequests=sum(a[0].pagesFunctionsInvocationsAdaptiveGroups,'requests');
 return {day,requests:workerRequests+pagesRequests,workerRequests,pagesRequests,rowsRead:sum(a[0].d1AnalyticsAdaptiveGroups,'rowsRead'),rowsWritten:sum(a[0].d1AnalyticsAdaptiveGroups,'rowsWritten'),doRequests:sum(a[0].durableObjectsInvocationsAdaptiveGroups,'requests'),doDuration:sum(a[0].durableObjectsPeriodicGroups,'duration'),doRowsRead:sum(a[0].durableObjectsPeriodicGroups,'rowsRead'),doRowsWritten:sum(a[0].durableObjectsPeriodicGroups,'rowsWritten'),source:'Cloudflare GraphQL Analytics; Workers + Pages account totals; UTC day; analytics may lag or be sampled'};
}
export function pendingNotifications(faults,state){return faults.filter(f=>!f.notified&&!['sent','sending','unknown'].includes(state.alerts?.[digest(f.key)]?.state));}
export async function sendPrivate(env,text,uuid,request=fetch){
 if(env.ALERT_OWNER_OPEN_ID!==OWNER)throw new Error('告警收件人校验失败');
 const auth=await jsonRequest('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:env.FEISHU_APP_ID,app_secret:env.FEISHU_APP_SECRET})},request);
 if(auth.code!==0||!auth.tenant_access_token)throw new Error('飞书私信认证失败');
 const receipt=await jsonRequest('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',{method:'POST',headers:{Authorization:`Bearer ${auth.tenant_access_token}`,'Content-Type':'application/json'},body:JSON.stringify({receive_id:OWNER,msg_type:'text',content:JSON.stringify({text}),uuid})},request);
 if(receipt.code!==0||!receipt.data?.message_id)throw new Error(`飞书私信未确认送达（${receipt.code??'无回执'}）`);
 return receipt.data.message_id;
}
export async function run(env,request=fetch){
 for(const k of ['GITHUB_TOKEN','GITHUB_REPOSITORY','MONITOR_TOKEN','FEISHU_APP_ID','FEISHU_APP_SECRET','FEISHU_VERIFICATION_TOKEN','CLOUDFLARE_API_TOKEN'])if(!env[k])throw new Error(`监测配置缺少${k}`);
 if(env.ALERT_OWNER_OPEN_ID!==OWNER)throw new Error('告警收件人校验失败');
 const now=new Date(),faults=[],results={time:now.toISOString()};
 const checks=await Promise.allSettled([probe(env,request),jsonRequest(ORIGIN+'/monitor/health',{headers:{Authorization:`Bearer ${env.MONITOR_TOKEN}`}},request),accountUsage(env,now,request)]);
 if(checks[0].status==='rejected')faults.push({key:'callback_unreachable',message:checks[0].reason.message});
 else {results.probe=checks[0].value;if(results.probe.elapsed_ms>2500)faults.push({key:'callback_slow',message:`回调入口响应偏慢：${results.probe.elapsed_ms}毫秒，接近飞书3秒校验窗口。`});}
 if(checks[1].status==='rejected')faults.push({key:'health_unreadable',message:'无法读取机器人健康状态，入口或鉴权可能异常。'});
 else {const h=checks[1].value;if(typeof h.ok!=='boolean'||!Array.isArray(h.faults))faults.push({key:'health_invalid',message:'健康接口返回结构异常'});else {faults.push(...h.faults);if(h.notification_problem)faults.push({key:'private_notification_failed',message:'机器人内部的异常私信未确认送达，请核查通知权限或接口。'});}results.health={ok:h.ok,build:h.build,last_tick:h.last_tick};}
 if(checks[2].status==='rejected')faults.push({key:'usage_unreadable',message:'Cloudflare额度监测查询失败，不能将缺失数据当作零用量。'});
 else {results.usage=checks[2].value;faults.push(...usageFaults(results.usage,results.usage.day));}
 if(env.MONITOR_DRILL==='true')faults.push({key:'drill:20261016',message:'【演练，无实际故障】入口监测、额度查询和私信告警链路已接通；此消息仅用于验证异常只私信通知你。'});
 const endpoint=`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/issues/${env.MONITOR_STATE_ISSUE||'1'}`;
 const headers={Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'};
 const issue=await jsonRequest(endpoint,{headers},request);
 let state;try{state=JSON.parse(issue.body);}catch{throw new Error('监测去重台账无法解析，停止发送避免重复');}
 if(state.version!==1||!state.alerts)throw new Error('监测去重台账格式无效');
 const active=new Set(faults.map(f=>digest(f.key)));
 // Healthy recovery re-arms faults; quota warnings retain their UTC-day keys for 2 days.
 for(const [key,alert]of Object.entries(state.alerts))if(!active.has(key)&&(!alert.key?.startsWith('quota:')||Date.parse(alert.time)<now.getTime()-2*86400000))delete state.alerts[key];
 const save=async()=>jsonRequest(endpoint,{method:'PATCH',headers,body:JSON.stringify({body:JSON.stringify(state,null,2)})},request);
 const pending=pendingNotifications(faults,state);
 if(pending.length&&env.MONITOR_NOTIFICATIONS_ENABLED!=='false'){
  const uuid=randomUUID(),records=pending.map(f=>({key:f.key,state:'sending',uuid,time:now.toISOString()}));
  records.forEach(a=>state.alerts[digest(a.key)]=a);await save();
  try{const message_id=await sendPrivate(env,`【系统问题清零鸭监测提醒】\n${pending.map(f=>'• '+f.message).join('\n')}\n检测时间：${new Date(now.getTime()+8*3600000).toISOString().slice(0,16).replace('T',' ')}（北京时间）\n正式群未额外发消息。`,uuid,request);records.forEach(a=>Object.assign(a,{state:'sent',message_id}));}
  catch(e){records.forEach(a=>Object.assign(a,{state:'unknown',error:e.message}));await save();throw new Error('异常通知未确认送达，已保留去重台账，请核对本次工作流。');}
  await save();
 }
 state.last_check=results;state.fault_count=faults.length;await save();
 if(checks[1].status==='fulfilled')await jsonRequest(ORIGIN+'/monitor/heartbeat',{method:'POST',headers:{Authorization:`Bearer ${env.MONITOR_TOKEN}`}},request);
 console.log(JSON.stringify({...results,faults:faults.map(f=>({key:f.key,message:f.message,notified:!!f.notified})),notifications:Object.values(state.alerts).filter(a=>a.time===now.toISOString()).map(a=>({state:a.state,message_id:a.message_id}))},null,2));
 if(faults.some(f=>!f.key.startsWith('quota:')&&!f.key.startsWith('drill:')))throw new Error('监测发现异常，已保存检查结果。');
 return results;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)run(process.env).catch(e=>{console.error(e.message);process.exitCode=1;});
