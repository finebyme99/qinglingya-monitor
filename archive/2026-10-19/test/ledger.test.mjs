import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseLedger,BASE_FIELDS as F,syncLedger,tableIssues,matchRecord } from '../src/ledger.mjs';
import { buildCards } from '../src/card.mjs';
import { clearTransferText,validateIssues } from '../src/core.mjs';
import { resolveCommand,isResolutionCommand } from '../src/tracking.mjs';

class Memory {constructor(){this.values=new Map();}async state(k){return structuredClone(this.values.get(k)||null);}async set(k,v){this.values.set(k,structuredClone(v));}}
class FakeLedger {
  constructor(rows=[]){this.rows=structuredClone(rows);this.creates=0;this.writes=[];}
  async records(){return structuredClone(this.rows);}
  async create(fields){const id=`rec_${++this.creates}`;this.rows.push({id,fields:structuredClone(fields)});return id;}
  async update(id,fields){this.writes.push({id,fields:structuredClone(fields)});Object.assign(this.rows.find(r=>r.id===id).fields,structuredClone(fields));}
}
const members={ou_reporter:'反馈人',ou_owner:'IT同事',ou_other:'其他同事'};
const issue={id:'om_root:main',root_id:'om_root',facet:'main',title:'部门筛选无法搜索',status:'pending',note:'等待跟进',created_at:'2026-10-14T01:00:13.123Z',updated_at:'2026-10-16T01:00:00Z',reporter_id:'ou_reporter',owner_ids:['ou_owner'],evidence_ids:['om_root'],source_url:'https://applink.feishu.cn/client/chat/open?openChatId=oc_source&position=1'};
const run=(ledger,store,issues=[issue])=>syncLedger({ledger,store,issues,members,now:new Date('2026-10-16T02:30:00Z')});
test('首次同步保留空白占位，重复同步与重启只关联原记录，不重复创建',async()=>{
  const ledger=new FakeLedger([{id:'rec_blank',fields:{[F.title]:null,[F.status]:[]}}]),store=new Memory();
  await run(ledger,store);await run(ledger,store);
  assert.equal(ledger.creates,1);assert.equal(ledger.rows.length,2);assert.equal(ledger.rows[0].fields[F.title],null);
  assert.equal(ledger.rows[1].fields[F.key],issue.id);assert.deepEqual(ledger.rows[1].fields[F.status],['待IT跟进']);
  assert.equal(ledger.writes.length,0);
});
test('Base把URL自动规范成Markdown链接后，不误判人工修改，卡片仍使用真实URL',async()=>{
  const ledger=new FakeLedger(),store=new Memory();const create=ledger.create.bind(ledger);
  ledger.create=async fields=>create({...fields,[F.source]:`[${fields[F.source]}](${fields[F.source]})`,[F.created]:'2026-10-14T09:00:13.123+08:00'});
  await run(ledger,store);const result=await run(ledger,store);
  assert.equal(result.summary.protected,0);assert.equal(ledger.rows[0].fields[F.manual],false);
  assert.equal(tableIssues(result.rows,{issues:[issue],members})[0].source_url,issue.source_url);
});
test('已有人工记录按来源或完整标题关联，仅补充证据，原进展和内容不覆盖',async()=>{
  const original={[F.title]:issue.title,[F.status]:['转大表需求'],[F.note]:'人工判断：转后续需求处理',[F.source]:issue.source_url};
  const ledger=new FakeLedger([{id:'rec_human',fields:original}]),store=new Memory();
  await run(ledger,store,[{...issue,status:'processing',note:'AI认为还在修复'}]);
  assert.equal(ledger.creates,0);
  for(const [key,value]of Object.entries(original))assert.deepEqual(ledger.rows[0].fields[key],value);
  assert.equal(ledger.rows[0].fields[F.manual],true);
  const effective=tableIssues(ledger.rows,{issues:[issue],members});assert.equal(effective[0].status,'converted');assert.equal(effective[0].note,original[F.note]);
});
test('未人工修改的事项在同一进展列更新，不重复建行',async()=>{
  const ledger=new FakeLedger(),store=new Memory();await run(ledger,store);
  await run(ledger,store,[{...issue,status:'waiting_confirmation',note:'处理已提交验收',evidence_ids:['om_root','om_result']}]);
  assert.equal(ledger.creates,1);assert.deepEqual(ledger.rows[0].fields[F.status],['待HRIS反馈']);
  assert.equal(ledger.rows[0].fields[F.evidence].split('\n').length,2);
  for(const write of ledger.writes){assert.equal(Object.hasOwn(write.fields,F.status),true);assert.equal(Object.hasOwn(write.fields,F.note),true);assert.equal(Object.hasOwn(write.fields,F.title),false);}
});
test('人工修改后冻结AI进展，继续追加证据；即使无新群消息，人工进展进入统计且已解决不列明细',async()=>{
  const ledger=new FakeLedger(),store=new Memory();await run(ledger,store);
  ledger.rows[0].fields[F.status]=['已处理'];ledger.rows[0].fields[F.note]='人工确认已解决';
  await run(ledger,store,[{...issue,status:'processing',note:'AI又说在处理中'}]);
  assert.equal(ledger.rows[0].fields[F.note],'人工确认已解决');assert.deepEqual(ledger.rows[0].fields[F.status],['已处理']);
  assert.equal(ledger.rows[0].fields[F.manual],true);
  const cards=buildCards(tableIssues(ledger.rows,{issues:[issue],members}),{});
  assert.doesNotMatch(JSON.stringify(cards),/人工确认已解决|【已解决】|部门筛选无法搜索/);assert.match(JSON.stringify(cards),/>1<\/font>/);
});
test('扫描后、写入前发生人工编辑，二次读取能发现并保留',async()=>{
  const ledger=new FakeLedger(),store=new Memory();await run(ledger,store);
  const records=ledger.records.bind(ledger);let reads=0;
  ledger.records=async()=>{if(++reads===2){ledger.rows[0].fields[F.status]=['转大表需求'];ledger.rows[0].fields[F.note]='人工刚修改的判断';}return records();};
  const result=await run(ledger,store,[{...issue,status:'closed',note:'AI确认完成'}]);
  assert.deepEqual(ledger.rows[0].fields[F.status],['转大表需求']);
  assert.equal(tableIssues(result.rows,{issues:[issue],members})[0].status,'converted');
  assert.equal(ledger.rows[0].fields[F.manual],true);
  assert.equal(ledger.writes.some(w=>Object.hasOwn(w.fields,F.status)),false);
});
test('人工可直接改同一进展列；取消人工接管后才恢复自动更新',async()=>{
  const ledger=new FakeLedger(),store=new Memory();await run(ledger,store);
  ledger.rows[0].fields[F.status]=['待HRIS反馈'];await run(ledger,store,[{...issue,status:'closed',note:'确认完成'}]);
  assert.deepEqual(ledger.rows[0].fields[F.status],['待HRIS反馈']);
  ledger.rows[0].fields[F.manual]=false;
  await run(ledger,store,[{...issue,status:'closed',note:'确认完成'}]);
  assert.deepEqual(ledger.rows[0].fields[F.status],['已处理']);assert.equal((await store.state(`ledger_map:${issue.id}`)).manual,false);
});
test('新增响应超时后按事项标识找回，找不到时不盲目重发',async()=>{
  const ledger=new FakeLedger(),store=new Memory();const create=ledger.create.bind(ledger);
  ledger.create=async fields=>{await create(fields);throw new Error('timeout');};
  await assert.rejects(()=>run(ledger,store),/timeout/);
  await run(ledger,store);assert.equal(ledger.creates,1);assert.equal(ledger.rows[0].fields[F.manual],false);
  const empty=new FakeLedger(),other=new Memory();empty.create=async()=>{throw new Error('timeout');};
  await assert.rejects(()=>run(empty,other),/timeout/);await assert.rejects(()=>run(empty,other),/不重复创建/);
});
test('关联记录被删或出现重复标识时明确停下，不重新建单',async()=>{
  const ledger=new FakeLedger(),store=new Memory();await run(ledger,store);ledger.rows=[];
  await assert.rejects(()=>run(ledger,store),/记录被删除/);assert.equal(ledger.creates,1);
  assert.throws(()=>matchRecord(issue,[{id:'one',fields:{[F.key]:issue.id}},{id:'two',fields:{[F.key]:issue.id}}]),/重复/);
});
test('转需求仍留在表中并计入已解决，卡片不展示已解决或转需求明细',()=>{
  const rows=[{id:'manual',fields:{[F.title]:'人工录入事项',[F.status]:['转大表需求'],[F.note]:'需求后续跟进'}},{id:'auto',fields:{[F.title]:'AI收集事项',[F.status]:['已处理'],[F.note]:'已解决'}}];
  const items=tableIssues(rows,{members}),card=buildCards(items,{})[0],content=JSON.stringify(card);
  assert.equal(items.length,2);assert.equal(items[0].status,'converted');assert.doesNotMatch(content,/【转需求】|【已解决】|人工录入事项|AI收集事项/);assert.match(content,/>2<\/font>/);assert.equal(content.includes('id=null'),false);
});
test('转需求必须是已作出的决定；任何群成员的明确回复都可闭环',()=>{
  assert.equal(clearTransferText('这个问题转需求后续跟进解决'),true);assert.equal(clearTransferText('建议转需求'),false);assert.equal(clearTransferText('不要转需求'),false);
  const message={id:'reply',text:'转大表需求后续跟进',sender_type:'user',sender_id:'ou_other',parent_id:issue.root_id,root_id:null,mentions:[{id:'ou_bot'}],created_at:'2026-10-16T02:00:00Z'};
  assert.equal(isResolutionCommand(message,'ou_bot'),true);assert.equal(resolveCommand(message,[issue]).outcomes[issue.id],'converted');
  const root={id:issue.root_id,sender_id:'ou_reporter',sender_type:'user',created_at:issue.created_at,source_url:issue.source_url};
  const raw={...issue,status:'converted',closure_message_id:message.id,evidence_ids:[root.id,message.id]};
  assert.equal(validateIssues([raw],[root,message],[],members)[0].status,'converted');
  assert.equal(validateIssues([{...raw,status:'closed'}],[root,{...message,text:'已处理完成'}],[],members)[0].status,'closed');
});
test('原生Base接口读完分页并验证字段对应关系，读取不完整绝不生成卡片',async()=>{
  const replies=[{data:[['标题一']],fields:['标题'],record_id_list:['rec_1'],has_more:true,rev:1},{data:[['标题二']],fields:['标题'],record_id_list:['rec_2'],has_more:false,rev:1}];
  const api={async call(path,options){assert.equal(options.params.offset,replies.length===2?0:1);return replies.shift();}};
  const ledger=new BaseLedger(api,{BASE_TOKEN:'fake',BASE_TABLE_ID:'tbl_fake'});assert.equal((await ledger.records()).length,2);
  api.call=async()=>({data:[[1]],fields:['标题','进展'],record_id_list:['rec_bad'],has_more:false});await assert.rejects(()=>ledger.records(),/字段与值不对应/);
});
