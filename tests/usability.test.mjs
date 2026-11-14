import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://qa.example/moyu/' });
for (const key of ['window','document','Node','Event','CustomEvent','localStorage','location','FileReader']) globalThis[key] = dom.window[key];
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0); globalThis.cancelAnimationFrame = clearTimeout;
globalThis.confirm = () => true;
dom.window.HTMLElement.prototype.scrollIntoView = function() {};
const style = document.createElement('style'); style.textContent = await readFile(new URL('../css/app.css', import.meta.url), 'utf8'); document.head.append(style);
const { db } = await import('../js/db.js');
const { choiceInput, toggleChoice, expandOptionInput } = await import('../js/personal.js');
const { readAttachment, attachmentBytes, selectedImport } = await import('../js/attachments.js');
const { chatMessages, newDiscussion, saveDiscussion, getDiscussion, exportDiscussions } = await import('../js/discuss.js');
const { markdownPack, importMarkdownPack, groupModules, deleteModules, undoModuleDelete } = await import('../js/rules.js');
const { getModules, saveModules } = await import('../js/state.js');
const { protagonistState, reviewProtagonistChanges, applyProtagonistChanges } = await import('../js/protagonist.js');
const { buildContext } = await import('../js/prompt.js');
const { inlineText } = await import('../js/inline.js');
const play = await import('../js/views/play.js');
const extras = await import('../js/views/extras.js');
const settings = await import('../js/views/settings.js');
const discussion = await import('../js/views/discuss.js');
const chars = await import('../js/views/chars.js');
const storyView = await import('../js/views/story.js');
let requests = [], responses = [], root;
const options = '\n\n【选项】\nA. 查看地图\nB. 收好信件\nC. 询问路人\nD. 留在原地';
const wait = async fn => { for (let i=0;i<300;i++) { if(await fn()) return; await new Promise(r=>setTimeout(r,10)); } throw new Error('等待状态超时'); };
const button = (text, container = document) => [...container.querySelectorAll('button')].find(b=>b.textContent===text);
async function seedStory() {
  const story = { id:'story-qa',title:'测试故事',world:'主角是已经成年的青年。',rules:'保持设定',cards:[],headId:'a1',options:true,danmu:false,modules:{},localModules:[],packs:[],memEvery:0,protagonist:{name:'林舟',gender:'男',note:'初始是大学生。'} };
  const nodes = [{id:'u1',storyId:story.id,parentId:null,role:'user',kind:'start',text:'开始',createdAt:1},
    {id:'a1',storyId:story.id,parentId:'u1',role:'assistant',kind:'play',status:'done',text:'# 毕业之后\n\n林舟已经毕业，入职设计公司。'+options,createdAt:2}];
  await db.put('stories',story); await db.putMany('nodes',nodes); return {story,nodes};
}
beforeEach(async () => {
  for(const store of ['stories','nodes','extras','connections']) for(const item of await db.all(store)) await db.del(store,item.id);
  for(const key of ['modules','packs','disc.index','relay','defaultConnId','globalMemo','modules.undo','fwTemplates','fwBase','usageLog','spend']) await db.kvSet(key,null);
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  localStorage.clear(); document.body.innerHTML='<div id="fixture"></div><div id="toast"></div>'; root=document.querySelector('#fixture');
  requests=[]; responses=[];
  await db.put('connections',{id:'qa-conn',format:'openai',name:'测试连接',baseUrl:'https://model.qa.example/v1',apiKey:'virtual-key',model:'test',stream:false,maxTokens:2048});
  await db.kvSet('relay',{on:false});
  globalThis.fetch=async(url,init)=>{ requests.push({url,body:JSON.parse(init.body)}); const answer=responses.shift()??('# 新进展\n\n你收好了信。'+options);
    return new Response(JSON.stringify({choices:[{message:{content:answer},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:20}}),{headers:{'Content-Type':'application/json'}}); };
});

test('多选以点选顺序显示加号，取消或改写后保留补充，发送展开所有全文', () => {
  let input=toggleChoice('（抬眼）你好。','B'); input=toggleChoice(input,'A');
  assert.equal(input,'B+A （抬眼）你好。'); assert.equal(toggleChoice(input,'B'),'A （抬眼）你好。');
  assert.deepEqual(choiceInput('AB（继续）').labels,['A','B']);
  assert.equal(expandOptionInput(input,['查看地图','收好信件']),'（收好信件）\n（查看地图）\n（抬眼）你好。');
  assert.equal(expandOptionInput('A+',['查看地图']),'A+');
  assert.equal(choiceInput('Actually, wait.').labels.length,0);
});

test('游玩真实按钮多选与发送，输入栏采用居中对齐', async () => {
  const {story}=await seedStory(); const dispose=await play.render(root,{id:story.id});
  try {
    const buttons=root.querySelectorAll('.options button'); buttons[0].click(); buttons[1].click();
    const ta=root.querySelector('textarea'); assert.equal(ta.value,'A+B');
    assert.notEqual(document.activeElement,ta,'点选多选不自动聚焦输入框或唤起键盘');
    assert.equal(buttons[0].getAttribute('aria-pressed'),'true');
    ta.value+='（把信放进包里）';ta.dispatchEvent(new Event('input'));
    assert.equal(getComputedStyle(root.querySelector('.input-shell')).alignItems,'center');
    assert.equal(getComputedStyle(root.querySelector('.inrow')).alignItems,'center');
    button('发送').click(); await wait(()=>requests.length===1&&!dispose.busy());
    const sent=requests[0].body.messages.at(-1).content;
    assert.ok(sent.includes('（查看地图）\n（收好信件）\n（把信放进包里）'));
    assert.equal(ta.value,'');
  } finally { dispose(); }
});

test('番外重写、切回旧版本后续写绑定各自素材与要求，重复点击只请求一次', async () => {
  const {story}=await seedStory();
  const oldContext={system:'旧版本专用设定',messages:[{role:'user',content:'旧版的要求'}],info:{totalChars:20,parts:[],chapters:[],cards:[]}};
  await db.put('extras',{id:'extra-qa',storyId:story.id,tplName:'小说体',tplText:'写场景',request:'新版要求',anchorId:'a1',anchorNo:1,length:'mid',cur:0,versions:[{text:'# 旧版\n\n旧版的结尾。',context:oldContext,request:'旧版的要求',status:'done'}]});
  const dispose=await extras.render(root,{id:story.id,extraId:'extra-qa'});
  try {
    responses.push('# 新版\n\n新版结尾。','接在旧版后面的新内容。');
    const generate=button('重新生成一个版本');generate.click();generate.click();
    await wait(()=>!dispose.busy()&&requests.length===1);
    assert.equal((await db.get('extras','extra-qa')).versions.length,2);
    root.querySelector('[aria-label="上一个版本"]').click();
    await wait(()=>root.textContent.includes('旧版的结尾。'));
    button('接着当前版本写').click(); await wait(()=>!dispose.busy()&&requests.length===2);
    const sent=requests[1].body;
    assert.equal(sent.messages[0].content,'旧版本专用设定');
    assert.ok(sent.messages.some(m=>m.role==='assistant'&&m.content.includes('旧版的结尾。')));
    assert.equal(sent.max_tokens,2048);
    const saved=await db.get('extras','extra-qa');
    assert.ok(saved.versions[0].text.endsWith('接在旧版后面的新内容。'));
    assert.equal(saved.versions[1].text,'# 新版\n\n新版结尾。');
  } finally {dispose();}
});

test('Markdown按文件分组，批量删除撤销不覆盖之后新建的模块',async()=>{
  const a=await importMarkdownPack('## 节奏\n写具体行动\n## 对白\n各有口吻','文风甲.md');
  assert.equal(a.mods.length,2);assert.equal(a.mods[0].pack,a.mods[1].pack);
  await groupModules(a.mods.map(m=>m.id),'统一文风');
  assert.equal(new Set((await getModules()).map(m=>m.pack)).size,1);
  await deleteModules(a.mods.map(m=>m.id));await saveModules([{id:'new',name:'后来新增',text:'保留'}]);
  assert.equal(await undoModuleDelete(),2);assert.equal((await getModules()).length,3);
});

test('设置栏目可折叠并记忆，规则管理提供批量选中删除与恢复',async()=>{
  await importMarkdownPack('## 节奏\n写具体行动\n## 对白\n各有口吻','文风甲.md');
  await settings.render(root,{section:'modules'});
  assert.ok(root.querySelectorAll('details.settings-section').length>=8);
  assert.equal(root.querySelector('#sec-modules').open,true);
  assert.equal(root.querySelectorAll('.rule-pack').length,1);
  button('全选').click();button('删除所选').click();await wait(async()=>!(await getModules()).length);
  await wait(()=>!!button('撤销上次删除'));button('撤销上次删除').click();await wait(async()=>(await getModules()).length===2);
  const reading=[...root.querySelectorAll('.settings-section')].find(d=>d.firstElementChild.textContent==='阅读');
  reading.open=true;reading.dispatchEvent(new Event('toggle'));
  assert.equal(localStorage.getItem('moyu-yl2c.settings.fold.阅读'),'open');
});

test('故事批量开关不修改另一个故事的启用状态',async()=>{
  const {story}=await seedStory();const {mods}=await importMarkdownPack('## 一\n规则一\n## 二\n规则二','规则.md');
  await db.put('stories',{...story,id:'other-story',modules:{[mods[0].id]:true}});
  const dispose=await storyView.render(root,{id:story.id,tab:'rules'});
  try {await wait(()=>!!button('全部开启'));button('全部开启').click();await wait(async()=>(await db.get('stories',story.id)).modules[mods[1].id]);
    assert.deepEqual((await db.get('stories','other-story')).modules,{[mods[0].id]:true});
  } finally {dispose();}
});

const sampleCard={spec:'chara_card_v3',spec_version:'3.0',data:{name:'测试人物',description:'成年人物，擅长设计。',personality:'说话直接',scenario:'工作室初见',first_mes:'你好。',character_book:{entries:[{comment:'城市',content:'故事发生在架空城市。',constant:true,enabled:true}]},extensions:{regex_scripts:[{scriptName:'界面',replaceString:'<script>notExecutable()</script>'}]}}};
function pngCard(kind='tEXt') {
  const json=Buffer.from(JSON.stringify(sampleCard)).toString('base64');
  let payload=Buffer.concat([Buffer.from('ccv3\0'),Buffer.from(json)]);
  if(kind==='zTXt')payload=Buffer.concat([Buffer.from('ccv3\0\0'),deflateSync(Buffer.from(json))]);
  if(kind==='iTXt')payload=Buffer.concat([Buffer.from('ccv3\0\x01\0\0\0'),deflateSync(Buffer.from(json))]);
  const chunk=(type,payload)=>{const out=Buffer.alloc(payload.length+12);out.writeUInt32BE(payload.length);out.write(type,4);payload.copy(out,8);return out;};
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk(kind,payload),chunk('IEND',Buffer.alloc(0))]);
}

test('PNG原始字节与JSON结构可往返，支持三种文字块且不执行脚本',async()=>{
  for(const kind of ['tEXt','zTXt','iTXt']){
    const bytes=pngCard(kind),a=await readAttachment(new File([bytes],'角色.png',{type:'image/png'}));
    assert.deepEqual(Buffer.from(attachmentBytes(a)),bytes);assert.equal(a.cardName,'测试人物');
    assert.equal(a.config.regex,1);assert.equal(a.items[0].json.data.extensions.regex_scripts[0].scriptName,'界面');
    const imported=selectedImport(a);assert.equal(imported.data.description,sampleCard.data.description);
    assert.ok(!imported.data.extensions.regex_scripts);
    a.sections.forEach(s=>s.selected=s.key.startsWith('book:'));
    assert.equal(selectedImport(a).entries.length,1);
  }
  await assert.rejects(readAttachment(new File([new Uint8Array([255,216,255])],'已转换.jpeg')),/原始PNG/);
});

test('讨论附件先本地拆解，发给模型只有勾选的文字；备份保留原始PNG',async()=>{
  const d=newDiscussion('','附件测试');await saveDiscussion(d);
  const dispose=await discussion.render(root,{id:d.id});
  try{
    button('📎 上传并拆卡').click();const input=document.querySelector('input[type=file]');const bytes=pngCard();
    Object.defineProperty(input,'files',{value:[new File([bytes],'角色.png',{type:'image/png'})]});input.dispatchEvent(new Event('change'));
    await wait(()=>root.querySelector('.attachment-card'));
    assert.equal(requests.length,0);
    const omit=root.querySelector('[aria-label="携带 性格"]');omit.checked=false;omit.dispatchEvent(new Event('change'));
    await wait(async()=>!(await getDiscussion(d.id)).pendingAttachments[0].sections.find(s=>s.key==='personality').selected);
    button('发送').click();await wait(()=>requests.length===1&&!dispose.busy());
    const sent=requests[0].body.messages.at(-1).content;
    assert.ok(sent.includes('成年人物，擅长设计。'));assert.ok(!sent.includes('说话直接'));assert.ok(!sent.includes('notExecutable'));
    const saved=await getDiscussion(d.id);assert.deepEqual(Buffer.from(attachmentBytes(saved.messages[0].attachments[0])),bytes);
    const backup=JSON.parse(JSON.stringify(await exportDiscussions()));assert.equal(backup.find(x=>x.id===d.id).messages[0].attachments[0].original,saved.messages[0].attachments[0].original);
    assert.ok(!JSON.stringify(chatMessages(saved)).includes('image_url'));
  }finally{dispose();}
});

test('主角更新只接受有原文依据的状态字段，并隔离分支及保留固定设定',()=>{
  const p={name:'林舟',gender:'男',note:'初始是大学生。'};
  const sources=[{id:'chapter:1',label:'第1章',text:'林舟已经毕业，入职设计公司。'}];
  const changes=reviewProtagonistChanges({changes:[{field:'identity',value:'设计公司职员',evidence:[{source:'chapter:1',quote:'已经毕业，入职设计公司'}]},{field:'name',value:'改名了',evidence:[]},{field:'abilities',value:'获得超能力',evidence:[{source:'chapter:1',quote:'获得超能力'}]}]},sources,{});
  assert.equal(changes.length,2);assert.equal(changes[1].valid,false);
  const next=applyProtagonistChanges(p,changes,'branch-a');assert.equal(next.name,p.name);assert.equal(next.gender,p.gender);assert.equal(next.note,p.note);
  assert.equal(protagonistState(next,[{id:'branch-a'}]).identity.value,'设计公司职员');assert.deepEqual(protagonistState(next,[{id:'branch-b'}]),{});
});

test('主角卡实际整理、审阅保存、撤销，正文上下文读取当前变化',async()=>{
  const {story,nodes}=await seedStory();const dispose=await chars.render(root,{id:story.id});
  try{
    responses.push(JSON.stringify({changes:[{field:'identity',value:'设计公司职员',conflict:false,evidence:[{source:'chapter:1',quote:'林舟已经毕业，入职设计公司。'}]}]}));
    button('根据当前剧情更新').click();await wait(()=>!!button('读取剧情并生成建议'));button('读取剧情并生成建议').click();
    await wait(()=>!button('保存勾选项').disabled);button('保存勾选项').click();
    await wait(async()=>(await db.get('stories',story.id)).protagonist.stateEntries?.length===1);
    const saved=await db.get('stories',story.id);assert.equal(saved.protagonist.name,'林舟');assert.equal(saved.protagonist.note,'初始是大学生。');
    assert.ok(buildContext(saved,nodes).system.includes('设计公司职员'));
    await wait(()=>!!button('撤销上次更新'));button('撤销上次更新').click();await wait(async()=>(await db.get('stories',story.id)).protagonist.stateEntries.length===0);
  }finally{dispose();}
});

test('主角状态默认收起、可记住展开状态，编辑不会触发折叠或改变资料',async()=>{
  const {story}=await seedStory();
  story.protagonist.stateEntries=[{field:'status',value:'已经毕业，正在适应新工作。',sourceNodeId:'a1'}];
  await db.put('stories',story);
  let dispose=await chars.render(root,{id:story.id});
  try{
    const fold=root.querySelector('details.protagonist-state');assert.equal(fold.open,false);
    assert.ok(fold.textContent.includes('已经毕业，正在适应新工作。'));
    fold.open=true;fold.dispatchEvent(new Event('toggle'));
    dispose();root.replaceChildren();dispose=await chars.render(root,{id:story.id});
    assert.equal(root.querySelector('details.protagonist-state').open,true);
    button('编辑',root.querySelector('[data-name="主角"]')).click();
    assert.ok(document.querySelector('[role=dialog]'));
    assert.equal(root.querySelector('details.protagonist-state').open,true);
    assert.deepEqual((await db.get('stories',story.id)).protagonist.stateEntries,story.protagonist.stateEntries);
    assert.equal(requests.length,0);
    button('取消',document.querySelector('[role=dialog]')).click();
  }finally{dispose();}
});

test('关键文字加粗与强调色仅创建文本节点，关闭后去标记并阻止HTML执行',()=>{
  const output=document.createElement('div');output.append(inlineText('他答应**明天回来**，留下==一封信==。<img src=x onerror=alert(1)>'));
  assert.equal(output.querySelector('strong').textContent,'明天回来');assert.equal(output.querySelector('.text-highlight').textContent,'一封信');assert.equal(output.querySelector('img'),null);
  output.replaceChildren(inlineText('**承诺**与==线索==',false));assert.equal(output.textContent,'承诺与线索');assert.equal(output.children.length,0);
});

test('引号内台词柔和配色，与关键词强调独立且不执行HTML',()=>{
  const output=document.createElement('div');
  output.append(inlineText('他问：“你会**明天回来**吗？带着==那封信==。”<script>bad()</script>'));
  const dialogue=output.querySelector('.dialogue-text');
  assert.ok(dialogue);assert.equal(dialogue.querySelector('strong').textContent,'明天回来');
  assert.equal(dialogue.querySelector('.text-highlight').textContent,'那封信');assert.equal(output.querySelector('script'),null);
  output.replaceChildren(inlineText('“**回来**。”',false,true));
  assert.ok(output.querySelector('.dialogue-text'));assert.equal(output.querySelector('strong'),null);
  output.replaceChildren(inlineText('“**回来**。”',true,false));
  assert.equal(output.querySelector('.dialogue-text'),null);assert.ok(output.querySelector('strong'));
  output.replaceChildren(inlineText('“还没有说完'));assert.equal(output.textContent,'“还没有说完');
});


async function seedRelayExtra({pending=true, versions=[]}={}) {
  const {story}=await seedStory();
  const conn=await db.get('connections','qa-conn');await db.put('connections',{...conn,viaRelay:true,stream:true});
  await db.kvSet('relay',{on:true,url:'https://relay.qa.example',token:'virtual-relay-secret'});
  await db.put('extras',{id:'relay-extra',storyId:story.id,tplName:'日记体',request:'写一天的日记',anchorId:'a1',anchorNo:1,length:'mid',cur:0,pending,versions});
  return story;
}
function extraRelayMock(stream) {
  const calls=[];
  globalThis.fetch=async(url,init={})=>{
    calls.push({url,method:init.method});
    if(url.endsWith('/jobs'))return new Response(JSON.stringify({id:'extra-task'}),{status:201});
    if(init.method==='DELETE')return new Response('{}');
    if(url.includes('/stream?'))return stream(init,calls);
    return new Response(JSON.stringify({state:'done'}));
  };
  return calls;
}
function extraSSE(text,{signal,hang=false}={}) {
  const data='data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:hang?null:'stop'}],usage:hang?undefined:{prompt_tokens:20,completion_tokens:8}})+'\n\n';
  const body=hang?new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(data));signal.addEventListener('abort',()=>c.error(new DOMException('aborted','AbortError')),{once:true});}}):data+'data: [DONE]\n\n';
  return new Response(body,{headers:{'X-Upstream-Status':'200','X-Upstream-Content-Type':'text/event-stream','X-Job-State':hang?'running':'done'}});
}

test('番外先保存后台任务，断线后重进自动接回；不重建任务、不依赖原连接密钥',async()=>{
  const story=await seedRelayExtra();let fail=true;
  const calls=extraRelayMock(async()=>{
    const saved=(await db.get('extras','relay-extra')).versions[0];
    assert.equal(saved.relayJob,'extra-task');assert.equal(saved.relayContext.connection.model,'test');
    assert.ok(!JSON.stringify(saved.relayContext).includes('virtual-key'));
    if(fail)throw new TypeError('offline');return extraSSE('重新接回的完整日记。');
  });
  let dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
  try{
    await wait(()=>!dispose.busy()&&button('接回后台生成'));
    assert.equal(button('重新生成一个版本'),undefined);
    assert.equal(((await db.kvGet('usageLog',[]))||[]).length,0);
    dispose();root.replaceChildren();fail=false;
    await db.del('connections','qa-conn');
    dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
    await wait(()=>!dispose.busy());
    const saved=await db.get('extras','relay-extra');
    assert.equal(saved.versions.length,1);assert.equal(saved.versions[0].text,'重新接回的完整日记。');
    assert.equal(saved.versions[0].status,'done');assert.equal(saved.versions[0].relayJob,undefined);
    assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(calls.filter(c=>c.method==='DELETE').length,0);
    assert.equal(((await db.kvGet('usageLog',[]))||[]).length,1);
  }finally{dispose();}
});

test('番外续写返回前台重连保留原文，重放不重复追加，切走不停止后台任务',async()=>{
  const context={system:'设定',messages:[{role:'user',content:'日记要求'}],info:{totalChars:10,parts:[],chapters:[],cards:[]}};
  const story=await seedRelayExtra({pending:false,versions:[{text:'原本的日记。',status:'done',context,usageN:{input:5,output:4,cached:0}}]});
  let streams=0;
  const calls=extraRelayMock(init=>extraSSE(++streams===1?'续写片段':'续写片段，完整结尾。',{signal:init.signal,hang:streams===1}));
  const dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
  try{
    button('接着当前版本写').click();await wait(()=>root.textContent.includes('续写片段'));
    assert.equal(dispose.busy(),true);
    document.dispatchEvent(new Event('visibilitychange'));
    await wait(()=>!dispose.busy());
    const v=(await db.get('extras','relay-extra')).versions[0];
    assert.equal(v.text,'原本的日记。续写片段，完整结尾。');assert.equal(v.usageN.input,25);assert.equal(v.usageN.output,12);
    assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(calls.filter(c=>c.method==='DELETE').length,0);
    assert.equal(streams,2);
  }finally{dispose();}
});

test('番外手动接回、恢复网络不重复创建，任务过期保留已收正文',async()=>{
  const story=await seedRelayExtra({pending:false,versions:[{text:'已经收到的番外片段。',status:'streaming',relayJob:'extra-task',relayContext:{server:'https://relay.qa.example',base:'',mode:'new',inChars:5,connection:{format:'openai',model:'test',stream:true}}}]});let phase='auth';
  const calls=extraRelayMock(()=>phase==='auth'?new Response('{}',{status:401}):new Response('{}',{status:404}));
  const dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
  try{
    await wait(()=>!dispose.busy()&&button('接回后台生成'));
    const reconnectButton=button('接回后台生成');reconnectButton.click();reconnectButton.click();
    await wait(()=>!dispose.busy());
    assert.equal(calls.filter(c=>c.url.includes('/stream?')).length,2);
    phase='expired';window.dispatchEvent(new Event('online'));await wait(()=>!dispose.busy());
    const v=(await db.get('extras','relay-extra')).versions[0];
    assert.equal(v.error.kind,'relay_expired');assert.equal(v.relayJob,undefined);
    assert.ok(button('重新生成一个版本'));
    assert.equal(v.text,'已经收到的番外片段。');
    assert.equal(calls.filter(c=>c.method==='POST').length,0);
  }finally{dispose();}
});

test('番外主动停止会停止原后台任务，旧版无编号任务给出真实提示',async()=>{
  const story=await seedRelayExtra();
  const calls=extraRelayMock(()=>new Response('{}',{status:401}));
  let dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
  try{
    await wait(()=>!dispose.busy()&&button('停止后台生成'));
    button('停止后台生成').click();await wait(()=>!dispose.busy());
    assert.equal(calls.filter(c=>c.method==='DELETE').length,1);
    assert.equal((await db.get('extras','relay-extra')).versions[0].relayJob,undefined);
    dispose();root.replaceChildren();
    await db.put('extras',{id:'legacy-extra',storyId:story.id,cur:0,versions:[{text:'已收到的旧番外',status:'error',error:{kind:'relay_network',message:'长时间没有响应',hint:'点接回后台生成'}}]});
    dispose=await extras.render(root,{id:story.id,extraId:'legacy-extra'});
    assert.ok(root.textContent.includes('没有保存后台任务编号'));
    assert.ok(root.textContent.includes('已收到的旧番外'));assert.ok(button('接着当前版本写'));
  }finally{dispose();}
});


test('番外断线可自动重试接回，自动重试仅订阅原任务',async()=>{
  const story=await seedRelayExtra();let streams=0;
  const calls=extraRelayMock(()=>{if(++streams===1)throw new TypeError('temporary offline');return extraSSE('网络恢复后的日记。');});
  const dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
  try{
    await wait(()=>root.textContent.includes('网络恢复后的日记。')&&!dispose.busy());
    assert.equal(streams,2);assert.equal(calls.filter(c=>c.method==='POST').length,1);
  }finally{dispose();}
});

test('番外正在生成时离开再重进保留同一版本；主动停止只取消原任务',async()=>{
  const story=await seedRelayExtra();let streams=0;
  const calls=extraRelayMock(init=>extraSSE(++streams===1?'已经收到的片段':'已经收到的片段，接回后内容。',{signal:init.signal,hang:true}));
  let dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
  try{
    await wait(()=>root.textContent.includes('已经收到的片段'));
    dispose();await wait(()=>!dispose.busy());
    assert.equal(calls.filter(c=>c.method==='DELETE').length,0);
    assert.equal((await db.get('extras','relay-extra')).versions[0].relayJob,'extra-task');
    root.replaceChildren();dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
    await wait(()=>root.textContent.includes('接回后内容'));
    button('停止').click();await wait(()=>!dispose.busy());
    const saved=await db.get('extras','relay-extra');
    assert.equal(saved.versions.length,1);assert.equal(saved.versions[0].text,'已经收到的片段，接回后内容。');
    assert.equal(saved.versions[0].status,'partial');assert.equal(saved.versions[0].relayJob,undefined);
    assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(calls.filter(c=>c.method==='DELETE').length,1);
  }finally{dispose();}
});
