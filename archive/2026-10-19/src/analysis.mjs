import { analyze } from './api.mjs';
import { validateIssues } from './core.mjs';

export async function analyzeIssues(env,input,prompt,{messages,previous,members,onInvalid=async()=>{}},requestAnalysis=analyze) {
  let correction=null,formatRetries=0;
  const deadline=Date.now()+Number(env.AI_TIMEOUT_MS||110000);
  for(let attempt=0;attempt<2;attempt++) {
    const remaining=deadline-Date.now();
    if(remaining<=0)throw new Error('MiMo分析超过本轮等待上限，保留断点');
    let result;
    try {result=await requestAnalysis({...env,AI_TIMEOUT_MS:remaining},correction?{...input,correction}:input,prompt+(correction?'\n上次输出未通过校验。请依据correction核对原消息及引用链，返回完整修正后的本批issues。只返回一个完整合法JSON对象，issues必须是数组；禁止Markdown代码块、注释和额外说明。不能仅为通过校验而更换反馈人，不能删除仍需跟踪的问题。':''));}
    catch(error) {
      if(error.code!=='MIMO_OUTPUT_INVALID')throw error;
      const diagnostic={kind:'model_output',message:error.message,detail:error.detail,context_ids:messages.map(m=>m.id),attempt:attempt+1};
      await onInvalid(diagnostic);
      if(attempt===1){error.message+='（已纠正重试1次，保留断点）';throw error;}
      formatRetries++;correction={validation_error:error.message,reason:error.detail?.reason};continue;
    }
    try { return {...result,changes:validateIssues(result.issues,messages,previous,members),repairs:attempt,format_retries:formatRetries}; }
    catch(error) {
      const diagnostic={message:error.message,detail:error.detail||null,result:result.issues,context_ids:messages.map(m=>m.id),attempt:attempt+1};
      await onInvalid(diagnostic);
      if(attempt===1) throw error;
      correction={validation_error:error.message,detail:error.detail||null,invalid_issues:result.issues};
    }
  }
}
