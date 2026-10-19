import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {Store} from '../src/store.mjs';
import {queueSlot} from '../src/worker.mjs';
import {buildCards} from '../src/card.mjs';
import {hash,validateIssues} from '../src/core.mjs';
import {BASE_FIELDS as F,tableIssues} from '../src/ledger.mjs';
import {decodeCardCallback,acceptCardAction,processCardActions,actionResponse} from '../src/card-actions.mjs';

function database(){const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));return {prepare(query){let args=[];return {bind(...a){args=a;return this;},async first(){return sql.prepare(query).get(...args)||null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){const r=sql.prepare(query).run(...args);return {meta:{changes:Number(r.changes)}};}};},async batch(statements){return Promise.all(statements.map(s=>s.run()));}};}
const now=new Date('2026-10-16T04:00:00Z');
const env={FEISHU_APP_ID:'cli_example',FEISHU_VERIFICATION_TOKEN:'test-verification-token',CARD_ACTIONS_ENABLED:'true',SOURCE_CHAT_ID:'oc_source',TARGET_CHAT_ID:'oc_test',ALLOWED_TARGET_CHAT_ID:'oc_test',PRODUCTION_CHAT_ID:'oc_source',PRODUCTION_START_AT:'2026-10-16T01:30:00Z',BASE_TABLE_URL:'https://example.test/table'};
const members={ou_actor:'确认同事',ou_it:'IT同事'};
const issue={id:'om_root:main',root_id:'om_root',facet:'main',record_id:'rec_main',title:'筛选异常',status:'pending',owner_ids:['ou_it'],reporter_id:'ou_actor',note:'原人工说明请保留',created_at:'2026-10-16T01:00:00Z',updated_at:'2026-10-16T01:00:00Z',evidence_ids:['om_root'],source_url:'https://example.test/source'};
class Ledger {constructor(){this.rows=[{id:issue.record_id,fields:{[F.title]:issue.title,[F.key]:issue.id,[F.status]:['待IT跟进'],[F.note]:issue.note,[F.manual]:true,[F.evidence]:''}}];this.writes=[];}async records(){return structuredClone(this.rows);}async update(id,fields){this.writes.push(structuredClone(fields));Object.assign(this.rows.find(r=>r.id===id).fields,fields);}}
function body(eventId='event_1'){return {schema:'2.0',header:{event_id:eventId,app_id:env.FEISHU_APP_ID,event_type:'card.action.trigger',token:env.FEISHU_VERIFICATION_TOKEN,create_time:String(now.getTime()*1000),tenant_key:'tenant_example'},event:{operator:{open_id:'ou_actor',tenant_key:'tenant_example'},action:{tag:'button',value:{action:'resolve_issue',issue_id:issue.id,record_id:issue.record_id}},context:{open_message_id:'om_card',open_chat_id:'oc_test'}}};}
const request=b=>new Request('https://example.test/feishu/card-actions',{method:'POST',body:JSON.stringify(b)});
async function setup({formal=false}={}){const store=new Store(database()),ledger=new Ledger(),patches=[];await store.set('members',members);await store.putIssues([issue]);await store.set(`ledger_map:${issue.id}`,{record_id:issue.record_id,manual:true});await queueSlot(env,store,{ledger:true,issues:[issue],members,cutoff:now},{id:'1330',scheduled_at:now.toISOString()},formal?'schedule':'test-card-actions',now);const delivery=(await store.pending())[0];await store.mark(delivery.id,'sent','om_card');const api={async members(){return members;},async call(path,options){assert.equal(options.method,'PATCH','不允许发送新群消息');assert.equal(path,'/im/v1/messages/om_card');patches.push(JSON.parse(options.data.content));return {};}};return {store,ledger,api,patches};}
function buttons(node){if(!node||typeof node!=='object')return [];return [...(node.tag==='button'?[node]:[]),...Object.values(node).flatMap(v=>typeof v==='object'?Array.isArray(v)?v.flatMap(buttons):buttons(v):[])];}

test('每项按钮有原题二次确认；新汇总仍不显示已解决事项',()=>{const card=buildCards([issue,{...issue,id:'other',record_id:'rec_other',status:'closed',title:'已经完成的事项'}],{actions:true})[0];const b=buttons(card);assert.equal(b.length,1);assert.equal(b[0].text.content,'标记已解决');assert.match(b[0].confirm.title.content,/确认/);assert.ok(b[0].confirm.text.content.includes(issue.title));assert.equal(b[0].disabled,false);assert.equal(JSON.stringify(card).includes('已经完成的事项'),false);});
test('请求网址验证只返回challenge；错误token、其他应用和过期事件均拒绝',async()=>{assert.deepEqual(await decodeCardCallback(request({type:'url_verification',token:env.FEISHU_VERIFICATION_TOKEN,challenge:'check'}),env,now.getTime()),{challenge:'check'});const valid=body();assert.equal((await decodeCardCallback(request(valid),env,now.getTime())).header.event_id,'event_1');for(const changed of [{...valid,header:{...valid.header,token:'wrong'}},{...valid,header:{...valid.header,app_id:'cli_other'}},{...valid,header:{...valid.header,create_time:'1000000000000000'}}])await assert.rejects(()=>decodeCardCallback(request(changed),env,now.getTime()));});
test('加密回调需通过解密、签名和token三重核对',async()=>{const keyText='test-encryption-key',key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(keyText)),'AES-CBC',false,['encrypt']),iv=crypto.getRandomValues(new Uint8Array(16));const encoded=new Uint8Array(await crypto.subtle.encrypt({name:'AES-CBC',iv},key,new TextEncoder().encode(JSON.stringify(body()))));const combined=new Uint8Array(iv.length+encoded.length);combined.set(iv);combined.set(encoded,16);const raw=JSON.stringify({encrypt:btoa(String.fromCharCode(...combined))}),timestamp=String(now.getTime()/1000),nonce='sample_nonce',signature=await hash(timestamp+nonce+keyText+raw);const req=new Request('https://example.test/callback',{method:'POST',body:raw,headers:{'X-Lark-Request-Timestamp':timestamp,'X-Lark-Request-Nonce':nonce,'X-Lark-Signature':signature}});assert.equal((await decodeCardCallback(req,{...env,FEISHU_ENCRYPT_KEY:keyText},now.getTime())).event.operator.open_id,'ou_actor');await assert.rejects(()=>decodeCardCallback(new Request('https://example.test/callback',{method:'POST',body:raw}),{...env,FEISHU_ENCRYPT_KEY:keyText},now.getTime()),/签名/);});
test('回调绑定原卡片、原群和原记录，不能用篡改参数关闭其他问题',async()=>{const {store}=await setup();for(const mutate of [b=>{b.event.action.value.record_id='rec_else';},b=>{b.event.context.open_chat_id='oc_else';},b=>{b.event.context.open_message_id='om_else';}]){const bad=body();mutate(bad);await assert.rejects(()=>acceptCardAction(bad,env,store,now));}await acceptCardAction(body(),env,store,now);const conflicting=body();conflicting.event.operator.open_id='ou_it';await assert.rejects(()=>acceptCardAction(conflicting,env,store,now),/重复回调/);});
test('确认后只写原记录进展和证据，保留人工内容；原卡片按钮灰显已解决，不发新消息',async()=>{const {store,ledger,api,patches}=await setup();await acceptCardAction(body(),env,store,now);const [result]=await processCardActions(env,store,api,{ledger,now,eventId:'event_1'});assert.equal(result.state,'done');assert.deepEqual(ledger.rows[0].fields[F.status],['已处理']);assert.equal(ledger.rows[0].fields[F.note],issue.note);assert.equal(ledger.rows[0].fields[F.manual],true);assert.match(ledger.rows[0].fields[F.evidence],/ou_actor/);assert.equal(patches.length,1);const b=buttons(patches[0]).find(b=>b.behaviors?.[0]?.value?.issue_id===issue.id);assert.equal(b.text.content,'已解决');assert.equal(b.disabled,true);assert.equal(b.confirm,undefined);assert.equal(actionResponse(result).toast.type,'success');const effective=tableIssues(ledger.rows);assert.equal(JSON.stringify(buildCards(effective)).includes(issue.title),false);const cached=(await store.rows('issues'))[0];assert.equal(cached.resolution.type,'card_button');});
test('重复投递或再次点击不重复写入，不把转需求覆盖为普通已解决',async()=>{const {store,ledger,api}=await setup();await acceptCardAction(body(),env,store,now);await processCardActions(env,store,api,{ledger,now,eventId:'event_1'});await acceptCardAction(body(),env,store,now);await processCardActions(env,store,api,{ledger,now,eventId:'event_1'});assert.equal(ledger.writes.length,1);await acceptCardAction(body('event_2'),env,store,now);const [again]=await processCardActions(env,store,api,{ledger,now,eventId:'event_2'});assert.equal(again.state,'already_resolved');assert.equal(ledger.writes.length,1);ledger.rows[0].fields[F.status]=['转大表需求'];await acceptCardAction(body('event_3'),env,store,now);await processCardActions(env,store,api,{ledger,now,eventId:'event_3'});assert.deepEqual(ledger.rows[0].fields[F.status],['转大表需求']);assert.equal(ledger.writes.length,1);});
test('更新回执不明时下轮先核对真实进展和证据，不重复写入',async()=>{const {store,ledger,api}=await setup();await acceptCardAction(body(),env,store,now);const write=ledger.update.bind(ledger);ledger.update=async(...args)=>{await write(...args);throw new Error('response timeout');};const [pending]=await processCardActions(env,store,api,{ledger,now,eventId:'event_1'});assert.equal(pending.state,'queued');assert.notEqual(actionResponse(pending).toast.type,'success');const [done]=await processCardActions(env,store,api,{ledger,now:new Date(now.getTime()+61000),eventId:'event_1'});assert.equal(done.state,'done');assert.equal(ledger.writes.length,1);});
test('卡片刷新失败不会重复修改数据；退出群的人不能提交完成确认',async()=>{const a=await setup();await acceptCardAction(body(),env,a.store,now);const patch=a.api.call;a.api.call=async()=>{throw new Error('patch temporarily unavailable');};const [pending]=await processCardActions(env,a.store,a.api,{ledger:a.ledger,now,eventId:'event_1'});assert.equal(pending.state,'refresh_pending');a.api.call=patch;const [done]=await processCardActions(env,a.store,a.api,{ledger:a.ledger,now:new Date(now.getTime()+61000),eventId:'event_1'});assert.equal(done.state,'done');assert.equal(a.ledger.writes.length,1);const b=await setup();b.api.members=async()=>({});await acceptCardAction(body(),env,b.store,now);const [denied]=await processCardActions(env,b.store,b.api,{ledger:b.ledger,now,eventId:'event_1'});assert.equal(denied.state,'failed');assert.equal(b.ledger.writes.length,0);});
test('卡片人工确认之后，AI不能重新打开同一事项',()=>{const root={id:'om_root',sender_type:'user',sender_id:'ou_actor',created_at:issue.created_at},closed={...issue,status:'closed',resolution:{type:'card_button'}};assert.equal(validateIssues([{...issue,status:'pending',reporter_id:'ou_actor',facet:'main'}],[root],[closed],members)[0].status,'closed');});
test('刷新原卡片保留原页数和范围，不套用最新汇总的页码',async()=>{const {store,ledger,api,patches}=await setup();for(let n=0;n<7;n++)ledger.rows.push({id:`rec_extra${n}`,fields:{[F.title]:`新增问题${n}`,[F.status]:['待IT跟进']}});await acceptCardAction(body(),env,store,now);await processCardActions(env,store,api,{ledger,now:new Date(now.getTime()+60000),eventId:'event_1'});const footer=patches[0].body.elements.find(e=>e.tag==='markdown'&&e.content.includes('统计截止'));assert.ok(!footer.content.includes('第1/2页'));assert.ok(footer.content.includes('统计截止 2026-10-16 12:01'));assert.ok(!JSON.stringify(patches[0]).includes('新增问题0'));});

test('正式群的外部企业成员可以确认已解决，实时核对群成员且只刷新原卡片',async()=>{
 const{store,ledger,api,patches}=await setup({formal:true});
 const external=body('external_member');external.event.operator.tenant_key='external_enterprise';external.event.context.open_chat_id=env.PRODUCTION_CHAT_ID;
 let memberChecks=0;api.members=async chat=>{memberChecks++;assert.equal(chat,env.PRODUCTION_CHAT_ID);return members;};
 const decoded=await decodeCardCallback(request(external),env,now.getTime());
 await acceptCardAction(decoded,env,store,now);
 const[result]=await processCardActions(env,store,api,{ledger,now,eventId:external.header.event_id});
 assert.equal(result.state,'done');assert.equal(memberChecks,1);assert.equal(ledger.writes.length,1);
 assert.deepEqual(ledger.rows[0].fields[F.status],['已处理']);assert.equal(ledger.rows[0].fields[F.note],issue.note);
 assert.equal(ledger.rows[0].fields[F.manual],true);assert.match(ledger.rows[0].fields[F.evidence],/ou_actor/);
 assert.equal(patches.length,1);const b=buttons(patches[0]).find(b=>b.behaviors?.[0]?.value?.issue_id===issue.id);
 assert.equal(b.text.content,'已解决');assert.equal(b.disabled,true);
});

test('外部企业非群成员即使仍在缓存名单里也不能改状态或刷新卡片',async()=>{
 const{store,ledger,api,patches}=await setup({formal:true});
 await store.set('members',{...members,ou_outsider:'已退出群的外部成员'});
 const external=body('external_outsider');external.event.operator={open_id:'ou_outsider',tenant_key:'external_enterprise'};external.event.context.open_chat_id=env.PRODUCTION_CHAT_ID;
 const decoded=await decodeCardCallback(request(external),env,now.getTime());await acceptCardAction(decoded,env,store,now);
 let memberChecks=0;api.members=async chat=>{memberChecks++;assert.equal(chat,env.PRODUCTION_CHAT_ID);return members;};
 const[result]=await processCardActions(env,store,api,{ledger,now,eventId:external.header.event_id});
 assert.equal(memberChecks,1);assert.equal(result.state,'failed');assert.equal(result.error,'操作人不在该群');
 assert.equal(ledger.writes.length,0);assert.equal(patches.length,0);assert.deepEqual(ledger.rows[0].fields[F.status],['待IT跟进']);
});

test('外部成员仍受来源、时效和原卡片关联校验约束',async()=>{
 const{store,ledger,patches}=await setup({formal:true});
 const external=body('external_security');external.event.operator.tenant_key='external_enterprise';external.event.context.open_chat_id=env.PRODUCTION_CHAT_ID;
 for(const mutate of [b=>{b.header.token='wrong';},b=>{b.header.app_id='cli_other';},b=>{b.header.create_time='1000000000000000';}]){
  const bad=structuredClone(external);mutate(bad);await assert.rejects(()=>decodeCardCallback(request(bad),env,now.getTime()));
 }
 const decoded=await decodeCardCallback(request(external),env,now.getTime());
 for(const mutate of [b=>{b.event.context.open_chat_id='oc_else';},b=>{b.event.context.open_message_id='om_else';},b=>{b.event.action.value.record_id='rec_else';},b=>{b.event.action.value.issue_id='om_other:main';}]){
  const bad=structuredClone(decoded);mutate(bad);await assert.rejects(()=>acceptCardAction(bad,env,store,now));
 }
 assert.equal(ledger.writes.length,0);assert.equal(patches.length,0);
});
