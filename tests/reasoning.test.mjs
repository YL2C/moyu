import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectReasoning,stripReasoning} from '../js/reasoning.js';
import {streamChat,streamWithRetry,tidyMessages} from '../js/api.js';
import {parseReply,forContext} from '../js/parse.js';
import {buildContext} from '../js/prompt.js';
import {extraBlocks} from '../js/fanwai.js';
import {chatMessages} from '../js/discuss.js';

const conn={format:'openai',baseUrl:'https://unit.example/v1',apiKey:'test-only',model:'unit',stream:true};
function mock(t,fn){const old=globalThis.fetch;globalThis.fetch=fn;t.after(()=>globalThis.fetch=old);}
function events(parts){return parts.map(content=>'data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\n').join('')+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:30}})+'\n\ndata: [DONE]\n\n';}
const response=parts=>new Response(events(parts),{headers:{'Content-Type':'text/event-stream'}});

test('仅隐藏明确标签、兼容大小写和嵌套，普通英文与比较符不删',()=>{
  assert.equal(stripReasoning('前文<THINK>secret<analysis>nested</analysis>secret</THINK>正文<reasoning>other</reasoning>末尾'),'前文正文末尾');
  const normal='With option C chosen, I need to write.\n角色说：I think I can.\n2 < 3，7 > 4。<thoughtful>这是内容</thoughtful>';
  assert.equal(stripReasoning(normal),normal);
  assert.equal(stripReasoning('2 < 3',{streaming:true}),'2 < 3');
  assert.equal(stripReasoning('<thinking>尚未结束的规划'),'');
  assert.equal(stripReasoning('<analysis role="internal">规划</analysis># 标题'),'# 标题');
  assert.equal(stripReasoning('正文<reasoning '),'正文');
});

test('每一个标签拆包位置均不闪现规划，正文完整保留',()=>{
  const raw='<think>SECRET PLAN</think># 标题\n正文。';
  for(let cut=1;cut<raw.length;cut++){
    const first=inspectReasoning(raw.slice(0,cut),{streaming:true}).text;
    assert.ok(!first.includes('SECRET'));assert.ok(!first.includes('<thi'));
    assert.equal(stripReasoning(raw),'# 标题\n正文。');
  }
});

test('OpenAI流式正文中的标签分段过滤，思考状态不包含内容，用量原样保留',async t=>{
  const parts=['<th','ink>SECRET',' PLAN</thi','nk>','# 正文\n','你接过那封信。'];mock(t,async()=>response(parts));
  const seen=[];let thinking=0;
  const result=await streamChat(conn,{messages:[{role:'user',content:'开始'}],onText:(d,full)=>seen.push([d,full]),onThinking:()=>thinking++});
  assert.equal(result.text,'# 正文\n你接过那封信。');assert.equal(thinking,1);assert.equal(result.usage.completion_tokens,30);
  assert.ok(seen.every(([,s])=>!s.includes('SECRET')&&!s.includes('<th')));assert.equal(seen.map(([d])=>d).join(''),result.text);
});

test('独立思考字段和content数组中的思考块不进入回答，非流式同样有效',async t=>{
  mock(t,async()=>new Response(JSON.stringify({choices:[{message:{reasoning_content:'FIELD SECRET',content:[{type:'reasoning',text:'ARRAY SECRET'},{type:'text',text:'<think>TAG SECRET</think>最终正文'}]},finish_reason:'stop'}],usage:{completion_tokens:40}}),{headers:{'Content-Type':'application/json'}}));
  const result=await streamChat({...conn,stream:false},{messages:[{role:'user',content:'开始'}]});assert.equal(result.text,'最终正文');assert.equal(result.usage.completion_tokens,40);
});

test('Claude原生思考块与text中混入标签都不显示',async t=>{
  const parts=[{type:'content_block_start',content_block:{type:'thinking'}},{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'FIELD SECRET'}},{type:'content_block_delta',delta:{type:'text_delta',text:'<think>TAG SECRET</think>正文'}},{type:'message_delta',delta:{stop_reason:'end_turn'}}];
  mock(t,async()=>new Response(parts.map(p=>'data: '+JSON.stringify(p)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}}));
  const seen=[];const r=await streamChat({...conn,format:'anthropic'},{onText:(_,s)=>seen.push(s)});assert.equal(r.text,'正文');assert.ok(seen.every(s=>!s.includes('SECRET')));
});

test('只返回带标签思考时明确报无正文，不自动重新请求收费',async t=>{
  let calls=0;mock(t,async()=>{calls++;return response(['<think>SECRET</think>']);});
  await assert.rejects(streamWithRetry(conn,{}, {retries:1}),e=>e.kind==='empty'&&e.message.includes('只返回了思考内容')&&e.partial==='');assert.equal(calls,1);
});

test('仅思考后网络断开不自动重试，错误partial不能泄漏标签内容',async t=>{
  let calls=0;
  mock(t,async()=>{calls++;let sent=false;return new Response(new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'<think>SECRET'}}]})+'\n\n'));}else c.error(new Error('drop'));}}),{headers:{'Content-Type':'text/event-stream'}});});
  await assert.rejects(streamWithRetry(conn,{}, {retries:1}),e=>e.kind==='network'&&e.partial===''&&e.receivedOutput);assert.equal(calls,1);
});

test('断线前已收到的正文保留，后续未闭合思考不进入partial',async t=>{
  let sent=false;mock(t,async()=>new Response(new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'正文<think>SECRET'}}]})+'\n\n'));}else c.error(new Error('drop'));}}),{headers:{'Content-Type':'text/event-stream'}}));
  await assert.rejects(streamChat(conn,{}),e=>e.kind==='network'&&e.partial==='正文');
});

test('旧记录的正文、选项和记忆排除标签内容，不污染最近原文模式',()=>{
  const raw='<think>SECRET\n【选项】\nA. fake\nB. fake</think># 正文\n你打开门。\n\n【选项】\nA. 进去\nB. 等待';
  const p=parseReply(raw);assert.equal(p.title,'正文');assert.deepEqual(p.options,['进去','等待']);assert.equal(forContext(raw),'# 正文\n你打开门。');assert.equal(forContext('<think>SECRET</think>'),'');
  const ctx=buildContext({rules:'规则',cards:[]},[{id:'a',role:'assistant',kind:'play',text:raw},{id:'u',role:'user',kind:'play',text:'A'}]);assert.ok(!ctx.messages.some(m=>m.content.includes('SECRET')));assert.ok(ctx.system.includes('不输出写作计划'));
  const ms=tidyMessages([{role:'user',content:'请解释 <think> 标签'},{role:'assistant',content:raw}]);assert.ok(ms[0].content.includes('<think>'));assert.ok(!ms[1].content.includes('SECRET'));
  assert.equal(extraBlocks('<think>SECRET</think># 番外\n正文').title,'番外');
  const chat=chatMessages({messages:[{role:'user',content:'问题'},{role:'assistant',content:'<think>SECRET</think>回答'}]});assert.equal(chat[1].content,'回答');
});

test('后台接回只订阅原任务并过滤重放，不需要原模型密钥',async t=>{
  const {db}=await import('../js/db.js');const old=db.kvGet;db.kvGet=async(k,f)=>k==='relay'?{on:true,url:'https://relay.example/relay',token:'test-relay'}:f;t.after(()=>db.kvGet=old);
  const urls=[];mock(t,async url=>{urls.push(url);return url.includes('/stream?')?new Response(events(['<think>SECRET</think>正文']),{headers:{'X-Upstream-Status':'200','X-Upstream-Content-Type':'text/event-stream','X-Job-State':'done'}}):new Response('{"state":"done"}',{headers:{'Content-Type':'application/json'}});});
  const r=await streamChat({format:'openai',model:'old'},{resumeJob:'existing-task',relayServer:'https://relay.example/relay'});assert.equal(r.text,'正文');assert.ok(urls.every(u=>!u.endsWith('/jobs')));
});

test('明确标注analysis通道的兼容数据不当正文，final通道正常显示',async t=>{
  const data=[{choices:[{delta:{channel:'analysis',content:'CHANNEL SECRET'}}]},{choices:[{delta:{channel:'final',content:'最终正文'},finish_reason:'stop'}]}];
  mock(t,async()=>new Response(data.map(j=>'data: '+JSON.stringify(j)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}}));
  const r=await streamChat(conn,{});assert.equal(r.text,'最终正文');
});
