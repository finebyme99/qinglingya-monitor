import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.mjs';
import { BASE_FIELDS as F } from '../src/ledger.mjs';
import { tick } from '../src/worker.mjs';

const at=time=>new Date(`2026-10-22T${time}:00+08:00`);
const issue={id:'om_root:main',root_id:'om_root',facet:'main',title:'隔离测试：待办页面空白',status:'pending',note:'等待处理',created_at:at('08:00').toISOString(),updated_at:at('08:00').toISOString(),reporter_id:'ou_reporter',owner_ids:['ou_it'],evidence_ids:['om_root'],source_url:'https://example.test/source'};
function setup(t,enabledAt='09:00'){
  const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>sql.close());
  const db={prepare(query){let args=[];return {bind(...values){args=values;return this;},async first(){return sql.prepare(query).get(...args)||null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){return {meta:{changes:Number(sql.prepare(query).run(...args).changes)}};}};},async batch(statements){const results=[];for(const statement of statements)results.push(await statement.run());return results;}};
  const store=new Store(db),rows=[],calls={records:0,lists:[],members:0,writes:0,sends:[]};let failRead=false;
  const api={
    async members(){calls.members++;return {ou_reporter:'反馈同事',ou_it:'IT同事'};},
    async list(...args){calls.lists.push(args);return [];},async getMessages(){return [];},async expandForwards(raw){return raw;},
    async call(path,options){
      if(path.endsWith('/records')){calls.records++;if(failRead)throw new Error('ledger unavailable');const fields=Object.values(F);return {fields,data:rows.map(r=>fields.map(f=>r.fields[f]??null)),record_id_list:rows.map(r=>r.id),has_more:false,rev:1};}
      if(path.endsWith('/records/batch_create')){calls.writes++;const id=`rec_${rows.length+1}`;rows.push({id,fields:structuredClone(options.data.create_records[0])});return {record_id_list:[id]};}
      if(path.endsWith('/records/batch_update')){calls.writes++;for(const [id,fields]of Object.entries(options.data.update_records))Object.assign(rows.find(r=>r.id===id).fields,structuredClone(fields));return {};}
      throw new Error(`unexpected API ${path}`);
    },
    async sendCard(card,uuid,target){calls.sends.push({card,target});return {message_id:`om_sent_${calls.sends.length}`,chat_id:target};}
  };
  const env={DB:db,SOURCE_CHAT_ID:'oc_source',TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test',PRODUCTION_CHAT_ID:'oc_source',PRODUCTION_START_AT:at('00:00').toISOString(),BOT_OPEN_ID:'ou_bot',BASE_LEDGER_ENABLED:'true',BASE_TOKEN:'fake',BASE_TABLE_ID:'tbl_fake',ALERT_NOTIFICATIONS_ENABLED:'false'};
  const ready=async()=>{await store.set('schedule',{enabled:true,enabled_at:at(enabledAt).toISOString()});await store.set('tracking_policy',{start_day:'2026-10-22'});await store.putIssues([issue]);};
  return {store,rows,calls,api,env,ready,failRead(value){failRead=value;},run(time){return tick(env,{now:at(time),api});}};
}

test('普通分钟只保留健康心跳，不读取群、人员或业务表',async t=>{
  const h=setup(t);await h.ready();
  for(const time of ['09:00','09:19'])assert.equal((await h.run(time)).ok,true);
  assert.equal(h.calls.records,0);assert.equal(h.calls.lists.length,0);assert.equal(h.calls.members,0);assert.equal(h.calls.sends.length,0);
  assert.equal(await h.store.state('last_tick'),at('09:19').toISOString());assert.equal(await h.store.state('last_sync'),null);
});

test('节点前10分钟集中识别一次，后续分钟不重复分析或同步',async t=>{
  const h=setup(t);await h.ready();await h.run('09:20');const counts=structuredClone(h.calls);
  for(const time of ['09:21','09:25','09:29'])await h.run(time);
  assert.deepEqual(h.calls,counts);assert.equal(await h.store.state('last_sync'),at('09:20').toISOString());
  assert.ok(await h.store.state('prepared:schedule:2026-10-22:0930'));assert.equal(h.calls.sends.length,0);
});

test('三个原节点准点走读取最新表格路径，准备后人工改动优先，重复触发不重发',async t=>{
  for(const [prepare,push,slot]of [['09:20','09:30','0930'],['13:20','13:30','1330'],['15:50','16:00','1600']]){
    await t.test(slot,async sub=>{
      const h=setup(sub,prepare);await h.ready();await h.run(prepare);const listCount=h.calls.lists.length,memberCount=h.calls.members,writes=h.calls.writes;
      h.rows[0].fields[F.status]=['已处理'];h.rows[0].fields[F.note]='准备结束后人工确认';
      await h.run(push);await h.run(push);
      assert.equal(h.calls.lists.length,listCount);assert.equal(h.calls.members,memberCount);assert.equal(h.calls.writes,writes);
      assert.equal(h.calls.sends.length,1);assert.equal(h.calls.sends[0].target,'oc_source');assert.doesNotMatch(JSON.stringify(h.calls.sends[0].card),/隔离测试：待办页面空白/);
      assert.equal((await h.store.delivery(`schedule:2026-10-22:${slot}:1`)).state,'sent');
      assert.deepEqual(h.rows[0].fields[F.status],['已处理']);
    });
  }
});

test('错过准备唤醒时先补齐识别再发送，失败不使用旧缓存冒充最新进展',async t=>{
  const h=setup(t);await h.ready();h.failRead(true);
  await assert.rejects(()=>h.run('09:30'),/ledger unavailable/);assert.equal(h.calls.sends.length,0);assert.equal(await h.store.state('prepared:schedule:2026-10-22:0930'),null);
  h.failRead(false);await h.run('09:31');assert.equal(h.calls.sends.length,1);assert.ok(await h.store.state('prepared:schedule:2026-10-22:0930'));
});

test('已准备但推送时表格读失败，停止发卡；恢复后仍按原投递ID只发一次',async t=>{
  const h=setup(t);await h.ready();await h.run('09:20');h.failRead(true);
  await assert.rejects(()=>h.run('09:30'),/ledger unavailable/);assert.equal(h.calls.sends.length,0);
  h.failRead(false);await h.run('09:31');assert.equal(h.calls.sends.length,1);
});

test('周末不做集中识别或推送，分钟健康心跳保留',async t=>{
  const h=setup(t);await h.ready();const now=new Date('2026-10-24T09:20:00+08:00');await tick(h.env,{now,api:h.api});
  assert.equal(h.calls.records,0);assert.equal(h.calls.lists.length,0);assert.equal(h.calls.sends.length,0);assert.equal(await h.store.state('last_tick'),now.toISOString());
});

test('集中识别沿用上次断点，跨日间隔不遗漏消息',async t=>{
  const h=setup(t);await h.ready();const last='2026-10-21T07:50:00.000Z';await h.store.set('last_sync',last);await h.store.set('last_command_poll',last);await h.store.set('command_rules_version','20261016-any-member-and-transfer-v2');
  await h.run('09:20');assert.equal(h.calls.lists.length,3);assert.ok(h.calls.lists.every(args=>args[2]===Date.parse(last)-300000));
});
