import { hash } from './core.mjs';

export const BASE_FIELDS={title:'标题',status:'进展',note:'内容',created:'提出时间',owners:'IT跟进人',reporter:'反馈人',source:'原消息链接',key:'事项标识',evidence:'AI证据',aiTime:'AI更新时间',manual:'人工接管'};
export const TABLE_STATUS={pending:'待IT跟进',processing:'待IT跟进',blocked:'待IT跟进',waiting_confirmation:'待HRIS反馈',closed:'已处理',converted:'转大表需求'};
const FROM_TABLE={'待IT跟进':'pending','待HRIS反馈':'waiting_confirmation','待HRIS确认':'waiting_confirmation','已处理':'closed','已解决':'closed','转大表需求':'converted','转需求':'converted'};
export const ledgerEnabled=env=>env.BASE_LEDGER_ENABLED==='true';
const text=v=>v==null?'':Array.isArray(v)?v.map(text).join(''):typeof v==='object'?String(v.text??v.name??v.url??''):String(v);
const url=v=>{const value=text(v).trim();return value.match(/^\[[\s\S]*\]\((https?:\/\/[\s\S]*)\)$/)?.[1]||value;};
const ids=v=>(Array.isArray(v)?v:[]).map(p=>typeof p==='string'?p:p.id).filter(Boolean);
const normalizedTitle=v=>text(v).normalize('NFKC').replace(/[\s“”"'，。！？、：:；;（）()【】\[\]]/g,'');
const meaningful=r=>!!text(r.fields[BASE_FIELDS.title]).trim();
export function originalSnapshot(fields) {
  const values={};
  for(const key of ['title','status','note','created','owners','reporter','source']) {
    const field=BASE_FIELDS[key],value=fields[field];
    if(key==='owners')values[field]=ids(value).sort();
    else if(key==='created') {const s=text(value);const time=s?Date.parse(/[Zz]|[+-]\d\d:\d\d$/.test(s)?s:s.replace(' ','T')+'+08:00'):NaN;values[field]=Number.isFinite(time)?Math.floor(time/60000):s;}
    else values[field]=key==='source'?url(value):text(value);
  }
  return values;
}
function assertResult(data) {
  if((data?.ignored_fields||[]).length)throw new Error('多维表格忽略了写入字段，请核对字段配置');
  return data;
}
export class BaseLedger {
  constructor(api,env){this.api=api;this.env=env;if(!env.BASE_TOKEN||!env.BASE_TABLE_ID)throw new Error('缺少问题台账地址');this.path=`/base/v3/bases/${env.BASE_TOKEN}/tables/${env.BASE_TABLE_ID}`;}
  async fields(){const d=await this.api.call(`${this.path}/fields`,{params:{limit:300,offset:0}});if(!Array.isArray(d.fields)||d.has_more)throw new Error('台账字段未读取完整');return d.fields;}
  async records(){
    const rows=[];let revision;
    for(let offset=0;offset<10000;) {
      const d=await this.api.call(`${this.path}/records`,{params:{limit:200,offset}});
      if(!Array.isArray(d.data)||!Array.isArray(d.record_id_list)||!Array.isArray(d.fields)||d.data.length!==d.record_id_list.length)throw new Error('台账记录结构不完整');
      if(revision!=null&&d.rev!==revision)throw new Error('台账读取期间发生变更，下一轮重新读取');revision=d.rev;
      d.data.forEach((values,n)=>{if(values.length!==d.fields.length)throw new Error('台账字段与值不对应');rows.push({id:d.record_id_list[n],fields:Object.fromEntries(d.fields.map((field,i)=>[field,values[i]]))});});
      if(!d.has_more)return rows;
      if(!d.data.length)throw new Error('台账分页没有推进');offset+=d.data.length;
    }
    throw new Error('台账记录超出单轮读取上限');
  }
  async create(fields){const d=assertResult(await this.api.call(`${this.path}/records/batch_create`,{method:'POST',data:{create_records:[fields]}}));const id=d.record_id_list?.[0];if(!id||d.record_id_list.length!==1)throw new Error('台账新增回执缺少唯一记录ID');return id;}
  async update(id,fields){if(Object.keys(fields).length)assertResult(await this.api.call(`${this.path}/records/batch_update`,{method:'POST',data:{update_records:{[id]:fields}}}));}
}

export function matchRecord(issue,rows) {
  const byKey=rows.filter(r=>text(r.fields[BASE_FIELDS.key])===issue.id);
  if(byKey.length>1)throw new Error(`台账事项标识重复：${issue.title}`);
  if(byKey.length===1)return byKey[0];
  const bySource=rows.filter(r=>meaningful(r)&&issue.source_url&&url(r.fields[BASE_FIELDS.source])===issue.source_url&&normalizedTitle(r.fields[BASE_FIELDS.title])===normalizedTitle(issue.title));
  if(bySource.length>1)throw new Error(`台账存在多条相同来源的问题：${issue.title}`);
  if(bySource.length===1)return bySource[0];
  const byTitle=rows.filter(r=>meaningful(r)&&normalizedTitle(r.fields[BASE_FIELDS.title])===normalizedTitle(issue.title)&&!text(r.fields[BASE_FIELDS.key])&&!text(r.fields[BASE_FIELDS.source]));
  if(byTitle.length>1)throw new Error(`台账同名人工记录需要核对：${issue.title}`);
  return byTitle[0]||null;
}
function makeInitial(issue,members,now) {
  const f=BASE_FIELDS;
  return {[f.title]:issue.title,[f.created]:issue.created_at,[f.owners]:issue.owner_ids.map(id=>({id})),[f.reporter]:members[issue.reporter_id]||issue.reporter_name||'待核对',[f.source]:issue.source_url,[f.key]:issue.id,[f.status]:[TABLE_STATUS[issue.status]],[f.note]:issue.note,[f.manual]:false,[f.aiTime]:now.toISOString()};
}
function progressSignature(issue){return JSON.stringify([issue.status,issue.note,issue.owner_ids,issue.evidence_ids,issue.closure_message_id,issue.resolution||null]);}
export async function syncLedger({ledger,store,issues,members={},messages=[],now=new Date()}) {
  const f=BASE_FIELDS,rows=await ledger.records(),messageMap=new Map(messages.map(m=>[m.id,m]));
  const keys=new Set();for(const row of rows){const key=text(row.fields[f.key]);if(key&&keys.has(key))throw new Error('台账事项标识重复，需要核对');if(key)keys.add(key);}
  const stats={created:0,updated:0,protected:0,blank_preserved:rows.filter(r=>!meaningful(r)).length};
  for(const issue of issues) {
    if(!TABLE_STATUS[issue.status])throw new Error('台账不支持该问题状态');
    const mapKey=`ledger_map:${issue.id}`,previous=await store.state(mapKey);
    let record=previous?rows.find(r=>r.id===previous.record_id):matchRecord(issue,rows);
    if(previous&&!record)throw new Error(`已关联的台账记录被删除，请先核对：${issue.title}`);
    const signature=await hash(progressSignature(issue));
    const evidenceIds=[...new Set([issue.root_id,...issue.evidence_ids,issue.closure_message_id].filter(Boolean))];
    const evidence=JSON.stringify({signature,time:now.toISOString(),status:TABLE_STATUS[issue.status],note:issue.note,messages:evidenceIds.map(id=>({id,time:messageMap.get(id)?.created_at||null,url:messageMap.get(id)?.source_url||null})),resolution:issue.resolution||null});
    let mapping=previous;
    const journalKey=`ledger_create:${issue.id}`,journal=await store.state(journalKey);
    if(!mapping&&record&&text(record.fields[f.key])===issue.id&&journal?.original)mapping={record_id:record.id,original:journal.original,signature:journal.signature,manual:false};
    if(!record) {
      if(journal&&['started','unknown'].includes(journal.state))throw new Error(`台账新增结果待核对，不重复创建：${issue.title}`);
      const fields={...makeInitial(issue,members,now),[f.evidence]:evidence};
      await store.set(journalKey,{state:'started',time:now.toISOString(),original:originalSnapshot(fields),signature});
      try {
        const id=await ledger.create(fields);record={id,fields};rows.push(record);
        mapping={record_id:id,original:originalSnapshot(fields),signature,manual:false};
        await store.set(mapKey,mapping);await store.set(journalKey,{state:'created',record_id:id});stats.created++;continue;
      }catch(error){await store.set(journalKey,{state:error.confirmed?'failed':'unknown',error:error.message,time:now.toISOString(),original:originalSnapshot(fields),signature});throw error;}
    }
    // Rows that predate this integration are human-owned, including matching records.
    if(!mapping)mapping={record_id:record.id,original:originalSnapshot(record.fields),signature:null,manual:true};
    // Re-read immediately before a business-field update; never write from a stale scan.
    if(signature!==mapping.signature) {
      record=(await ledger.records()).find(r=>r.id===record.id);
      if(!record)throw new Error(`已关联的台账记录被删除，请先核对：${issue.title}`);
    }
    const liveOriginal=originalSnapshot(record.fields);
    const originalChanged=JSON.stringify(liveOriginal)!==JSON.stringify(mapping.original);
    const released=mapping.manual&&mapping.flag_seen&&record.fields[f.manual]===false;
    const manual=!released&&(!!record.fields[f.manual]||originalChanged||mapping.manual);
    const updates={};
    if(manual&&!record.fields[f.manual])updates[f.manual]=true;
    if(released||signature!==mapping.signature) {
      const currentEvidence=text(record.fields[f.evidence]);
      if(!currentEvidence.includes(`"signature":"${signature}"`)) {
        const combined=[currentEvidence,evidence].filter(Boolean).join('\n');
        if(combined.length>60000)throw new Error(`台账证据记录已满，需要归档：${issue.title}`);
        updates[f.evidence]=combined;
      }
      if(!manual)Object.assign(updates,{[f.status]:[TABLE_STATUS[issue.status]],[f.note]:issue.note,[f.owners]:issue.owner_ids.map(id=>({id})),[f.aiTime]:now.toISOString()});
    }
    if(Object.keys(updates).length){await ledger.update(record.id,updates);record.fields={...record.fields,...updates};stats.updated++;}
    if(manual)stats.protected++;
    await store.set(mapKey,{...mapping,original:manual?mapping.original:originalSnapshot(record.fields),manual,flag_seen:manual,signature});
  }
  // Read back the table as the source for cards. Never fall back to AI state on read failure.
  const final=await ledger.records();
  for(const row of rows.filter(r=>meaningful(r)&&text(r.fields[f.key])))if(!final.some(r=>r.id===row.id))throw new Error('台账写入尚未可见，保留断点，下一轮再汇总');
  const summary={...stats,time:now.toISOString(),records:final.filter(meaningful).length};await store.set('last_ledger_sync',summary);
  return {rows:final,summary};
}
export function tableIssues(rows,{issues=[],members={},tableUrl=''}={}) {
  const f=BASE_FIELDS,byId=new Map(issues.map(i=>[i.id,i])),byName=new Map();
  for(const [id,name] of Object.entries(members)){if(!byName.has(name))byName.set(name,id);else byName.set(name,null);}
  return rows.filter(meaningful).map(r=>{
    const key=text(r.fields[f.key]),cached=byId.get(key);
    const manual=!!r.fields[f.manual];
    const selected=text(r.fields[f.status]);
    if(selected&&!FROM_TABLE[selected])throw new Error(`台账存在未映射进展：${selected}`);
    const rawDate=text(r.fields[f.created]);let created=cached?.created_at||null;
    if(rawDate){const d=new Date(/[Zz]|[+-]\d\d:\d\d$/.test(rawDate)?rawDate:rawDate.replace(' ','T')+'+08:00');if(!Number.isFinite(d.getTime()))throw new Error('台账提出时间无效');created=d.toISOString();}
    const ownerIds=ids(r.fields[f.owners]);
    const reporterName=text(r.fields[f.reporter]);
    return {id:key||`table:${r.id}`,record_id:r.id,root_id:cached?.root_id||null,facet:cached?.facet||'main',title:text(r.fields[f.title]),status:FROM_TABLE[selected]||'waiting_confirmation',note:text(r.fields[f.note])||'进展待补充',owner_ids:ownerIds.filter(id=>Object.hasOwn(members,id)),owner_names:ownerIds.filter(id=>!Object.hasOwn(members,id)).map(id=>{const owner=(r.fields[f.owners]||[]).find(v=>v.id===id);return owner?.name||'待核对';}),reporter_id:byName.get(reporterName)||null,reporter_name:reporterName||'待补充',created_at:created,updated_at:cached?.updated_at||null,evidence_ids:cached?.evidence_ids||[],source_url:url(r.fields[f.source])||null,record_url:tableUrl?`${tableUrl}&record=${r.id}`:null,priority:cached?.priority||'normal',manual};
  });
}
