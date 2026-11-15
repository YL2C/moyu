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
  for(const key of ['modules','packs','disc.index','relay','defaultConnId','globalMemo','modules.undo','fwTemplates','fwBase','fwPlaybooksV1','extraConnectionId','usageLog','spend']) await db.kvSet(key,null);
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
  await wait(()=>[...root.querySelectorAll('.settings-section')].some(d=>d.firstElementChild.textContent==='阅读'));
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

test('四个玩法升级仅补一次，保留自定义模板与后续删除、修改',async()=>{
  const {getTemplates,saveTemplates}=await import('../js/fanwai.js');
  await db.kvSet('fwTemplates',[{id:'custom',name:'我的写法',scope:'char',text:'保持我的写法'}]);
  const list=await getTemplates();assert.equal(list.length,5);assert.equal(list[0].text,'保持我的写法');
  assert.ok(list.some(t=>t.name==='一起参加恋综'));assert.ok(list.every(t=>t.text));
  const kept=list.filter(t=>t.name!=='他的聊天记录');kept[1].text='自己编辑后的要求';await saveTemplates(kept);
  const again=await getTemplates();assert.equal(again.length,4);assert.equal(again[1].text,'自己编辑后的要求');
});

test('玩法快照仅取锚点前最近三章，带子类与自由扩展，空素材报告不得编造评分',async()=>{
  const {buildExtraContext,builtinTemplates}=await import('../js/fanwai.js');
  const {story}=await seedStory();const template=builtinTemplates().find(t=>t.name==='恋爱脑报告');
  const chapters=[1,2,3,4,5].map(no=>({no,id:'chapter-'+no,title:'事件'+no,said:'行动'+no,text:'第'+no+'章独有事件'}));
  const make=anchorNo=>buildExtraContext(story,{template,chapters,anchorNo,recentN:0,variant:'观察侧重：日程让步'});
  const a=make(3),b=make(4);
  assert.deepEqual(a.info.snapshotChapters,[1,2,3]);assert.deepEqual(b.info.snapshotChapters,[2,3,4]);
  assert.ok(!a.system.includes('第4章独有事件'));assert.ok(b.system.includes('第4章独有事件'));
  assert.ok(a.system.includes('自由扩展'));assert.ok(a.system.includes('观察侧重：日程让步'));assert.ok(a.system.includes('资料不足'));
  assert.notEqual(a.system,b.system);
  const empty=make(0);assert.ok(empty.system.includes('没有可评分的历史事件'));
});

test('六种材料本地排版保留内容，缺失标记回退；HTML与链接不执行、不加载',async()=>{
  const {renderExtraLayout,parseExtraLayout}=await import('../js/extra-layout.js');
  const {samples}=await import('./extra-samples.js');
  for(const text of Object.values(samples)){
    const out=renderExtraLayout(text);assert.ok(out.querySelector('.ex-block'));assert.ok(out.textContent.length>80);
    assert.equal(out.querySelector('img,script,iframe'),null);
  }
  const report=renderExtraLayout(samples['恋爱脑报告']);assert.equal(report.querySelectorAll('progress').length,3);
  assert.equal(report.querySelector('progress').value,87);
  const chat=renderExtraLayout(samples['他的聊天记录']);assert.ok(chat.querySelector('.mine .ex-bubble'));assert.ok(chat.textContent.includes('撤回'));
  const forum=renderExtraLayout(samples['论坛体']);assert.ok(forum.querySelector('.ex-op'));assert.ok(forum.querySelector('.ex-quote'));assert.ok(forum.querySelector('.hot'));
  const broken='【聊天】\n会话｜未完成\n我｜测试｜<img src=x onerror=alert(1)>\n消息还没写完';
  const fallback=renderExtraLayout(broken);assert.equal(fallback.textContent,broken);assert.equal(fallback.querySelector('img'),null);
  const invalid=renderExtraLayout('【报告】\n指数｜破坏测试｜9999｜<script>bad()</script>｜http://example.test\n【/】');
  assert.equal(invalid.querySelector('progress'),null);assert.ok(invalid.textContent.includes('未评分'));assert.equal(invalid.querySelector('script,a'),null);
  const nested='【论坛】\n楼主｜甲｜今天｜内容\n【聊天】\n他｜乙｜你好\n【/】';
  assert.equal(parseExtraLayout(nested)[0].fallback,true);
});

test('番外实际创建可选自定义子类，生成五类布局，原文切换后文字不丢失；新旧版本续写沿用素材',async()=>{
  const {samples}=await import('./extra-samples.js');const {story}=await seedStory();
  await extras.render(root,{id:story.id});button('✦ 写一篇番外').click();await wait(()=>!!document.querySelector('[role=dialog] select'));
  const dialog=document.querySelector('[role=dialog]'),type=dialog.querySelector('select');
  for(const name of ['一起参加恋综','他的聊天记录','我跟你的同人文','恋爱脑报告'])assert.ok([...type.options].some(o=>o.text===name));
  type.value='playbook-fic';type.dispatchEvent(new Event('change'));
  dialog.querySelector('[aria-label="题材"]').value='星际';dialog.querySelector('[aria-label="平台"]').value='AO3';dialog.querySelector('[aria-label="自定义子类"]').value='船舱便签';
  button('开始写',dialog).click();await wait(async()=>(await db.extrasOf(story.id)).length===1);
  const x=(await db.extrasOf(story.id))[0];assert.equal(x.layout,'fic');assert.ok(x.variant.includes('船舱便签'));assert.ok(x.variant.includes('星际'));
  responses.push(samples['我跟你的同人文']);root.replaceChildren();const dispose=await extras.render(root,{id:story.id,extraId:x.id});
  try{
    await wait(()=>!dispose.busy());assert.equal(requests.length,1);assert.ok(root.querySelector('.ex-fic'));assert.ok(root.querySelector('.ex-forum'));
    const v=(await db.get('extras',x.id)).versions[0];assert.equal(v.layoutVersion,1);
    button('原文').click();assert.equal(root.querySelector('.extra-raw').textContent,samples['我跟你的同人文']);
    button('排版').click();assert.ok(root.querySelector('.ex-fic'));
    responses.push('\n\n【场景】\n他把新的便签递了过来。\n【/】');button('接着当前版本写').click();await wait(()=>!dispose.busy()&&requests.length===2);
    assert.equal(requests[0].body.messages[0].content,requests[1].body.messages[0].content);
    assert.ok((await db.get('extras',x.id)).versions[0].text.endsWith('【/】'));
  }finally{dispose();}
});

async function openExtraForm(story,template) {
  root.replaceChildren();await extras.render(root,{id:story.id});button('✦ 写一篇番外').click();
  await wait(()=>!!document.querySelector('[role=dialog] select'));
  const dialog=document.querySelector('[role=dialog]'),select=dialog.querySelector('select');
  select.value=template;select.dispatchEvent(new Event('change'));return dialog;
}

test('聊天与报告无子类菜单；记录主人、报告对象和报告人各自保存，选中角色卡进入上下文',async()=>{
  const {story}=await seedStory();story.cards=[{id:'c1',name:'许秋',initial:'出版社编辑',personality:'讲话直截了当'}];await db.put('stories',story);
  const chat=await openExtraForm(story,'playbook-chat');
  assert.equal([...chat.querySelectorAll('details')].find(d=>d.firstElementChild.textContent.includes('子类')).hidden,true);
  const owner=chat.querySelector('[aria-label="查看谁的记录"]');
  assert.ok([...owner.options].some(o=>o.text.includes('主角（你）')));assert.ok([...owner.options].some(o=>o.text==='不同人'));
  owner.value='__self';owner.dispatchEvent(new Event('change'));button('开始写',chat).click();
  await wait(async()=>(await db.extrasOf(story.id)).length===1);
  const first=(await db.extrasOf(story.id))[0];assert.equal(first.cast.owner.kind,'self');assert.equal(first.pov,'林舟');assert.equal(first.variant,'');
  const report=await openExtraForm(story,'playbook-report');
  assert.equal([...report.querySelectorAll('details')].find(d=>d.firstElementChild.textContent.includes('子类')).hidden,true);
  report.querySelector('[aria-label="观察对象"]').value='card-0';
  const writer=report.querySelector('[aria-label="报告人"]');writer.value='__named';writer.dispatchEvent(new Event('change'));
  report.querySelector('[aria-label="报告人姓名"]').value='夏晚';
  button('开始写',report).click();await wait(async()=>(await db.extrasOf(story.id)).length===2);
  const second=(await db.extrasOf(story.id)).find(x=>x.id!==first.id);
  assert.equal(second.cast.owner.name,'许秋');assert.equal(second.cast.reporter.name,'夏晚');
  responses.push('【报告】\n标题｜观察记录\n总评｜他给你留出了时间。\n【/】');
  root.replaceChildren();const dispose=await extras.render(root,{id:story.id,extraId:second.id});
  try{await wait(()=>!dispose.busy());const system=requests[0].body.messages[0].content;
    assert.ok(system.includes('许秋'));assert.ok(system.includes('出版社编辑'));assert.ok(system.includes('夏晚'));
    assert.ok(system.includes('完整报告'));assert.ok(root.querySelector('.ex-report-document'));assert.ok(root.textContent.includes('报告人：夏晚'));
  }finally{dispose();}
});

test('恋综随行人支持角色多选和手填，所有选中的人物都进入生成快照',async()=>{
  const {story}=await seedStory();story.cards=[{id:'c1',name:'许秋',initial:'出版社编辑'},{id:'c2',name:'陆明',initial:'热爱露营'}];await db.put('stories',story);
  const dialog=await openExtraForm(story,'playbook-show');
  assert.equal(dialog.querySelector('[aria-label="视角角色"]').closest('.field').hidden,true);
  dialog.querySelector('[aria-label="随行人：许秋"]').checked=true;dialog.querySelector('[aria-label="随行人：陆明"]').checked=true;
  dialog.querySelector('[aria-label="其他随行人"]').value='夏晚、许秋';
  button('开始写',dialog).click();await wait(async()=>(await db.extrasOf(story.id)).length===1);
  const x=(await db.extrasOf(story.id))[0];assert.deepEqual(x.cast.companions.map(p=>p.name),['许秋','陆明','夏晚']);assert.equal(x.cast.owner,undefined);
  const {buildExtraContext}=await import('../js/fanwai.js');
  const ctx=buildExtraContext(story,{chapters:[],anchorNo:0,template:{name:x.tplName,text:x.tplText,layout:x.layout},cast:x.cast});
  assert.ok(ctx.system.includes('出版社编辑'));assert.ok(ctx.system.includes('热爱露营'));assert.ok(ctx.system.includes('夏晚'));assert.ok(ctx.system.includes('主角默认参与'));
});

test('番外独立API贯穿新建重写续写，显式切换后生效，删除连接不回退正文API',async()=>{
  const {story}=await seedStory();story.connectionId='qa-conn';await db.put('stories',story);
  await db.put('connections',{id:'extra-api',name:'番外专用',format:'openai',baseUrl:'https://extra.qa.example/v1',apiKey:'virtual-extra-key',model:'extra-test',stream:false});
  const dialog=await openExtraForm(story,'playbook-chat');dialog.querySelector('[aria-label="番外 API"]').value='extra-api';
  button('开始写',dialog).click();await wait(async()=>(await db.extrasOf(story.id)).length===1);
  const x=(await db.extrasOf(story.id))[0];assert.equal(x.connectionId,'extra-api');assert.equal(await db.kvGet('extraConnectionId',''),'extra-api');
  responses.push('第一篇文字','接着写的文字','重新生成的文字');root.replaceChildren();const dispose=await extras.render(root,{id:story.id,extraId:x.id});
  try{
    await wait(()=>!dispose.busy());button('接着当前版本写').click();await wait(()=>!dispose.busy()&&requests.length===2);
    button('重新生成一个版本').click();await wait(()=>!dispose.busy()&&requests.length===3);
    assert.ok(requests.every(r=>r.url==='https://extra.qa.example/v1/chat/completions'));
    const saved=await db.get('extras',x.id);assert.ok(saved.versions.every(v=>v.connectionId==='extra-api'));
    await db.del('connections','extra-api');button('接着当前版本写').click();await wait(()=>!dispose.busy());assert.equal(requests.length,3);
    root.querySelector('[aria-label="选择番外 API"]').click();await wait(()=>!!document.querySelector('.menu-list button'));
    document.querySelector('.menu-list button').click();await wait(async()=>(await db.get('extras',x.id)).connectionId==='qa-conn');
    button('接着当前版本写').click();await wait(()=>!dispose.busy()&&requests.length===4);
    assert.equal(requests[3].url,'https://model.qa.example/v1/chat/completions');assert.equal((await db.get('stories',story.id)).connectionId,'qa-conn');
  }finally{dispose();}
});

test('连续聊天消息不重复昵称，节目弹幕静态换行，报告是统一文档布局',async()=>{
  const {renderExtraLayout}=await import('../js/extra-layout.js');
  const chat=renderExtraLayout('【聊天】\n会话｜测试\n我｜林舟｜第一句\n我｜林舟｜第二句\n他｜许秋｜回答\n【/】');
  assert.equal(chat.querySelectorAll('.ex-message .ex-time').length,2);assert.equal(chat.querySelectorAll('.consecutive').length,1);
  const show=renderExtraLayout('【节目】\n弹幕｜观众一｜第一条\n弹幕｜观众二｜第二条\n【/】');root.append(show);
  assert.equal(show.querySelector('.ex-danmu').getAttribute('aria-label'),'节目弹幕');
  // 样式来自本测试进程加载的实际CSS。
  assert.equal(getComputedStyle(show.querySelector('.ex-danmu')).overflow,'visible');
  const report=renderExtraLayout('【报告】\n标题｜报告\n总评｜完整的总评\n现场｜新的现场\n处方｜下次见。\n【/】',{reportMode:true});
  assert.ok(report.classList.contains('ex-report-document'));assert.ok(report.textContent.includes('新的现场'));
});

test('保存过的玩法模板只补一次新版要求，用户改写的内容保留',async()=>{
  const {getTemplates,saveTemplates}=await import('../js/fanwai.js');
  await db.kvSet('fwPlaybooksV1',true);
  await db.kvSet('fwTemplates',[{id:'playbook-chat',name:'他的聊天记录',scope:'all',text:'我自己补充的口吻要求'}]);
  const list=await getTemplates();assert.equal(list.length,1);assert.ok(list[0].text.startsWith('我自己补充的口吻要求'));assert.ok(list[0].text.includes('新版记录要求'));
  const text=list[0].text;assert.equal((await getTemplates())[0].text,text);
  list[0].text='我又重新编辑了';await saveTemplates(list);assert.equal((await getTemplates())[0].text,'我又重新编辑了');
});
