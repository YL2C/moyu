import { el } from './util.js';
import { db } from './db.js';
import { getConnections, connLabel } from './state.js';

export async function extraConnection(id) {
  const list = await getConnections();
  const chosen = id || await db.kvGet('extraConnectionId', '') || list[0]?.id;
  // 明确选择过的连接若被删除，不静默换成正文或另一条连接。
  return list.find(c => c.id === chosen) || null;
}
export async function connectionSelect() {
  const list = await getConnections();
  const saved = await db.kvGet('extraConnectionId', '');
  const select = el('select', {'aria-label':'番外 API'});
  select.append(el('option',{value:''},'选择番外使用的 API'), ...list.map(c=>el('option',{value:c.id},connLabel(c))));
  select.value = list.some(c=>c.id===saved) ? saved : list[0]?.id || '';
  return select;
}
export function personPicker(story, label, {mixed = true, allowSelf = true} = {}) {
  const select = el('select');
  const free = el('input', {placeholder:'没建卡的人物，直接写名字',hidden:true});
  const title = el('label');
  const selfName = story.protagonist?.name?.trim() || '主角';
  const choices = new Map();
  const configure = ({label:nextLabel=label,mixed:nextMixed=mixed,allowSelf:nextSelf=allowSelf}={}) => {
    const previous=select.value;
    label=nextLabel;mixed=nextMixed;allowSelf=nextSelf;
    title.textContent=label; select.setAttribute('aria-label',label); free.setAttribute('aria-label',label+'姓名');
    select.replaceChildren(); choices.clear(); choices.set('',{kind:'auto',name:''});
    select.append(el('option',{value:''},'自动安排'));
    if(allowSelf){choices.set('__self',{kind:'self',name:selfName});select.append(el('option',{value:'__self'},'主角（你）'+(selfName!=='主角'?' · '+selfName:'')));}
    const group=el('optgroup',{label:'角色卡'});
    (story.cards || []).forEach((c,i)=>{
      if(!c.name?.trim() || (!allowSelf && c.name.trim()===selfName))return;
      const key='card-'+i;choices.set(key,{kind:'character',cardId:c.id || '',name:c.name.trim()});
      group.append(el('option',{value:key},c.name.trim()));
    });
    if(group.children.length)select.append(group);
    if(mixed){choices.set('__mixed',{kind:'mixed',name:''});select.append(el('option',{value:'__mixed'},'不同人'));}
    select.append(el('option',{value:'__named'},'其他人物 · 没建卡的直接填写名字'));
    select.value=previous==='__named'||choices.has(previous)?previous:'';
    free.hidden=select.value!=='__named';
  };
  select.addEventListener('change',()=>{free.hidden=select.value!=='__named';});
  configure();
  return {select,free,title,configure,el:el('div',{class:'field'},title,select,free),value:()=>select.value==='__named'?{kind:'named',name:free.value.trim()}:({...choices.get(select.value)||{kind:'auto',name:''}})};
}
export function companionPicker(story) {
  const checks=[];const content=el('div',{class:'extra-companions'});
  for(const c of story.cards || []){
    if(!c.name?.trim() || c.name.trim() === story.protagonist?.name?.trim())continue;
    const cb=el('input',{type:'checkbox','aria-label':'随行人：'+c.name});
    content.append(el('label',{class:'extra-companion'},cb,el('span',{text:c.name})));
    checks.push({cb,person:{kind:'character',cardId:c.id || '',name:c.name.trim()}});
  }
  const free=el('input',{placeholder:'其他随行人姓名，用顿号或逗号分隔','aria-label':'其他随行人'});
  return {el:el('div',{class:'field'},el('label',{text:'和谁参加恋综（可多选）'}),el('div',{class:'hint',text:'主角默认参与；未指定时由 AI 根据剧情安排。'}),content,checks.length?null:el('div',{class:'hint',text:'当前故事暂无其他已保存角色卡，可直接填写人物姓名。'}),free),value:()=>{
    const people=[...checks.filter(x=>x.cb.checked).map(x=>x.person),...free.value.split(/[、,，\n]/).map(s=>s.trim()).filter(Boolean).map(name=>({kind:'named',name}))];
    return people.filter((p,i)=>p.name!==story.protagonist?.name?.trim() && people.findIndex(q=>q.name===p.name)===i);
  }};
}
export function castNames(cast = {}) { return [cast.protagonist,cast.owner,cast.partner,cast.subject,cast.reporter,...(cast.companions || [])].filter(p=>p?.name).map(p=>p.name); }
export function castText(cast = {}, layout = '') {
  const person = p => p?.kind==='mixed'?'不同人':p?.name?(p.kind==='self'?'主角（你）：':'')+p.name:'从当前剧情相关人物中自动安排';
  const self=cast.protagonist?.name || '主角（你）';
  const center='【关系中心】'+self+'默认参与本篇番外，是玩家主角；所选另一位人物不替代主角。所有玩法围绕主角及所选人物的关系展开，不能擅自换人。';
  if(layout==='show')return center+'\n【和谁参加恋综】'+(cast.companions?.length?cast.companions.map(person).join('、'):'其他随行人根据剧情安排')+'。主角与所有所选人物共同参加，所选人物须持续参与且有独立反应；可有竞争、合作与误会，多人同行不自动代表多人恋爱。';
  if(layout==='fic'){
    const partner=cast.partner || cast.owner;
    return center+'\n【和谁的同人文】'+person(partner)+'。'+(partner?.kind==='mixed'?'各篇分别以“'+self+'＋不同人物”为核心组合；分别标清配对，不混成多人共同恋爱。':'各篇同人核心组合固定为“'+self+'＋'+person(partner)+'”，不要另配第三人。')+'这里选的是同人关系对象，不是叙述视角或作者；作者、体裁、叙述视角、评论者与读后反应可在指令框架内安排。';
  }
  if(layout==='chat')return center+'\n【看谁的手机】'+person(cast.owner)+'。'+(cast.owner?.kind==='mixed'?'按不同手机主人分别组织记录，标清每份记录属于谁；外层用第三人称。':'各组会话来自同一位手机主人；聊天对象可以变化，手机主人不能变化。外层写“你”如何看到这些记录以及阅读反应。')+'不要求主角每段聊天都出场，但整篇须从这些材料拼出与主角有关的小剧情。每组左右气泡里的“我”是本组手机主人，“他”是对方，昵称使用符合身份的网名或备注；玩家主角始终是'+self+'，不会因为看别人的手机而被替换。';
  if(layout==='report'){
    const subject=cast.subject || cast.owner;
    return center+'\n【看谁的恋爱脑报告】'+person(subject)+'。'+(subject?.kind==='self'?'观察主角自身的恋爱情绪与行为，关系对象结合现有剧情或本次要求确定，不捏造新恋人。':'报告分析所选人物在与'+self+'的关系中表现出的偏心、嘴硬和变化。')+(subject?.kind==='mixed'?'各人分别分析与主角的关系，独立证据和小结在同一主题中联系；不自动合成多人共同恋爱。':'围绕所选人物写一份完整报告。')+'\n【谁写报告】'+person(cast.reporter)+'。此人是报告作者，决定语气和知情范围，不因此成为被分析的人或恋爱对象；未知私事只能明确推测，不能冒充亲历。';
  }
  return '';
}
export function castSummary(cast = {}, layout = '') {
  const name=p=>p?.kind==='mixed'?'不同人':p?.kind==='self'?'主角（你）':p?.name || '自动安排';
  if(layout==='show')return '和谁参加恋综：'+(cast.companions?.length?cast.companions.map(name).join('、'):'自动安排')+' · 主角默认参与';
  if(layout==='chat')return '看谁的手机：'+name(cast.owner);
  if(layout==='fic')return '和谁的同人文：'+name(cast.partner || cast.owner)+' · 主角默认参与';
  if(layout==='report')return '看谁的恋爱脑报告：'+name(cast.subject || cast.owner)+' · 谁写报告：'+name(cast.reporter);
  return '';
}
