import { localTime, clearClosureText, clearTransferText, isResolved } from './core.mjs';

export function previousPeriodStart(now) {
  const shifted=new Date(now.getTime()+8*3600000);
  shifted.setUTCDate(shifted.getUTCDate()-(shifted.getUTCDay()===1?3:1));
  return shifted.toISOString().slice(0,10);
}
export function scopeIssues(issues,{now=new Date(),slot='1600',startDay=previousPeriodStart(now),morningIds=[]}={}) {
  const today=localTime(now).slice(0,10),previous=previousPeriodStart(now),morning=new Set(morningIds);
  const eligible=issues.filter(i=>localTime(new Date(i.created_at)).slice(0,10)>=startDay);
  return eligible.filter(i=>{
    const day=localTime(new Date(i.created_at)).slice(0,10);
    if(day>today)return false;
    const carry=day<today&&!isResolved(i.status);
    return slot==='0930' ? day<today&&(carry||day>=previous) : day===today||carry||morning.has(i.id);
  });
}
function resolutionClauses(message) {
  let text=message.text.replace(/<[^>]*>/g,'');
  for(const mention of message.mentions||[]){if(mention.name)text=text.replaceAll(`@${mention.name}`,'');if(mention.key)text=text.replaceAll(mention.key,'');}
  return text.split(/[\r\n；;]+/).map(s=>s.replace(/^\s*\d+[.、)）]\s*/,'').trim()).filter(s=>clearClosureText(s)||clearTransferText(s));
}
export const hasResolutionText=message=>message.sender_type==='user'&&resolutionClauses(message).length>0;
export function isResolutionCommand(message,botId) {
  return !!botId&&message.sender_type==='user'&&(message.mentions||[]).some(p=>p.id===botId)&&resolutionClauses(message).length>0;
}
const compact=s=>String(s).replace(/<[^>]*>|[@\s，。！!：:、()（）\[\]【】]/g,'');
export function resolveCommand(message,issues,cardIssueIds=[]) {
  const clauses=resolutionClauses(message),matched=[],outcomes={};
  for(const clause of clauses) {
    const byTitle=issues.filter(i=>compact(clause).includes(compact(i.title)));
    if(byTitle.length>1)return {reason:'同一段对应多个问题，请逐行写完整问题标题及确认结果。'};
    if(byTitle.length===1){matched.push(byTitle[0]);outcomes[byTitle[0].id]=clearTransferText(clause)?'converted':'closed';}
    else if(clauses.length>1)return {reason:'其中有未匹配的问题，请逐行使用完整问题标题及确认结果。'};
  }
  if(matched.length) {const selected=[...new Map(matched.map(i=>[i.id,i])).values()];return {issues:selected,outcomes,...(selected.length===1?{issue:selected[0]}:{})};}
  if(!clauses.length)return {reason:'未找到明确的完成或验收确认。'};
  const refs=new Set([message.parent_id,message.root_id].filter(Boolean));
  let candidates=issues.filter(i=>refs.has(i.root_id)||i.evidence_ids.some(id=>refs.has(id))||cardIssueIds.includes(i.id));
  if(candidates.length>1) {
    if(clauses.some(clearTransferText)) {
      const open=candidates.filter(i=>!isResolved(i.status));
      if(open.length===1)candidates=open;
      else return {reason:'该问题有多个处理目标，请逐项写明转需求的完整标题。'};
    }
    const mains=candidates.filter(i=>i.facet==='main');
    if(mains.length===1&&candidates.every(i=>i.root_id===mains[0].root_id))candidates=mains;
  }
  if(candidates.length===1)return {issue:candidates[0],issues:candidates,outcomes:{[candidates[0].id]:clauses.some(clearTransferText)?'converted':'closed'}};
  return {reason:candidates.length?'这条卡片有多个问题，请带上要解决的完整问题标题。':'请回复对应问题的原消息，或带上完整问题标题再 @机器人 说“完成”或“解决了”。'};
}
