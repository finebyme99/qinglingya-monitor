import test from 'node:test';
import assert from 'node:assert/strict';
import { Feishu, analyze } from '../src/api.mjs';
import { analysisImages, analyzeIssues } from '../src/analysis.mjs';
import { normalize, validateIssues } from '../src/core.mjs';

const root={id:'om_root',sender_id:'ou_reporter',sender_type:'user',text:'撤回后待办页面空白',created_at:'2026-10-20T11:00:00Z'};
const current={id:'om_root:main',root_id:'om_root',facet:'main',title:'撤回待办空白',status:'pending',reporter_id:'ou_reporter',owner_ids:['ou_it'],note:'等待排查',created_at:root.created_at,updated_at:root.created_at,evidence_ids:[root.id]};
const photo={id:'om_photo',sender_id:'ou_reporter',sender_type:'user',text:'[附件，请查看原消息] @IT',mentions:[{id:'ou_it'}],created_at:'2026-10-21T01:23:00Z',image_refs:[{message_id:'om_photo',key:'img_one'}]};

test('图片消息保留来源标识；合并转发图片使用顶层容器下载，不能误用子消息ID',async()=>{
  const raw={message_id:'om_photo',chat_id:'oc_source',create_time:'1792545780000',sender:{id:'ou_reporter',sender_type:'user'},body:{content:JSON.stringify({content:[[{tag:'img',image_key:'img_one'}],[{tag:'at',user_id:'ou_it'}]]})}};
  assert.deepEqual(normalize(raw).image_refs,photo.image_refs);
  const api=new Feishu({});api.call=async()=>({items:[{message_id:'om_nested',upper_message_id:'om_forward',create_time:'1792545780000',body:raw.body}]});
  const [forward]=await api.expandForwards([{...raw,message_id:'om_forward',msg_type:'merge_forward'}]);
  assert.deepEqual(normalize(forward).image_refs,[{message_id:'om_forward',key:'img_one'}]);
});

test('同一反馈人的已有问题截图与新增截图一起按证据来源读取，重复附件只下载一次',async()=>{
  const reads=[],api={async image(ref){reads.push(ref);return 'data:image/png;base64,AA==';}};
  const old={...root,image_refs:[{message_id:root.id,key:'img_old'}]};
  const other={...photo,id:'om_other',sender_id:'ou_other',image_refs:[{message_id:'om_other',key:'img_unrelated'}]};
  const result=await analysisImages(api,[old,photo,{...photo},other],[photo],[current]);
  assert.deepEqual(result.map(r=>r.key),['img_old','img_one']);assert.equal(reads.length,2);
});

test('MiMo实际请求包含图片与消息归属，既有文字分析仍兼容；飞书授权不会传给MiMo',async()=>{
  const input={messages:[{id:'om_photo',text:'补充截图'}],image_inputs:[{...photo.image_refs[0],url:'data:image/png;base64,AA=='}]};
  await analyze({MIMO_BASE_URL:'https://fake.test',MIMO_MODEL:'fake'},input,'test',async(url,options)=>{
    const body=JSON.parse(options.body),content=body.messages[1].content;assert.ok(Array.isArray(content));
    assert.equal(content[2].image_url.url,input.image_inputs[0].url);assert.match(content[1].text,/om_photo/);assert.doesNotMatch(content[0].text,/base64/);
    assert.equal(options.headers.Authorization,undefined);return Response.json({choices:[{finish_reason:'stop',message:{content:'{"issues":[]}'}}]});
  });
});

test('授权读取图片验证类型、大小和来源，失败保持显式错误',async()=>{
  const api=new Feishu({},async(url,options)=>{assert.match(url,/om_photo\/resources\/img_one\?type=image$/);assert.equal(options.headers.Authorization,'Bearer fake');return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});});api.token='fake';
  assert.equal(await api.image(photo.image_refs[0]),'data:image/png;base64,AQID');
  await assert.rejects(()=>api.image({message_id:'https://untrusted.test',key:'img_one'}),/来源标识/);
  api.request=async()=>Response.json({code:403},{status:403});await assert.rejects(()=>api.image(photo.image_refs[0]),/图片读取失败/);
  api.request=async()=>new Response('large',{headers:{'content-type':'image/png','content-length':9*1024*1024}});await assert.rejects(()=>api.image(photo.image_refs[0]),/超过8MiB/);
});

test('不能把无正文截图建成泛化新问题；纠正后应只更新原问题，保留其他独立事项',async()=>{
  const placeholder={...current,root_id:photo.id,title:'某同事再次反馈问题待补充说明',evidence_ids:[photo.id]};
  assert.throws(()=>validateIssues([placeholder],[root,photo],[current]),/泛化待补充/);
  let calls=0;
  const result=await analyzeIssues({}, {},'test',{messages:[root,photo],previous:[current],members:{ou_it:'IT'}},async()=>({issues:++calls===1?[placeholder]:[{...current,evidence_ids:[root.id,photo.id],note:'补充同一撤回单据的排查截图'}]}));
  assert.equal(calls,2);assert.equal(result.changes.length,1);assert.equal(result.changes[0].id,current.id);assert.deepEqual(result.changes[0].evidence_ids,[root.id,photo.id]);
  assert.equal(validateIssues([{...current,root_id:photo.id,title:'另一单据导入失败',evidence_ids:[photo.id]}],[root,photo],[current],{ou_it:'IT'})[0].id,`${photo.id}:main`);
});
