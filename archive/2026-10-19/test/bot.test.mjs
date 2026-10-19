import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dueSlots, assertTarget, assertDeliveryTarget, deliveryRoute, normalize, validateIssues, hash, flatten, analysisInput } from '../src/core.mjs';
import { buildCards } from '../src/card.mjs';
import { Store } from '../src/store.mjs';
import { Feishu, analyze } from '../src/api.mjs';
import worker, { sendQueued, queueSlot, Scheduler, tick, processCommands } from '../src/worker.mjs';
import { analyzeIssues } from '../src/analysis.mjs';
import { scopeIssues, previousPeriodStart, isResolutionCommand, resolveCommand } from '../src/tracking.mjs';

function db() {
  const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  return {prepare(query){let args=[];return {bind(...a){args=a;return this;},async first(){return sql.prepare(query).get(...args)||null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){const r=sql.prepare(query).run(...args);return {meta:{changes:Number(r.changes)}};}};},async batch(statements){sql.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};
}
const root={id:'om_root',chat_id:'oc_source',sender_id:'ou_reporter',sender_type:'user',text:'筛选无法使用，请帮忙修复',created_at:'2026-10-14T01:00:00Z',updated_at:'2026-10-14T01:00:00Z',source_url:'https://applink.feishu.cn/client/chat/open?openChatId=oc_source&position=1',mentions:[{id:'ou_owner'}]};
const fix={...root,id:'om_fix',parent_id:'om_root',sender_id:'ou_owner',text:'已经修复了',created_at:'2026-10-14T02:00:00Z'};
const confirmed={...root,id:'om_confirm',parent_id:'om_fix',sender_id:'ou_reporter',text:'验证恢复正常，确认解决',created_at:'2026-10-14T03:00:00Z'};
const people={ou_reporter:'反馈人',ou_owner:'原跟进人',ou_next:'后续跟进人'};
const issue={root_id:'om_root',facet:'main',title:'筛选无法使用',status:'pending',reporter_id:'ou_reporter',owner_ids:['ou_owner'],note:'等待处理',evidence_ids:['om_root'],closure_message_id:null};
test('三个北京时间节点正确，不会在启动时补发启动前的节点',()=>{
  assert.deepEqual(dueSlots(new Date('2026-10-15T05:30:00Z'),'2026-10-15T00:00:00Z').map(s=>s.id),['0930','1330']);
  assert.equal(dueSlots(new Date('2026-10-15T10:30:00Z'),'2026-10-15T10:00:00Z').length,0);
});
test('北京时间周末不推，跨UTC日期边界仍按北京时间判断',async()=>{
  assert.equal(dueSlots(new Date('2026-10-17T01:30:00Z'),'2026-10-16T00:00:00Z').length,0);
  assert.equal(dueSlots(new Date('2026-10-18T08:00:00Z'),'2026-10-16T00:00:00Z').length,0);
  assert.equal(dueSlots(new Date('2026-10-19T01:30:00Z'),'2026-10-16T00:00:00Z')[0].id,'0930');
  assert.equal(dueSlots(new Date('2026-10-16T16:01:00Z'),'2026-10-16T00:00:00Z').length,0);
  const database=db(),store=new Store(database);await store.set('schedule',{enabled:true,enabled_at:'2026-10-16T00:00:00Z'});
  await store.queue({id:'friday-retry',slot:'1600',scheduled_at:'2026-10-16T08:00:00Z',card:{schema:'2.0'},page:1,total_pages:1,target:'oc_test'});
  const out=await tick({DB:database,TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test',SOURCE_CHAT_ID:'oc_source'},{now:new Date('2026-10-17T01:30:00Z'),api:{sendCard(){throw new Error('周末不应调用');}}});
  assert.equal(out.weekend,true);assert.equal((await store.delivery('friday-retry')).attempts,0);
});
test('目标群白名单拒绝原业务群与请求中的任意群',()=>{
  assert.throws(()=>assertTarget({TARGET_CHAT_ID:'oc_source',ALLOWED_TARGET_CHAT_ID:'oc_source',SOURCE_CHAT_ID:'oc_source'}));
  assert.throws(()=>assertTarget({TARGET_CHAT_ID:'oc_other',ALLOWED_TARGET_CHAT_ID:'oc_test',SOURCE_CHAT_ID:'oc_source'}));
});
test('IT已修复不能代替反馈人确认闭环',()=>{
  const out=validateIssues([{...issue,status:'closed',evidence_ids:['om_root','om_fix'],closure_message_id:'om_fix'}],[root,fix],[],people);
  assert.equal(out[0].status,'waiting_confirmation');
});
test('反馈人在原问题的回复链验证后才能闭环，其他问题的好了不能关闭',()=>{
  assert.equal(validateIssues([{...issue,status:'closed',evidence_ids:['om_root','om_confirm'],closure_message_id:'om_confirm'}],[root,fix,confirmed],[],people)[0].status,'closed');
  assert.equal(validateIssues([{...issue,status:'closed',evidence_ids:['om_root','om_confirm'],closure_message_id:'om_confirm'}],[root,{...confirmed,parent_id:'om_another'}],[],people)[0].status,'waiting_confirmation');
});
test('无需艾特：反馈人在原问题回复链明确确认无误、解决或验收通过即可闭环',()=>{
  for(const text of ['已确认无误','解决了','已解决','验收通过','验证通过','已恢复正常','没问题啦','好了']) {
    const closure={...confirmed,mentions:[],text};
    const raw={...issue,status:'closed',evidence_ids:[root.id,fix.id,closure.id],closure_message_id:closure.id};
    const result=validateIssues([raw],[root,fix,closure],[],people)[0];
    assert.equal(result.status,'closed',text);assert.equal(result.closure_message_id,closure.id);
  }
});
test('无需艾特的确认拦截否定、提问和请求，并按最新口径接受其他同事明确确认',()=>{
  for(const text of ['还未确认无误','没有验收通过','尚未解决','已确认无误？','请确认解决','已解决了吗','明天再确认解决']) {
    const closure={...confirmed,mentions:[],text};
    const raw={...issue,status:'closed',evidence_ids:[root.id,closure.id],closure_message_id:closure.id};
    assert.equal(validateIssues([raw],[root,fix,closure],[],people)[0].status,'waiting_confirmation',text);
  }
  const itClosure={...confirmed,sender_id:'ou_owner',mentions:[],text:'已确认无误'};
  assert.equal(validateIssues([{...issue,status:'closed',evidence_ids:[root.id,itClosure.id],closure_message_id:itClosure.id}],[root,fix,itClosure],[],people)[0].status,'closed');
});
test('转交后仍保留原跟进人，未知人员和虚构原消息被拒绝',()=>{
  const previous=validateIssues([issue],[root],[],people);
  const updated=validateIssues([{...issue,owner_ids:['ou_next']}],[root],previous,people);
  assert.deepEqual(updated[0].owner_ids,['ou_owner','ou_next']);
  assert.throws(()=>validateIssues([{...issue,owner_ids:['ou_fake']}],[root],[],people));
  assert.throws(()=>validateIssues([{...issue,root_id:'om_fake'}],[root],[],people));
});
test('卡片无编号、原生艾特、指标等高配置，跨日遗留优先单卡完整保留',()=>{
  const i=validateIssues([issue],[root],[],people)[0];
  const cards=buildCards(Array.from({length:13},(_,n)=>({...i,id:`issue${n}`,title:`问题${n}`})),{slot:'0930',now:new Date('2026-10-15T01:30:00Z')});
  assert.equal(cards.length,1);
  assert.equal(cards[0].header.title.content,'昨日待解决，今天继续清零');
  assert.equal(cards[0].config.width_mode,'fill');
  assert.ok(cards[0].body.elements[0].columns.every(c=>c.vertical_align==='top'));
  assert.equal(new Set(cards[0].body.elements[0].columns.map(c=>c.padding)).size,1);
  assert.match(JSON.stringify(cards[0]),/<at id=ou_owner>/);
  assert.match(JSON.stringify(cards[0]),/2026-10-14 09:00提出/);
  assert.equal(cards.flatMap(c=>JSON.stringify(c).match(/\*\*【待IT回应】/g)||[]).length,13);
});
test('飞书同应用ID、引用关系、原文链接得到保留',()=>{
  const result=normalize({message_id:'om_x',chat_id:'oc_source',message_position:'8',msg_type:'text',body:{content:'{"text":"@_user_1 看一下"}'},create_time:'1792026000000',sender:{id:'ou_owner',sender_type:'user'},mentions:[{id:'ou_next',key:'@_user_1',name:'后续跟进人'}]},people);
  assert.equal(result.text,'@后续跟进人 看一下');assert.match(result.source_url,/position=8$/);
});
test('同一分钟多次触发不会重复认领发送，同一事项台账不会重复建单',async()=>{
  const store=new Store(db());const a=await store.lock(Date.now());assert.ok(a);assert.equal(await store.lock(Date.now()),null);await store.unlock(a);assert.ok(await store.lock(Date.now()));
});
test('发送回执持久化，相同发送请求重复执行只发一次',async()=>{
  const store=new Store(db());const env={TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test',SOURCE_CHAT_ID:'oc_source'};
  await store.queue({id:'one',slot:'0930',scheduled_at:new Date().toISOString(),card:{schema:'2.0'},page:1,total_pages:1,target:'oc_test'});
  let sends=0;const api={async sendCard(){sends++;return {message_id:'om_sent',chat_id:'oc_test'};}};
  await sendQueued(store,api,env);await sendQueued(store,api,env);
  assert.equal(sends,1);assert.equal((await store.delivery('one')).message_id,'om_sent');
});
test('网络超时记为结果未知，后续不会盲目补发',async()=>{
  const store=new Store(db());const env={TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test',SOURCE_CHAT_ID:'oc_source'};
  await store.queue({id:'one',slot:'0930',scheduled_at:new Date().toISOString(),card:{schema:'2.0'},page:1,total_pages:1,target:'oc_test'});
  let sends=0;const api={async sendCard(){sends++;throw new Error('timeout');}};
  await sendQueued(store,api,env);await sendQueued(store,api,env);
  assert.equal(sends,1);assert.equal((await store.delivery('one')).state,'unknown');
});
test('后台接口拒绝匿名访问，公开健康页不泄露问题和凭证',async()=>{
  const env={BOT_NAME:'测试鸭',ADMIN_TOKEN:'local-fake-token',TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test',SOURCE_CHAT_ID:'oc_source'};
  assert.equal((await worker.fetch(new Request('https://test/admin/status'),env)).status,401);
  const health=await (await worker.fetch(new Request('https://test/health'),env)).json();
  assert.equal(health.slots.length,3);assert.equal(JSON.stringify(health).includes('local-fake-token'),false);
});
test('持久化闹钟支持启停，单轮任务失败也保留下一次唤醒',async()=>{
  let alarmAt=null;
  const ctx={storage:{async setAlarm(time){alarmAt=time;},async getAlarm(){return alarmAt;},async deleteAlarm(){alarmAt=null;}}};
  const database=db();const store=new Store(database);await store.set('schedule',{enabled:true});
  const scheduler=new Scheduler(ctx,{DB:database,TARGET_CHAT_ID:'oc_wrong',ALLOWED_TARGET_CHAT_ID:'oc_test',SOURCE_CHAT_ID:'oc_source'});
  await scheduler.fetch(new Request('https://scheduler/start',{method:'POST'}));assert.ok(alarmAt>Date.now());
  await scheduler.fetch(new Request('https://scheduler/stop',{method:'POST'}));assert.equal(alarmAt,null);
  await assert.rejects(()=>scheduler.alarm());assert.ok(alarmAt>Date.now());
});
test('Cloudflare请求接口使用正确的运行时上下文',async()=>{
  const api=new Feishu({FEISHU_APP_ID:'fake',FEISHU_APP_SECRET:'fake'},function(){assert.equal(this,globalThis);return Promise.resolve(Response.json({code:0,tenant_access_token:'fake-token'}));});
  await api.authenticate();assert.equal(api.token,'fake-token');
});
test('分批分析断点持久化：已完成的消息不重复分析，编辑后重新进入队列',async()=>{
  const store=new Store(db());await store.putMessages([root,fix],hash);
  assert.equal((await store.unanalyzed()).length,2);
  await store.markAnalyzed([root.id]);assert.deepEqual((await store.unanalyzed()).map(m=>m.id),[fix.id]);
  await store.putMessages([root],hash);assert.deepEqual((await store.unanalyzed()).map(m=>m.id),[fix.id]);
  await store.putMessages([{...root,text:'问题再次出现'}],hash);assert.equal((await store.unanalyzed()).length,2);
});
test('尚无后续回复的问题以原反馈作为证据，但虚构的后续证据仍被拒绝',()=>{
  const pending=validateIssues([{...issue,evidence_ids:[]}],[root],[],people)[0];
  assert.deepEqual(pending.evidence_ids,['om_root']);assert.equal(pending.status,'pending');
  assert.throws(()=>validateIssues([{...issue,evidence_ids:['om_fake']}],[root],[],people));
});
test('模型引用错误只允许一次带证据纠正，仍错误就停止且不写入结果',async()=>{
  let calls=0;const diagnostics=[];
  const invalid={...issue,reporter_id:'ou_owner'};
  const options={messages:[root],previous:[],members:people,onInvalid:async d=>diagnostics.push(d)};
  const result=await analyzeIssues({}, {messages:[root]}, 'test',options,async(env,input)=>{
    calls++;if(calls===2){assert.equal(input.correction.detail.actual_sender,'ou_reporter');return {issues:[issue]};}
    return {issues:[invalid]};
  });
  assert.equal(result.changes[0].reporter_id,'ou_reporter');assert.equal(result.repairs,1);assert.equal(diagnostics.length,1);
  calls=0;await assert.rejects(()=>analyzeIssues({}, {},'test',options,async()=>{calls++;return {issues:[invalid]};}),/更换反馈人/);
  assert.equal(calls,2);
});
test('反馈人不在跟进栏重复出现，未知人员仍拒绝',()=>{
  const out=validateIssues([{...issue,owner_ids:['ou_reporter','ou_owner']}],[root],[],people)[0];
  assert.deepEqual(out.owner_ids,['ou_owner']);
  assert.throws(()=>validateIssues([{...issue,owner_ids:['ou_reporter','ou_fake']}],[root],[],people),/未经核实/);
});
test('富文本不重复读取content_v2；合并转发以来源群原消息承载历史背景',async()=>{
  assert.equal(flatten({title:'标题',content:[[{tag:'text',text:'正文'}]],content_v2:[[{tag:'text',text:'正文'}]]}),'标题\n正文');
  const api=new Feishu({});let reads=0;
  api.call=async()=>{reads++;return {items:[{message_id:'om_forward'}, {message_id:'om_other_chat',chat_id:'oc_other',upper_message_id:'om_forward',create_time:'1792026000000',sender:{sender_name:'历史发言人'},body:{content:'{"text":"历史处理背景"}'}}]};};
  const raw={message_id:'om_forward',chat_id:'oc_source',msg_type:'merge_forward',create_time:'1792026000000',sender:{id:'ou_reporter',sender_type:'user'},body:{content:'Merged and Forwarded Message'}};
  const expanded=await api.expandForwards([raw,raw]);assert.equal(reads,1);assert.equal(expanded[0].chat_id,'oc_source');
  const n=normalize(expanded[0]);assert.equal(n.id,'om_forward');assert.match(n.text,/仅作背景/);assert.match(n.text,/历史处理背景/);
  api.call=async()=>({items:[]});await assert.rejects(()=>api.expandForwards([raw]),/未能读取/);
});
test('嵌套卡片JSON提取正文，模型响应体长时间不结束也会超时',async()=>{
  const raw=JSON.stringify({body:{elements:[{id:'320',property:{text:{id:'321',property:{content:'筛选无法按名称搜索'}}}}]}});
  assert.equal(flatten({content:raw}),'筛选无法按名称搜索');
  await assert.rejects(()=>analyze({MIMO_BASE_URL:'https://fake.test',AI_TIMEOUT_MS:5},{},'test',async()=>({json:()=>new Promise(()=>{})})),/等待上限/);
});
test('模型输入保留人员和引用关系，去掉链接元数据并隐去工号邮箱',()=>{
  const report={...root,text:'GL1234567 和 test@example.com 筛选异常'};
  const input=analysisInput(new Date('2026-10-15T01:30:00Z'),[{...issue,id:'extra',source_url:root.source_url}],[report,fix],[fix]);
  const content=JSON.stringify(input);assert.equal(content.includes('GL1234567'),false);assert.equal(content.includes('test@example.com'),false);assert.equal(content.includes('applink.feishu.cn'),false);
  assert.equal(input.messages[1].parent_id,root.id);assert.equal(input.messages[0].sender_id,'ou_reporter');assert.deepEqual(input.focus_message_ids,['om_fix']);
});
test('明确指向原问题的IT回复后可承接短确认，其他讨论穿插则不能关闭，说明与状态保持一致',()=>{
  const directed={...fix,created_at:'2026-10-14T02:00:00Z'};
  const ack={...root,id:'om_ack',text:'[了解]',created_at:'2026-10-14T02:01:00Z'};
  const plain={...confirmed,parent_id:null,text:'没问题啦',created_at:'2026-10-14T02:02:00Z'};
  const raw={...issue,status:'closed',note:'问题已确认解决',evidence_ids:[root.id,fix.id,plain.id],closure_message_id:plain.id};
  assert.equal(validateIssues([raw],[root,directed,ack,plain],[],people)[0].status,'closed');
  const unrelated={...fix,id:'om_other',sender_id:'ou_next',parent_id:'om_another',text:'另一个问题已修好',created_at:'2026-10-14T02:01:30Z'};
  const out=validateIssues([raw],[root,directed,ack,unrelated,plain],[],people)[0];
  assert.equal(out.status,'waiting_confirmation');assert.doesNotMatch(out.note,/已确认解决/);
  assert.equal(validateIssues([raw],[root,directed,{...ack,text:'另一个问题请处理'},plain],[],people)[0].status,'waiting_confirmation');
});
test('早间只看前日和已入提醒遗留，下午看当天及早间遗留，历史回看不计入',()=>{
  const make=(id,day,status='pending')=>({id,created_at:`2026-10-${day}T01:00:00Z`,status});
  const items=[make('old','09'),make('yesterday','14'),make('yesterday_done','14','closed'),make('today','15'),make('today_done','15','closed')];
  const now=new Date('2026-10-15T05:30:00Z'),startDay='2026-10-14';
  assert.deepEqual(scopeIssues(items,{now,slot:'0930',startDay}).map(i=>i.id),['yesterday','yesterday_done']);
  assert.deepEqual(scopeIssues(items,{now,slot:'1330',startDay,morningIds:['yesterday','yesterday_done']}).map(i=>i.id),['yesterday','yesterday_done','today','today_done']);
  const tomorrow=scopeIssues(items,{now:new Date('2026-10-16T01:30:00Z'),slot:'0930',startDay});
  assert.ok(tomorrow.some(i=>i.id==='yesterday'));assert.equal(tomorrow.some(i=>i.id==='yesterday_done'),false);
});
test('周一早间合并周五与周末，三个指标分别是IT、HRIS和本轮已解决',()=>{
  const now=new Date('2026-10-19T01:30:00Z');assert.equal(previousPeriodStart(now),'2026-10-16');
  const scope=scopeIssues(['16','17','18','19'].map(day=>({id:day,created_at:`2026-10-${day}T01:00:00Z`,status:'pending'})),{now,slot:'0930',startDay:'2026-10-16'});
  assert.deepEqual(scope.map(i=>i.id),['16','17','18']);
  const base=validateIssues([issue],[root],[],people)[0];
  const card=buildCards([base,{...base,id:'wait',status:'waiting_confirmation'},{...base,id:'done',status:'closed'}],{now})[0];
  const columns=card.body.elements[0].columns;
  ['需IT跟进','待HRIS确认','已解决'].forEach((label,i)=>{assert.match(columns[i].elements[0].content,/>1</);assert.ok(columns[i].elements[1].content.includes(label));});
});
test('必须艾特本机器人并明确报完成，否定或提问不能误关闭，多问题卡片必须定位',()=>{
  const command={...confirmed,parent_id:null,mentions:[{id:'ou_bot'}],text:'@清零鸭 筛选无法使用 解决了'};
  assert.equal(isResolutionCommand(command,'ou_bot'),true);
  assert.equal(isResolutionCommand({...command,text:'筛选无法使用 已解决 @清零鸭',mentions:[{id:'ou_bot',name:'清零鸭'}]},'ou_bot'),true);
  for(const text of ['@清零鸭 还没完成','@清零鸭 解决了吗？','@清零鸭 请帮我完成'])assert.equal(isResolutionCommand({...command,text},'ou_bot'),false);
  assert.equal(isResolutionCommand(command,'ou_another_bot'),false);
  const base=validateIssues([issue],[root],[],people)[0];
  assert.equal(resolveCommand(command,[base]).issue.id,base.id);
  assert.equal(resolveCommand({...command,text:'@清零鸭 完成',parent_id:root.id},[base]).issue.id,base.id);
  const another={...base,id:'another',root_id:'om_another',title:'另一个问题',evidence_ids:['om_another']};
  assert.equal(resolveCommand({...command,text:'@清零鸭 完成'},[base,another],[base.id,another.id]).issue,undefined);
});
test('艾特报完成持久化一次，人工解决后AI不能重开，试运行不会回复业务群',async()=>{
  const store=new Store(db());const base=validateIssues([issue],[root],[],people)[0];await store.putIssues([base]);
  const raw={message_id:'om_command',chat_id:'oc_test',create_time:String(Date.parse('2026-10-15T01:00:00Z')),sender:{id:'ou_next',sender_type:'user'},body:{content:JSON.stringify({text:'@_user_1 筛选无法使用 完成'})},mentions:[{id:'ou_bot',key:'@_user_1',name:'清零鸭'}]};
  const env={BOT_OPEN_ID:'ou_bot',SOURCE_CHAT_ID:'oc_source',TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test'};
  let replies=0;const api={async list(chat){return chat==='oc_test'?[raw]:[];},async call(){replies++;return {message_id:'om_ack',chat_id:'oc_test'};}};
  await processCommands(env,store,api);await processCommands(env,store,api);assert.equal(replies,1);
  const updated=await store.rows('issues');assert.equal(updated[0].status,'closed');assert.equal(updated[0].resolution.actor_id,'ou_next');
  assert.equal(validateIssues([issue],[root],updated,people)[0].status,'closed');
  api.list=async chat=>chat==='oc_source'?[{...raw,message_id:'om_source_command',chat_id:'oc_source'}]:[];
  const result=await processCommands(env,store,api);assert.equal(result[0].ack,'source-silent');assert.equal(replies,1);
});
test('飞书明确内部错误只对只读请求重试一次，发送请求不盲目重试',async()=>{
  let calls=0;const api=new Feishu({},async()=>{calls++;return Response.json(calls===1?{code:2200,msg:'internal error'}:{code:0,data:{items:[]}});});api.token='fake';
  assert.deepEqual(await api.call('/im/v1/messages'),{items:[]});assert.equal(calls,2);
  calls=0;await assert.rejects(()=>api.call('/im/v1/messages',{method:'POST',data:{}}),/2200/);assert.equal(calls,1);
});
const rolloutEnv={BOT_NAME:'测试鸭',TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test',SOURCE_CHAT_ID:'oc_source',PRODUCTION_CHAT_ID:'oc_source',PRODUCTION_START_AT:'2026-10-16T09:30:00+08:00'};
test('正式发送精确到北京时间次日09:30启用，测试入口永远留在测试群',()=>{
  const before=new Date('2026-10-16T01:29:59.999Z'),at=new Date('2026-10-16T01:30:00Z');
  assert.equal(deliveryRoute(rolloutEnv,before).target_chat_id,'oc_test');
  assert.equal(deliveryRoute(rolloutEnv,at).target_chat_id,'oc_source');
  assert.equal(deliveryRoute(rolloutEnv,at,{test:true}).target_chat_id,'oc_test');
  assert.throws(()=>assertDeliveryTarget(rolloutEnv,'oc_source',before),/尚未到/);
  assert.doesNotThrow(()=>assertDeliveryTarget(rolloutEnv,'oc_source',at));
  assert.throws(()=>assertDeliveryTarget(rolloutEnv,'oc_other',at),/未授权/);
  assert.throws(()=>deliveryRoute({...rolloutEnv,PRODUCTION_CHAT_ID:'oc_other'},at),/配置无效/);
  assert.throws(()=>deliveryRoute({...rolloutEnv,PRODUCTION_START_AT:'tomorrow'},at),/配置无效/);
});
test('正式卡片冻结正确目标且移除测试标签，重复唤醒不重复建单，测试只发送测试单',async()=>{
  const store=new Store(db()),now=new Date('2026-10-16T01:30:00Z');
  const base=validateIssues([issue],[root],[],people)[0];
  await store.set('tracking_policy',{start_day:'2026-10-14'});
  const data={issues:[base],members:people,cutoff:now},slot={id:'0930',scheduled_at:now.toISOString()};
  await queueSlot(rolloutEnv,store,data,slot,'schedule',now);
  await queueSlot(rolloutEnv,store,data,slot,'schedule',now);
  await queueSlot(rolloutEnv,store,data,slot,'test-isolation',now);
  const pending=await store.pending();assert.equal(pending.length,2);
  const formal=pending.find(d=>d.id.startsWith('schedule:')),preview=pending.find(d=>d.id.startsWith('test-'));
  assert.equal(formal.target_chat_id,'oc_source');assert.doesNotMatch(formal.card,/测试群试运行/);assert.match(formal.card,/每日问题跟进/);
  assert.equal(preview.target_chat_id,'oc_test');assert.match(preview.card,/测试群试运行/);
  const sent=[];const api={async sendCard(card,uuid,target){sent.push(target);return {message_id:`om_${sent.length}`,chat_id:target};}};
  await sendQueued(store,api,rolloutEnv,now,{testOnly:true});assert.deepEqual(sent,['oc_test']);
  await sendQueued(store,api,rolloutEnv,now);await sendQueued(store,api,rolloutEnv,now);assert.deepEqual(sent,['oc_test','oc_source']);
});
test('台账中的正式发送在生效前被拦截，不会重定向到测试群',async()=>{
  const store=new Store(db());await store.queue({id:'formal',slot:'0930',scheduled_at:'2026-10-16T01:30:00Z',target:'oc_source',card:{schema:'2.0'},page:1,total_pages:1});
  let sends=0;await assert.rejects(()=>sendQueued(store,{sendCard(){sends++;}},rolloutEnv,new Date('2026-10-15T11:00:00Z')),/尚未到/);
  assert.equal(sends,0);assert.equal((await store.delivery('formal')).attempts,0);
});
test('正式启用后业务群艾特完成静默入账，不发送即时确认，重复处理不改结果',async()=>{
  const store=new Store(db());await store.putIssues(validateIssues([issue],[root],[],people));
  const raw={message_id:'om_live_command',chat_id:'oc_source',create_time:String(Date.parse('2026-10-16T01:31:00Z')),sender:{id:'ou_next',sender_type:'user'},body:{content:JSON.stringify({text:'@_user_1 筛选无法使用 已解决'})},mentions:[{id:'ou_bot',key:'@_user_1',name:'清零鸭'}]};
  let replies=0;const api={async list(chat){return chat==='oc_source'?[raw]:[];},async call(path){replies++;assert.equal(path,'/im/v1/messages/om_live_command/reply');return {message_id:'om_live_ack',chat_id:'oc_source'};}};
  const env={...rolloutEnv,BOT_OPEN_ID:'ou_bot'};
  const result=await processCommands(env,store,api,new Date('2026-10-16T01:32:00Z'));
  await processCommands(env,store,api,new Date('2026-10-16T01:33:00Z'));
  assert.equal(result[0].ack,'source-silent');assert.equal(replies,0);assert.equal((await store.rows('issues'))[0].status,'closed');
});
test('截图格式：艾特机器人逐项确认无误可准确关闭两件，其他问题不受影响',async()=>{
  const store=new Store(db());
  const first={...validateIssues([issue],[root],[],people)[0],title:'合同续签流程员工工号带qy前缀',status:'waiting_confirmation'};
  const second={...first,id:'om_second:main',root_id:'om_second',title:'调薪流程导出字段与首页展示不一致',evidence_ids:['om_second']};
  const unrelated={...first,id:'om_third:main',root_id:'om_third',title:'OA调薪流程附件下载权限仅少数人可用',evidence_ids:['om_third']};
  await store.putIssues([first,second,unrelated]);
  const command={...confirmed,id:'om_multi_confirm',chat_id:'oc_source',sender_id:'ou_reporter',parent_id:null,root_id:null,mentions:[{id:'ou_bot',name:'系统问题清零鸭'}],text:'@系统问题清零鸭\n \n1. \n“合同续签流程员工工号带qy前缀”已确认无误\n2. \n“调薪流程导出字段与首页展示不一致”已确认无误'};
  assert.equal(isResolutionCommand(command,'ou_bot'),true);
  assert.deepEqual(resolveCommand(command,[first,second,unrelated]).issues.map(i=>i.id),[first.id,second.id]);
  const raw={message_id:command.id,chat_id:'oc_source',create_time:String(Date.parse('2026-10-16T01:42:20Z')),sender:{id:'ou_reporter',sender_type:'user'},body:{content:JSON.stringify({text:command.text})},mentions:command.mentions};
  let sends=0;const api={async list(chat){return chat==='oc_source'?[raw]:[];},async call(){sends++;throw new Error('正式群禁止即时回复');}};
  await store.set('last_command_poll','2026-10-16T01:50:00Z');
  const env={...rolloutEnv,BOT_OPEN_ID:'ou_bot'};
  const results=await processCommands(env,store,api,new Date('2026-10-16T01:51:00Z'));
  await processCommands(env,store,api,new Date('2026-10-16T01:52:00Z'));
  assert.equal(results[0].ack,'source-silent');assert.equal(sends,0);
  const updated=await store.rows('issues');assert.equal(updated.find(i=>i.id===first.id).status,'closed');assert.equal(updated.find(i=>i.id===second.id).status,'closed');assert.equal(updated.find(i=>i.id===unrelated.id).status,'waiting_confirmation');
  assert.equal(updated.find(i=>i.id===first.id).resolution.message_id,command.id);
});
test('确认无误的否定、提问、请求不能关闭；一条中未确认的项目保持未解决',()=>{
  const first={...validateIssues([issue],[root],[],people)[0],title:'筛选无法使用'};
  const second={...first,id:'om_second:main',root_id:'om_second',title:'另一个问题'};
  const command={...confirmed,parent_id:null,mentions:[{id:'ou_bot',name:'清零鸭'}]};
  for(const text of ['@清零鸭 “筛选无法使用”还未确认无误','@清零鸭 “筛选无法使用”请确认无误','@清零鸭 “筛选无法使用”已确认无误？','@清零鸭 “筛选无法使用”尚未解决','@清零鸭 “筛选无法使用”已确认无误，另一个问题还没解决'])assert.equal(isResolutionCommand({...command,text},'ou_bot'),false,text);
  const mixed={...command,text:'@清零鸭\n“筛选无法使用”已确认无误\n“另一个问题”还未确认无误'};
  assert.deepEqual(resolveCommand(mixed,[first,second]).issues.map(i=>i.id),[first.id]);
  const ambiguous={...command,text:'@清零鸭 “筛选无法使用”和“另一个问题”已确认无误'};
  assert.equal(resolveCommand(ambiguous,[first,second]).issue,undefined);
});
test('飞书发送采用冻结的台账群ID，避免沿用测试群配置发错群',async()=>{
  const api=new Feishu(rolloutEnv);api.call=async(path,options)=>options.data;
  assert.equal((await api.sendCard({schema:'2.0'},'fake-uuid','oc_source')).receive_id,'oc_source');
  assert.equal((await api.sendCard({schema:'2.0'},'fake-uuid')).receive_id,'oc_test');
});
test('其他同事不艾特机器人直接回复原问题也能静默闭环，转需求保留单独状态',async()=>{
  const store=new Store(db()),base=validateIssues([issue],[root],[],people)[0];await store.putIssues([base]);
  const raw={message_id:'om_non_mention',chat_id:'oc_source',parent_id:root.id,create_time:String(Date.parse('2026-10-16T02:20:00Z')),sender:{id:'ou_next',sender_type:'user'},body:{content:JSON.stringify({text:'这个问题转需求后续跟进解决'})},mentions:[]};
  let writes=0;const api={async list(chat,type,start,options){assert.equal(options.allReplies,true);return chat==='oc_source'?[raw]:[];},async call(){writes++;throw new Error('禁止即时发群');}};
  const result=await processCommands({...rolloutEnv,BOT_OPEN_ID:'ou_bot'},store,api,new Date('2026-10-16T02:21:00Z'));
  assert.equal(result[0].ack,'source-silent');assert.equal(writes,0);assert.equal((await store.rows('issues'))[0].status,'converted');
});
test('明确写标题转优化需求后，再回复按需求工单跟进，可闭环同一来源的剩余优化目标',()=>{
  const base=validateIssues([issue],[root],[],people)[0],optimization={...base,id:'om_root:optimization',facet:'optimization',title:'筛选搜索性能优化',evidence_ids:[root.id,'om_title_transfer']};
  const first={...confirmed,id:'om_title_transfer',parent_id:null,root_id:null,mentions:[],text:'“筛选无法使用”逻辑已澄清，提优化需求后续解决'};
  const resolved=resolveCommand(first,[base,optimization]);assert.equal(resolved.outcomes[base.id],'converted');
  const follow={...first,id:'om_transfer_follow',text:'这种转成需求的，就正常按需求工单跟进',parent_id:first.id,root_id:first.id};
  const remaining=resolveCommand(follow,[{...base,status:'converted',evidence_ids:[root.id,first.id]},optimization]);
  assert.equal(remaining.issue.id,optimization.id);assert.equal(remaining.outcomes[optimization.id],'converted');
});
test('手动台账同步即使处于定时节点，也不建正式投递或发送已有正式队列',async()=>{
  const database=db(),store=new Store(database),now=new Date('2026-10-16T05:30:01Z');
  await store.set('schedule',{enabled:true,enabled_at:'2026-10-16T01:00:00Z'});await store.set('last_sync',now.toISOString());
  await store.queue({id:'production-pending',slot:'1330',scheduled_at:now.toISOString(),card:{},page:1,total_pages:1,target:'oc_source'});
  let sends=0;await tick({DB:database,SOURCE_CHAT_ID:'oc_source',TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test',PRODUCTION_CHAT_ID:'oc_source',PRODUCTION_START_AT:'2026-10-16T01:00:00Z'},{now,maintenance:true,api:{async sendCard(){sends++;throw new Error('不应发送正式队列');}}});
  assert.equal(sends,0);assert.equal((await store.delivery('production-pending')).state,'queued');assert.equal(await store.state('queued:schedule:2026-10-16:1330'),null);
});
test('全表生成提醒时只对未解决事项分页及关联，每页提供人工更新提示和数据表按钮',async()=>{
  const store=new Store(db()),base=validateIssues([issue],[root],[],people)[0],tableUrl='https://example.test/wiki/table?table=tbl_test&view=view_test';
  const open=Array.from({length:7},(_,i)=>({...base,id:`open_${i}`,title:`待处理事项${i}`}));
  const issues=[...open,{...base,id:'done',status:'closed',title:'完成后隐藏的事项'},{...base,id:'converted',status:'converted',title:'转需求后隐藏的事项'}];
  await queueSlot({SOURCE_CHAT_ID:'oc_source',TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test',BASE_TABLE_URL:tableUrl},store,{ledger:true,issues,members:people,cutoff:new Date('2026-10-16T02:00:00Z')},{id:'1330',scheduled_at:'2026-10-16T02:00:00Z'},'test-card-v9');
  const deliveries=await store.pending();assert.equal(deliveries.length,1);const ids=[];
  for(const d of deliveries){const card=JSON.parse(d.card),body=JSON.stringify(card);assert.doesNotMatch(body,/完成后隐藏的事项|转需求后隐藏的事项/);assert.match(body,/>2<\/font>/);assert.match(body,/若已完成，可在群内回复：问题标题\+已完成。或随时进入数据源表更新进展，以人工更新进展为准：/);const button=card.body.elements.at(-1);assert.equal(button.text.content,'查记录or人工更新进展');assert.deepEqual(button.behaviors,[{type:'open_url',default_url:tableUrl}]);ids.push(...await store.state(`queue_issues:${d.id}`));}
  assert.deepEqual(new Set(ids),new Set(open.map(i=>i.id)));
});
test('IT已回复并明确等反馈人复查时归HRIS，不把仍待IT排查或普通问句转交',()=>{
  const response={...fix,text:'删除后后台也没有记录了，再确认一下是否还冲突。'};
  const raw={...issue,status:'pending',note:'IT回复删除后后台也无记录，待反馈人确认是否仍冲突并给出后续处理',evidence_ids:[root.id,response.id]};
  assert.equal(validateIssues([raw],[root,response],[],people)[0].status,'waiting_confirmation');
  for(const note of ['反馈人确认仍有冲突，待IT继续排查','IT尚未回复，待反馈人确认后再联系IT','IT仍在排查，稍后请反馈人验证','反馈人说需要确认，但IT尚未处理','无需反馈人确认，IT已接收处理'])assert.notEqual(validateIssues([{...raw,note}],[root,response],[],people)[0].status,'waiting_confirmation',note);
});

function cardIssueIds(card) {
  const ids=[];
  function visit(node){if(!node||typeof node!=='object')return;if(node.type==='callback'&&node.value?.action==='resolve_issue')ids.push(node.value.issue_id);for(const value of Object.values(node))if(typeof value==='object')visit(value);}
  visit(card);return ids;
}
function cardSize(card){return {bytes:new TextEncoder().encode(JSON.stringify(card)).length,elements:(JSON.stringify(card).match(/"tag":/g)||[]).length};}
const pageIssue=n=>({id:`p${n}`,record_id:`rec_p${n}`,title:`待处理问题${n}`,status:n%2?'waiting_confirmation':'pending',owner_ids:['ou_owner'],reporter_id:'ou_reporter',created_at:'2026-10-16T01:00:00Z',note:'待复查',source_url:'https://example.test/source'});
const pageOptions={slot:'1330',now:new Date('2026-10-16T05:30:00Z'),actions:true,tableUrl:'https://example.test/table'};

test('超过六项且包含二次确认按钮时，仍优先一张卡片，不显示分页标记',()=>{
  const issues=Array.from({length:13},(_,n)=>pageIssue(n)),cards=buildCards(issues,pageOptions);
  assert.equal(cards.length,1);assert.equal(cardIssueIds(cards[0]).length,13);
  assert.doesNotMatch(cards[0].header.subtitle.content,/\d+\/\d+/);
  assert.doesNotMatch(cards[0].body.elements.find(e=>e.tag==='markdown').content,/第\d+\/\d+页/);
});
test('短内容也遵守组件总数限制，不能只测字节数；各页保留完整按钮',()=>{
  const issues=Array.from({length:24},(_,n)=>pageIssue(n)),cards=buildCards(issues,pageOptions);
  assert.ok(cards.length>1);assert.ok(cardIssueIds(cards[0]).length>6);
  for(const card of cards){const size=cardSize(card);assert.ok(size.bytes<=28000);assert.ok(size.elements<=200);}
  assert.deepEqual(new Set(cards.flatMap(cardIssueIds)),new Set(issues.map(i=>i.id)));
  assert.equal(cards.flatMap(cardIssueIds).length,issues.length);
});
test('中文与表情的真实字节超限自动分页，双位数页码仍在限额内且不漏项',()=>{
  const issues=Array.from({length:120},(_,n)=>({...pageIssue(n),note:'核查😀'.repeat(400)}));
  const cards=buildCards([...issues,{...pageIssue('closed'),status:'closed'}],pageOptions);
  assert.ok(cards.length>=10);
  for(const [index,card] of cards.entries()){
    const size=cardSize(card);assert.ok(size.bytes<=28000,JSON.stringify(size));assert.ok(size.elements<=200);
    assert.ok(card.header.subtitle.content.endsWith(`｜${index+1}/${cards.length}`));
    assert.ok(card.body.elements.find(e=>e.tag==='markdown').content.includes(`第${index+1}/${cards.length}页`));
  }
  const ids=cards.flatMap(cardIssueIds);assert.equal(ids.length,issues.length);assert.deepEqual(new Set(ids),new Set(issues.map(i=>i.id)));
});
test('投递页的授权问题列表与该页实际按钮一致，重复建单不改变分页或额外发送',async()=>{
  const store=new Store(db()),issues=Array.from({length:24},(_,n)=>pageIssue(n));
  const env={SOURCE_CHAT_ID:'oc_source',TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test',BASE_TABLE_URL:pageOptions.tableUrl,CARD_ACTIONS_ENABLED:'true'};
  const data={ledger:true,issues,members:people,cutoff:pageOptions.now},slot={id:'1330',scheduled_at:pageOptions.now.toISOString()};
  const key=await queueSlot(env,store,data,slot,'test-capacity',pageOptions.now);
  await queueSlot(env,store,data,slot,'test-capacity',pageOptions.now);
  const deliveries=(await store.pending()).sort((a,b)=>a.page-b.page),allIds=[];
  assert.ok(deliveries.length>1);assert.equal((await store.state(`queued:${key}`)).pages,deliveries.length);
  for(const [index,delivery] of deliveries.entries()){
    const card=JSON.parse(delivery.card),ids=await store.state(`queue_issues:${delivery.id}`);
    assert.deepEqual(new Set(ids),new Set(cardIssueIds(card)));assert.equal(ids.length,cardIssueIds(card).length);
    assert.equal(delivery.page,index+1);assert.equal(delivery.total_pages,deliveries.length);allIds.push(...ids);
  }
  assert.equal(allIds.length,issues.length);assert.deepEqual(new Set(allIds),new Set(issues.map(i=>i.id)));
});
test('单个事项超出卡片限额会明确失败，不截断事项，也不留下部分投递',async()=>{
  const store=new Store(db()),oversized={...pageIssue('large'),note:'完整内容😀'.repeat(10000)};
  await assert.rejects(()=>queueSlot({SOURCE_CHAT_ID:'oc_source',TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test',CARD_ACTIONS_ENABLED:'true'},store,{ledger:true,issues:[pageIssue(0),oversized],members:people,cutoff:pageOptions.now},{id:'1330',scheduled_at:pageOptions.now.toISOString()},'test-oversize',pageOptions.now),/单个事项.*超出/);
  assert.equal((await store.pending()).length,0);
});
