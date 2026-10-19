import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{spawnSync}from'node:child_process';import{fileURLToPath}from'node:url';import{usageFaults,probe,accountUsage,pendingNotifications,run,OWNER}from'../monitor.mjs';
const env={GITHUB_TOKEN:'fake-gh',GITHUB_REPOSITORY:'example/private-monitor',MONITOR_TOKEN:'fake-monitor',FEISHU_APP_ID:'cli_fake',FEISHU_APP_SECRET:'fake-secret',FEISHU_VERIFICATION_TOKEN:'fake-verification',CLOUDFLARE_API_TOKEN:'fake-analytics',ALERT_OWNER_OPEN_ID:OWNER};
const usage={requests:100,rowsRead:1000,rowsWritten:100,doRequests:200,doDuration:100,doRowsRead:100,doRowsWritten:100};
test('额度按UTC日分级提醒，缺失用量不冒充0',()=>{assert.equal(usageFaults(usage,'2026-10-16').length,0);assert.match(usageFaults({...usage,requests:80000},'2026-10-16')[0].key,/:80$/);assert.match(usageFaults({...usage,rowsRead:4750000},'2026-10-16')[0].key,/:95$/);assert.match(usageFaults({...usage,rowsWritten:100000},'2026-10-16')[0].key,/:100$/);assert.throws(()=>usageFaults({...usage,requests:undefined},'day'));});
test('探测真实challenge并仅重试一次，不把错误页面当成功',async()=>{let count=0;const request=async(u,o)=>{count++;return Response.json(count===1?{}:{challenge:JSON.parse(o.body).challenge});};assert.ok((await probe(env,request)).elapsed_ms>=0);assert.equal(count,2);await assert.rejects(()=>probe(env,async()=>new Response('bad',{status:502})),/连续两次/);});
test('账号用量查询必须读完整账号和指标；GraphQL错误不当零额度',async()=>{const mock=async()=>Response.json({errors:null,data:{viewer:{accounts:[{workersInvocationsAdaptive:[{sum:{requests:17}}],pagesFunctionsInvocationsAdaptiveGroups:[{sum:{requests:7}}],d1AnalyticsAdaptiveGroups:[{sum:{rowsRead:200,rowsWritten:12}}],durableObjectsPeriodicGroups:[{sum:{duration:100,rowsRead:0,rowsWritten:0}}],durableObjectsInvocationsAdaptiveGroups:[{sum:{requests:33}}]}]}}});const measured=await accountUsage(env,new Date('2026-10-16T04:00:00Z'),mock);assert.equal(measured.rowsWritten,12);assert.equal(measured.requests,24);assert.equal(measured.pagesRequests,7);await assert.rejects(()=>accountUsage(env,new Date(),async()=>Response.json({errors:[{message:'forbidden'}]})));});
function backend({outage=false,healthFaults=[],requests=100}={}){
 let issue={version:1,alerts:{}},sends=0,saves=0,heartbeats=0;const calls=[];
 return{get state(){return issue;},get sends(){return sends;},get saves(){return saves;},get heartbeats(){return heartbeats;},calls,async request(url,o={}){
  calls.push(url);
  if(url.includes('/issues/1')){if(o.method==='PATCH'){issue=JSON.parse(JSON.parse(o.body).body);saves++;}return Response.json({body:JSON.stringify(issue)});}
  if(url.includes('pages.dev')){if(outage)return new Response('unreachable',{status:503});if(url.includes('heartbeat')){heartbeats++;return Response.json({ok:true});}if(url.includes('card-actions'))return Response.json({challenge:JSON.parse(o.body).challenge});return Response.json({ok:!healthFaults.length,faults:healthFaults,build:'test',last_tick:new Date().toISOString()});}
  if(url.includes('cloudflare.com'))return Response.json({errors:null,data:{viewer:{accounts:[{workersInvocationsAdaptive:[{sum:{requests}}],pagesFunctionsInvocationsAdaptiveGroups:[{sum:{requests:7}}],d1AnalyticsAdaptiveGroups:[{sum:{rowsRead:100,rowsWritten:100}}],durableObjectsPeriodicGroups:[{sum:{duration:100,rowsRead:0,rowsWritten:0}}],durableObjectsInvocationsAdaptiveGroups:[{sum:{requests:100}}]}]}}});
  if(url.includes('tenant_access_token'))return Response.json({code:0,tenant_access_token:'fake-token'});
  if(url.includes('im/v1/messages')){sends++;assert.ok(url.includes('receive_id_type=open_id'));assert.equal(JSON.parse(o.body).receive_id,OWNER);assert.ok(Object.values(issue.alerts).every(a=>a.state==='sending'),'发送前持久化');return Response.json({code:0,data:{message_id:'om_fake_dm'}});}
  throw new Error('Unexpected request');
 }};
}
test('Cloudflare完全不可达时从独立平台直接私信本人，合并异常且持续故障不刷屏',async()=>{const b=backend({outage:true});await assert.rejects(()=>run(env,b.request.bind(b)),/发现异常/);assert.equal(b.sends,1);assert.equal(Object.keys(b.state.alerts).length,2);await assert.rejects(()=>run(env,b.request.bind(b)));assert.equal(b.sends,1);});
test('正常保持安静，演练只私信一次；去重台账损坏则停止发送',async()=>{const b=backend();await run(env,b.request.bind(b));assert.equal(b.sends,0);await run({...env,MONITOR_DRILL:'true'},b.request.bind(b));await run({...env,MONITOR_DRILL:'true'},b.request.bind(b));assert.equal(b.sends,1);await assert.rejects(()=>run(env,async(url,o)=>url.includes('/issues/1')?Response.json({body:'invalid'}):b.request(url,o)),/无法解析/);assert.equal(b.sends,1);});
test('固定本人白名单拒绝群ID或其他收件人',async()=>{await assert.rejects(()=>run({...env,ALERT_OWNER_OPEN_ID:'oc_group'}),/收件人/);});

test('通知关闭时保留真实故障、状态保存、失败结果和回报心跳，未发送不记sent',async()=>{
 const b=backend({healthFaults:[{key:'tick_stalled',message:'虚构运行心跳中断'}]});
 await assert.rejects(()=>run({...env,MONITOR_NOTIFICATIONS_ENABLED:'false'},b.request.bind(b)),/发现异常/);
 assert.equal(b.sends,0);assert.ok(!b.calls.some(u=>u.includes('open.feishu.cn')));
 assert.equal(b.state.fault_count,1);assert.equal(b.state.last_check.health.ok,false);
 assert.ok(b.state.last_check.time);assert.ok(b.state.last_check.usage.requests>0);
 assert.equal(b.heartbeats,1);assert.ok(b.saves>0);assert.deepEqual(b.state.alerts,{});
 await assert.rejects(()=>run({...env,MONITOR_NOTIFICATIONS_ENABLED:'true'},b.request.bind(b)),/发现异常/);
 assert.equal(b.sends,1);assert.equal(b.heartbeats,2);
});

test('通知关闭时正常巡检、额度检查和演练都不发送飞书私信',async()=>{
 for(const options of [{},{requests:80000}]){
  const b=backend(options);
  await run({...env,MONITOR_NOTIFICATIONS_ENABLED:'false',MONITOR_DRILL:'true'},b.request.bind(b));
  assert.equal(b.sends,0);assert.ok(!b.calls.some(u=>u.includes('open.feishu.cn')));
  assert.equal(b.heartbeats,1);assert.equal(b.state.fault_count,options.requests?2:1);
  assert.ok(b.state.last_check.probe);assert.ok(b.state.last_check.usage);assert.deepEqual(b.state.alerts,{});
 }
});

test('工作流保留定时巡检并显式关闭通知',()=>{
 const workflow=readFileSync(new URL('../.github/workflows/monitor.yml',import.meta.url),'utf8');
 assert.match(workflow,/MONITOR_NOTIFICATIONS_ENABLED: 'false'/);
 assert.match(workflow,/cron: '17,47 \* \* \* \*'/);
 assert.match(workflow,/run: node monitor\.mjs/);
});

test('通知关闭时CLI发现真实故障仍退出1，已保存故障并回报心跳',()=>{
 const setup=`const OWNER=${JSON.stringify(OWNER)};const backend=${backend.toString()};const b=backend({healthFaults:[{key:'tick_stalled',message:'虚构故障'}]});globalThis.fetch=b.request.bind(b);process.on('exit',()=>console.log('MOCK_AUDIT:'+JSON.stringify({sends:b.sends,heartbeats:b.heartbeats,fault_count:b.state.fault_count,feishu_calls:b.calls.filter(u=>u.includes('open.feishu.cn')).length})));`;
 const child=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(setup),fileURLToPath(new URL('../monitor.mjs',import.meta.url))],{encoding:'utf8',env:{...env,MONITOR_NOTIFICATIONS_ENABLED:'false'}});
 assert.equal(child.status,1,child.stderr);
 assert.match(child.stderr,/监测发现异常/);
 const audit=JSON.parse(child.stdout.split('\n').find(s=>s.startsWith('MOCK_AUDIT:')).slice('MOCK_AUDIT:'.length));
 assert.deepEqual(audit,{sends:0,heartbeats:1,fault_count:1,feishu_calls:0});
});
