import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.mjs';
import { hash } from '../src/core.mjs';
import { BASE_FIELDS as F, syncLedger, tableIssues } from '../src/ledger.mjs';
import { buildCards } from '../src/card.mjs';
import { tick } from '../src/worker.mjs';

// Count actual SQLite mutations, not attempted statements or Cloudflare billed rows.
function database(t) {
  const sql=new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  t.after(()=>sql.close());
  const mutations=[];
  const db={
    prepare(query) {let args=[];return {
      bind(...values){args=values;return this;},
      async first(){return sql.prepare(query).get(...args)||null;},
      async all(){return {results:sql.prepare(query).all(...args)};},
      async run(){const changes=Number(sql.prepare(query).run(...args).changes);mutations.push({query,args:structuredClone(args),changes});return {meta:{changes}};}
    };},
    async batch(statements){sql.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}
  };
  return {db,mutations,reset(){mutations.length=0;},changes(){return mutations.reduce((n,m)=>n+m.changes,0);}};
}
const members={ou_reporter:'反馈同事',ou_owner:'IT同事'};
const message={id:'om_root',chat_id:'oc_source',text:'部门筛选无法搜索',created_at:'2026-10-22T01:00:00Z',updated_at:'2026-10-22T01:00:00Z'};
const issue={id:'om_root:main',root_id:'om_root',facet:'main',title:'部门筛选无法搜索',status:'pending',note:'等待处理',created_at:message.created_at,updated_at:message.updated_at,reporter_id:'ou_reporter',owner_ids:['ou_owner'],evidence_ids:['om_root'],source_url:'https://example.test/source/1'};
class Ledger {
  constructor(){this.rows=[];this.writes=[];this.reads=0;}
  async records(){this.reads++;return structuredClone(this.rows);}
  async create(fields){const id=`rec_${this.rows.length+1}`;this.rows.push({id,fields:structuredClone(fields)});this.writes.push({id,fields});return id;}
  async update(id,fields){this.writes.push({id,fields});Object.assign(this.rows.find(r=>r.id===id).fields,structuredClone(fields));}
}

test('相同状态不写库，真实变化持久化；不同实例使用数据库当前值判断',async t=>{
  const d=database(t),a=new Store(d.db),b=new Store(d.db);
  for(const value of [null,false,0,'',{a:1},['x']]){
    await a.set('value',value);d.reset();await b.set('value',structuredClone(value));
    assert.equal(d.changes(),0,`重复值 ${JSON.stringify(value)} 不应写入`);
    assert.deepEqual(await b.state('value'),value);
  }
  await a.set('value',{a:1});await b.set('value',{a:2});d.reset();
  await a.set('value',{a:1});assert.equal(d.changes(),1);assert.deepEqual(await b.state('value'),{a:1});
});

test('重叠消息和重复分析确认不写库，编辑消息重新进入待分析队列',async t=>{
  const d=database(t),store=new Store(d.db);
  await store.putMessages([message],hash);await store.markAnalyzed([message.id]);d.reset();
  await store.putMessages([structuredClone(message)],hash);await store.markAnalyzed([message.id]);
  assert.equal(d.changes(),0);assert.deepEqual(await store.unanalyzed(),[]);
  const edited={...message,text:'问题再次出现',updated_at:'2026-10-22T02:00:00Z'};
  await store.putMessages([edited],hash);assert.equal(d.changes(),1);assert.deepEqual(await store.unanalyzed(),[edited]);
  await store.markAnalyzed([message.id]);assert.equal(d.changes(),2);assert.deepEqual(await store.unanalyzed(),[]);
});

test('相同问题不写库，进展和内容变化仍保存',async t=>{
  const d=database(t),store=new Store(d.db);await store.putIssues([issue]);d.reset();
  await store.putIssues([structuredClone(issue)]);assert.equal(d.changes(),0);
  const changed={...issue,status:'waiting_confirmation',note:'IT已提交验收'};
  await store.putIssues([changed]);assert.equal(d.changes(),1);assert.deepEqual(await store.rows('issues'),[changed]);
  await store.putIssues([{...changed,note:'补充处理说明'}]);assert.equal(d.changes(),2);
});

test('跳过重复写入仍暴露数据库故障，不把失败当成功',async()=>{
  const store=new Store({prepare(){return {bind(){return this;},async run(){throw new Error('database unavailable');}};}});
  await assert.rejects(()=>store.set('last_error',null),/database unavailable/);
});

test('锁互斥、心跳变化和故障审计仍真实保存',async t=>{
  const d=database(t),a=new Store(d.db),b=new Store(d.db),now=Date.parse('2026-10-22T02:00:00Z');
  const owner=await a.lock(now);assert.ok(owner);assert.equal(await b.lock(now+1),null);
  await b.unlock('wrong-owner');assert.equal(await b.lock(now+2),null);
  await a.unlock(owner);assert.ok(await b.lock(now+3));
  d.reset();await a.set('last_tick','2026-10-22T02:00:00Z');await a.set('last_tick','2026-10-22T02:01:00Z');
  await a.event('run_error',{message:'example failure'});await a.event('run_error',{message:'example failure'});
  assert.equal(d.changes(),4);assert.equal(await a.state('last_tick'),'2026-10-22T02:01:00Z');
});

test('台账未变化不反复写关联，下一分钟的人工进展仍被发现和保护',async t=>{
  const d=database(t),store=new Store(d.db),ledger=new Ledger();
  const run=(issues=[issue],minute=0)=>syncLedger({ledger,store,issues,members,now:new Date(Date.parse('2026-10-22T02:00:00Z')+minute*60000)});
  await run();await run();d.reset();ledger.writes=[];
  await run([issue],1);
  assert.equal(d.mutations.filter(m=>m.args[0]?.startsWith?.('ledger_map:')).reduce((n,m)=>n+m.changes,0),0);
  assert.equal(d.changes(),1,'新一轮同步时间仍写入');assert.equal(ledger.writes.length,0);
  ledger.rows[0].fields[F.status]=['已处理'];ledger.rows[0].fields[F.note]='同事直接确认完成';
  const result=await run([issue],2);
  assert.equal(result.summary.protected,1);assert.equal((await store.state(`ledger_map:${issue.id}`)).manual,true);
  await run([{...issue,status:'processing',note:'AI旧判断'}],3);
  assert.deepEqual(ledger.rows[0].fields[F.status],['已处理']);assert.equal(ledger.rows[0].fields[F.note],'同事直接确认完成');
  const effective=tableIssues(ledger.rows,{issues:[issue],members});assert.equal(effective[0].status,'closed');
  assert.doesNotMatch(JSON.stringify(buildCards(effective,{})),/部门筛选无法搜索/);
});

test('60轮每分钟检查30个未变问题：不重复写关联，检查和心跳继续运行且无额外消息',async t=>{
  const d=database(t),store=new Store(d.db),ledger=new Ledger(),start=Date.parse('2026-10-22T02:00:00Z');
  const issues=Array.from({length:30},(_,n)=>({...issue,id:`om_${n}:main`,root_id:`om_${n}`,title:`隔离测试问题${n}`,evidence_ids:[`om_${n}`],source_url:`https://example.test/source/${n}`}));
  await store.set('schedule',{enabled:true,enabled_at:new Date(start).toISOString()});
  await store.set('tracking_policy',{start_day:'2026-10-22'});await store.putIssues(issues);
  const env={DB:d.db,SOURCE_CHAT_ID:'oc_source',TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test',BOT_OPEN_ID:'ou_bot',BASE_LEDGER_ENABLED:'true',BASE_TOKEN:'fake',BASE_TABLE_ID:'tbl_fake',ALERT_NOTIFICATIONS_ENABLED:'false'};
  let lists=0,sends=0;
  const api={
    async members(){return members;},async list(){lists++;return [];},async getMessages(){return [];},async expandForwards(raw){return raw;},
    async sendCard(){sends++;throw new Error('本测试时间段不应发送');},
    async call(path,options){
      if(path.endsWith('/records')){const rows=await ledger.records(),fields=Object.values(F);return {data:rows.map(r=>fields.map(f=>r.fields[f]??null)),fields,record_id_list:rows.map(r=>r.id),has_more:false,rev:1};}
      if(path.endsWith('/records/batch_create'))return {record_id_list:[await ledger.create(options.data.create_records[0])]};
      if(path.endsWith('/records/batch_update')){for(const [id,fields]of Object.entries(options.data.update_records))await ledger.update(id,fields);return {};}
      throw new Error(`unexpected API ${path}`);
    }
  };
  await tick(env,{now:new Date(start),api});await tick(env,{now:new Date(start+60000),api});
  d.reset();ledger.writes=[];lists=0;const initialReads=ledger.reads;
  for(let minute=2;minute<62;minute++)assert.equal((await tick(env,{now:new Date(start+minute*60000),api})).ok,true);
  const mappingWrites=d.mutations.filter(m=>m.args[0]?.startsWith?.('ledger_map:')).reduce((n,m)=>n+m.changes,0);
  t.diagnostic(JSON.stringify({minute_checks:60,issues:30,mapping_row_changes:mappingWrites,total_row_changes:d.changes(),ledger_reads:ledger.reads-initialReads,command_list_calls:lists,ledger_writes:ledger.writes.length,sends}));
  assert.equal(mappingWrites,0);assert.equal(ledger.writes.length,0);assert.ok(ledger.reads-initialReads>=120);
  assert.ok(lists>=120);assert.equal(sends,0);
  assert.equal(await store.state('last_tick'),new Date(start+61*60000).toISOString());
  assert.equal(await store.state('last_command_poll'),new Date(start+61*60000).toISOString());
  assert.deepEqual(await store.state('schedule'),{enabled:true,enabled_at:new Date(start).toISOString()});
});
