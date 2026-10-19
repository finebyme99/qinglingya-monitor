import test from 'node:test';import assert from 'node:assert/strict';import{DatabaseSync}from'node:sqlite';import{readFileSync}from'node:fs';
import{Store}from'../src/store.mjs';import{notifyOwner,notifyCardFailures,checkExternalMonitor}from'../src/alerts.mjs';import{monitorStatus,monitorAuthorized}from'../src/monitor.mjs';import worker,{tick} from'../src/worker.mjs';
function database(){const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));return {prepare(query){let args=[];return {bind(...a){args=a;return this;},async first(){return sql.prepare(query).get(...args)||null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){const r=sql.prepare(query).run(...args);return{meta:{changes:Number(r.changes)}};}};}};}
const now=new Date('2026-10-16T04:00:00Z'),env={BOT_NAME:'测试鸭',ALERT_OWNER_OPEN_ID:'ou_owner',PRODUCTION_CHAT_ID:'oc_formal',PRODUCTION_START_AT:'2026-10-16T01:30:00Z',MONITOR_TOKEN:'test-monitor-only'};
async function fixture(){const DB=database(),store=new Store(DB);await store.set('schedule',{enabled:true,enabled_at:'2026-10-15T00:00:00Z'});await store.set('last_tick',now.toISOString());await store.set('queued:schedule:2026-10-16:0930',{pages:2});for(let page=1;page<=2;page++){const id=`schedule:2026-10-16:0930:${page}`;await store.queue({id,slot:'0930',scheduled_at:'2026-10-16T01:30:00Z',card:{},page,total_pages:2,target:'oc_formal'});await store.mark(id,'sent','om_'+page);}return{DB,store};}
test('异常只发固定本人open_id，并在发送前落台账；同一异常不重复提醒',async()=>{const{store}=await fixture();let calls=0;const api={async call(path,opts){calls++;assert.equal(opts.params.receive_id_type,'open_id');assert.equal(opts.data.receive_id,'ou_owner');assert.ok(JSON.stringify(opts.data).includes('仅私信'));const rows=(await store.db.prepare("SELECT value FROM state WHERE key GLOB 'owner_alert:*'").all()).results;assert.equal(JSON.parse(rows[0].value).state,'sending');return{message_id:'om_dm'};}};const data={key:'same',title:'测试故障',detail:'演练',now};await notifyOwner(env,store,api,data);await notifyOwner(env,store,api,data);assert.equal(calls,1);assert.equal((await store.state('last_owner_alert')).message_id,'om_dm');});
test('未知私信回执不盲目重发；明确拒绝冷却后再尝试',async()=>{for(const confirmed of [false,true]){const{store}=await fixture();let calls=0;const api={async call(){calls++;throw Object.assign(new Error('failure'),{confirmed});}};const data={key:'err',title:'失败',detail:'演练',now};assert.equal((await notifyOwner(env,store,api,data)).state,confirmed?'rejected':'unknown');await notifyOwner(env,store,api,data);assert.equal(calls,1);await notifyOwner(env,store,api,{...data,now:new Date(now.getTime()+16*60000)});assert.equal(calls,confirmed?2:1);}});
test('按钮任务失败只私信，记录已写入时说明卡片显示待恢复',async()=>{const{store}=await fixture();const texts=[];await notifyCardFailures(env,store,{async call(p,o){texts.push(JSON.parse(o.data.content).text);return{message_id:'om_private'};}},[{event_id:'event_example',error:'patch error',state:'refresh_pending',data_saved_at:now.toISOString()}],now);assert.match(texts[0],/已解决已记录/);});
test('只读健康检查核对完整页码、正式群回执，不能拿测试群回执充成功',async()=>{const{store}=await fixture();assert.equal((await monitorStatus(env,store,{now})).ok,true);await store.db.prepare("UPDATE deliveries SET target_chat_id='oc_test' WHERE page=2").run();const status=await monitorStatus(env,store,{now});assert.equal(status.ok,false);assert.equal(status.faults[0].sent,1);assert.equal(status.faults[0].total,2);});
test('未建单、缺页、按钮停滞、定时停摆均能检测；周末不误报未推送',async()=>{const{store}=await fixture();await store.db.prepare('DELETE FROM deliveries WHERE page=2').run();assert.match((await monitorStatus(env,store,{now})).faults[0].key,/delivery/);await store.set('card_action:stuck',{event_id:'stuck',state:'queued',time:'2026-10-16T03:50:00Z'});await store.set('last_tick','2026-10-16T03:40:00Z');const f=(await monitorStatus(env,store,{now})).faults;assert.ok(f.some(x=>x.key==='tick_stalled'));assert.ok(f.some(x=>x.key==='card:stuck'));const saturday=new Date('2026-10-17T04:00:00Z');assert.ok(!(await monitorStatus(env,store,{now:saturday})).faults.some(x=>x.key.startsWith('delivery:')));});
test('监测密钥不能访问管理接口，匿名健康接口不泄露状态',async()=>{const{DB}=await fixture();const e={...env,DB,ADMIN_TOKEN:'separate-admin'};assert.equal(await monitorAuthorized(new Request('https://x/monitor/health',{headers:{Authorization:'Bearer test-monitor-only'}}),e),true);assert.equal((await worker.fetch(new Request('https://x/monitor/health'),e)).status,401);assert.equal((await worker.fetch(new Request('https://x/admin/status',{headers:{Authorization:'Bearer test-monitor-only'}}),e)).status,401);const r=await worker.fetch(new Request('https://x/monitor/health',{headers:{Authorization:'Bearer test-monitor-only'}}),e);const body=await r.text();assert.ok(!body.includes('separate-admin'));assert.ok(!body.includes('test-monitor-only'));assert.ok(!body.includes('issues'));});
test('外部探测停止超过90分钟时机器人私信本人，健康期与重复检查不打扰',async()=>{const{store}=await fixture();const{checkExternalMonitor}=await import('../src/alerts.mjs');let sends=0;const api={async call(p,o){sends++;assert.equal(o.params.receive_id_type,'open_id');return{message_id:'om_monitor_stalled'};}};const e={...env,MONITORING_ENABLED_AT:'2026-10-16T02:00:00Z'};await checkExternalMonitor(e,store,api,now);await checkExternalMonitor(e,store,api,now);assert.equal(sends,1);await store.set('external_monitor_heartbeat',{time:now.toISOString()});await checkExternalMonitor(e,store,api,now);assert.equal(sends,1);});
test('监测心跳只记录服务端时间，不接受业务状态或收件人；转接入口不能访问管理接口',async()=>{const{DB,store}=await fixture();const e={...env,DB};assert.equal((await worker.fetch(new Request('https://x/monitor/heartbeat',{method:'POST'}),e)).status,401);const r=await worker.fetch(new Request('https://x/monitor/heartbeat',{method:'POST',headers:{Authorization:'Bearer test-monitor-only'},body:JSON.stringify({schedule:{enabled:false},recipient:'oc_formal'})}),e);assert.equal(r.status,200);assert.equal((await store.state('schedule')).enabled,true);assert.deepEqual(Object.keys(await store.state('external_monitor_heartbeat')),['time']);const bridge=(await import('../callback-bridge/public/_worker.js')).default;let forwarded=0;const BOT={async fetch(){forwarded++;return new Response('ok');}};assert.equal((await bridge.fetch(new Request('https://x/admin/disable',{method:'POST'}),{BOT})).status,404);assert.equal(forwarded,0);assert.equal((await bridge.fetch(new Request('https://x/monitor/health'),{BOT})).status,200);assert.equal((await bridge.fetch(new Request('https://x/monitor/heartbeat',{method:'POST'}),{BOT})).status,200);assert.equal(forwarded,2);});

test('关闭异常私信覆盖运行、按钮和外部心跳告警，未发送不记sent，重新开启仍可通知',async()=>{
 const{store}=await fixture();let calls=0;
 const api={async call(){calls++;return{message_id:'om_reenabled'};}};
 const muted={...env,ALERT_NOTIFICATIONS_ENABLED:'false',MONITORING_ENABLED_AT:'2026-10-16T02:00:00Z'};
 const data={key:'muted-run',title:'运行异常',detail:'虚构故障',now};
 const first=await notifyOwner(muted,store,api,data);
 assert.equal(first.state,'suppressed');assert.equal(first.message_id,undefined);
 assert.deepEqual(await notifyOwner(muted,store,api,data),first);
 await store.set('card_action:muted-card',{event_id:'muted-card',state:'failed',error:'虚构刷新失败',time:now.toISOString()});
 await notifyCardFailures(muted,store,api,[await store.state('card_action:muted-card')],now);
 await checkExternalMonitor(muted,store,api,now);
 assert.equal(calls,0);
 const alerts=(await store.db.prepare("SELECT value FROM state WHERE key GLOB 'owner_alert:*'").all()).results.map(r=>JSON.parse(r.value));
 assert.equal(alerts.length,3);assert.ok(alerts.every(a=>a.state==='suppressed'&&!a.message_id));
 assert.ok((await monitorStatus(muted,store,{now})).faults.some(f=>f.key==='card:muted-card'));
 assert.equal((await store.state('schedule')).enabled,true);
 assert.equal((await notifyOwner({...muted,ALERT_NOTIFICATIONS_ENABLED:'true'},store,api,data)).state,'sent');
 assert.equal(calls,1);
});

test('关闭异常私信后真实运行失败仍抛错、记录故障并保留运行心跳和计划',async()=>{
 const{DB,store}=await fixture();let privateCalls=0;
 const muted={...env,DB,TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test',SOURCE_CHAT_ID:'oc_formal',ALERT_NOTIFICATIONS_ENABLED:'false'};
 const api={async members(){throw new Error('虚构群消息读取失败');},async call(){privateCalls++;throw new Error('不应发送私信');}};
 await assert.rejects(()=>tick(muted,{now,api}),/虚构群消息读取失败/);
 assert.equal(privateCalls,0);
 assert.equal((await store.state('last_error')).message,'虚构群消息读取失败');
 assert.equal((await store.db.prepare("SELECT count(*) AS n FROM events WHERE type='run_error'").first()).n,1);
 assert.equal(await store.state('last_tick'),now.toISOString());
 assert.equal((await store.state('schedule')).enabled,true);
 assert.ok((await monitorStatus(muted,store,{now})).faults.some(f=>f.key==='run_error'));
});

test('关闭异常私信后定时业务汇总照常投递、健康检查和监控心跳仍可用',async()=>{
 const{DB,store}=await fixture();let businessSends=0,privateCalls=0;
 const muted={...env,DB,TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test',SOURCE_CHAT_ID:'oc_formal',ALERT_NOTIFICATIONS_ENABLED:'false'};
 const at=new Date('2026-10-16T05:30:00Z');
 const api={async members(){return{};},async list(){return[];},async expandForwards(m){return m;},async call(){privateCalls++;throw new Error('不应发送私信');},async sendCard(card,uuid,target){businessSends++;assert.equal(target,'oc_formal');return{message_id:'om_normal_business',chat_id:target};}};
 assert.equal((await tick(muted,{now:at,api})).ok,true);
 assert.equal(businessSends,1);assert.equal(privateCalls,0);
 assert.equal((await store.delivery('schedule:2026-10-16:1330:1')).state,'sent');
 assert.equal(await store.state('last_sync'),at.toISOString());
 assert.equal((await monitorStatus(muted,store,{now:at})).ok,true);
 const heartbeat=await worker.fetch(new Request('https://x/monitor/heartbeat',{method:'POST',headers:{Authorization:'Bearer test-monitor-only'}}),muted);
 assert.equal(heartbeat.status,200);assert.ok((await store.state('external_monitor_heartbeat')).time);
});
