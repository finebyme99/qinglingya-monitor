import { SLOTS, STATUS, localTime, isResolved } from './core.mjs';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&#60;').replace(/>/g, '&#62;').replace(/[*\[\]_~`]/g, c => `&#${c.charCodeAt(0)};`);
const md = (content, size = 'body', align = 'left') => ({ tag:'markdown', content, text_size:size, text_align:align, margin:'0px' });
const block = (title, content, background) => ({ tag:'column_set', flex_mode:'none', horizontal_spacing:'8px', margin:'0px 0px 12px 0px', columns:[{tag:'column',width:'weighted',weight:1,background_style:background,padding:'12px',vertical_spacing:'4px',elements:[md(`**${title}**`),...(Array.isArray(content)?content:[md(content)])]}] });
export function issueCardRow(issue,{now=new Date(),members={},actions=false}={}) {
  const done=isResolved(issue.status),day=issue.created_at?localTime(new Date(issue.created_at)):null;
  const old=day&&day.slice(0,10)<localTime(now).slice(0,10),mention=id=>`<at id=${id}></at>`;
  const owners=[...issue.owner_ids.map(id=>done?esc(members[id]||'待核对'):mention(id)),...(issue.owner_names||[]).map(esc)].join(' ')||'待认领';
  const reporter=issue.reporter_id?(done?esc(members[issue.reporter_id]||issue.reporter_name||'反馈人'):mention(issue.reporter_id)):esc(issue.reporter_name||'待补充');
  const links=[issue.source_url?`[查看原消息](${issue.source_url})`:null,issue.record_url?`[查看台账](${issue.record_url})`:null].filter(Boolean);
  const title=`**【${esc(STATUS[issue.status])}】${esc(issue.title)}**`;
  const note=done?(issue.status==='converted'?'已转需求，本轮问题闭环。':'该事项已解决。'):issue.note;
  const content=`跟进 ${owners}｜反馈 ${reporter}\n${day?`${old?day:day.slice(11)}提出`:'提出时间待补充'}，${esc(note)}${links.length?'\n'+links.join('｜'):''}`;
  if(!actions||!issue.record_id)return md(title+'\n'+content);
  const button={tag:'button',text:{tag:'plain_text',content:done?'已解决':'标记已解决'},type:'default',size:'small',width:'fill',disabled:done,behaviors:[{type:'callback',value:{action:'resolve_issue',issue_id:issue.id,record_id:issue.record_id}}],...(done?{}:{confirm:{title:{tag:'plain_text',content:'确认标记已解决？'},text:{tag:'plain_text',content:`确认将「${issue.title}」标记为已解决并更新数据表？确认后无需再回复群消息。`}}})};
  return {tag:'column_set',flex_mode:'none',margin:'4px 0px 12px 0px',columns:[{tag:'column',width:'weighted',weight:1,vertical_spacing:'4px',elements:[{tag:'column_set',flex_mode:'none',horizontal_spacing:'8px',columns:[{tag:'column',width:'weighted',weight:1,elements:[md(title)]},{tag:'column',width:'112px',elements:[button]}]},md(content)]}]};
}
export function paginateOpen(issues) {
  const open=issues.filter(i=>!isResolved(i.status)).sort((a,b)=>Number(isResolved(a.status))-Number(isResolved(b.status))||Number(b.priority==='high')-Number(a.priority==='high')||String(a.created_at||'').localeCompare(String(b.created_at||'')));
  const pages=[];for(let i=0;i<open.length;i+=6)pages.push(open.slice(i,i+6));return pages.length?pages:[[]];
}
export function buildCards(issues, { slot = '1600', now = new Date(), cutoff = now, members = {}, botName = '系统问题清零鸭', test = true, scopeLabel = '本轮提醒范围',tableUrl=null,actions=false } = {}) {
  const preset = SLOTS.find(s=>s.id===slot); if (!preset) throw new Error('无效提醒节点');
  const open = issues.filter(i=>!isResolved(i.status));
  const counts = [open.filter(i=>i.status!=='waiting_confirmation').length,open.filter(i=>i.status==='waiting_confirmation').length,issues.filter(i=>isResolved(i.status)).length];
  const pages = paginateOpen(issues);
  const title=slot==='0930'&&new Date(now.getTime()+8*3600000).getUTCDay()===1?'周五及周末待解决，今天继续清零':preset.title;
  const detail=issue=>issueCardRow(issue,{now,members,actions});
  return pages.map((page,index)=>{
    const metrics = { tag:'column_set',flex_mode:'none',horizontal_spacing:'4px',margin:'0px 0px 12px 0px',columns:counts.map((n,i)=>({tag:'column',width:'weighted',weight:1,vertical_align:'top',background_style:i===0?'yellow-50':'grey-50',padding:'0px',vertical_spacing:'0px',elements:[md(`**<font color='${i===0?'orange':'grey-700'}'>${n}</font>**`,'heading-3','center'),md(`<font color='grey'>${['需IT跟进','待HRIS确认','已解决'][i]}</font>`,'caption','center')]})) };
    const elements=[metrics];
    const it=page.filter(i=>!isResolved(i.status)&&i.status!=='waiting_confirmation'), hr=page.filter(i=>i.status==='waiting_confirmation');
    if(it.length) elements.push(block(`IT待跟进 · 本页${it.length}项`,it.map(detail),'yellow-50'));
    if(hr.length) elements.push(block(`HRIS待确认 · 本页${hr.length}项`,hr.map(detail),'grey-50'));
    if(!page.length) elements.push(block('当前暂无待解决事项','本轮范围暂无未解决问题，后续新增问题将继续跟踪。','grey-50'));
    elements.push(md(`<font color='grey'>${test?'测试群试运行｜':''}统计截止 ${localTime(cutoff)}；${esc(scopeLabel)}。${pages.length>1?`第${index+1}/${pages.length}页。`:''}</font>\n若已完成，可在群内回复：问题标题+已完成。或随时进入数据源表更新进展，以人工更新进展为准：`,'caption'));
    if(tableUrl)elements.push({tag:'button',text:{tag:'plain_text',content:'查记录or人工更新进展'},type:'primary_filled',behaviors:[{type:'open_url',default_url:tableUrl}]});
    const card={schema:'2.0',config:{update_multi:true,width_mode:'fill',enable_forward:false,summary:{content:`${botName}｜${preset.time} ${title}｜待解决${open.length}项`},style:{text_size:{body:{default:'normal',pc:'normal',mobile:'normal'},caption:{default:'notation',pc:'notation',mobile:'notation'}}}},header:{title:{tag:'plain_text',content:title},subtitle:{tag:'plain_text',content:`${localTime(now).slice(0,10)} ${preset.time}｜${botName}${pages.length>1?`｜${index+1}/${pages.length}`:''}`},template:'orange',icon:{tag:'standard_icon',token:'todo_colorful'},text_tag_list:[{tag:'text_tag',text:{tag:'plain_text',content:test?'测试群试运行':'每日问题跟进'},color:'orange'}]},body:{direction:'vertical',padding:'12px 12px 20px 12px',elements}};
    if(new TextEncoder().encode(JSON.stringify(card)).length>28000) throw new Error('卡片超出发送长度，需要缩短事项摘要');
    return card;
  });
}
