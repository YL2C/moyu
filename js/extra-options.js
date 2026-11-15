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
export function personPicker(story, label, {mixed = true} = {}) {
  const select = el('select', {'aria-label':label});
  const selfName = story.protagonist?.name?.trim() || '主角';
  const choices = new Map([['', {kind:'auto',name:''}],['__self',{kind:'self',name:selfName}]]);
  select.append(el('option',{value:''},'自动安排'),el('option',{value:'__self'},'主角（你）'+(selfName!=='主角'?' · '+selfName:'')));
  if (mixed) {choices.set('__mixed',{kind:'mixed',name:''});select.append(el('option',{value:'__mixed'},'不同人'));}
  (story.cards || []).forEach((c,i)=>{
    if (!c.name?.trim()) return;
    const key='card-'+i;choices.set(key,{kind:'character',cardId:c.id || '',name:c.name.trim()});
    select.append(el('option',{value:key},c.name.trim()));
  });
  select.append(el('option',{value:'__named'},'其他人物 · 直接填写名字'));
  const free = el('input', {placeholder:'没建卡的人物，直接写名字','aria-label':label+'姓名',hidden:true});
  select.addEventListener('change',()=>{free.hidden=select.value!=='__named';});
  const title = el('label',{text:label});
  return {select,free,title,el:el('div',{class:'field'},title,select,free),value:()=> select.value==='__named'?{kind:'named',name:free.value.trim()}:({...choices.get(select.value) || {kind:'auto',name:''}})};
}
export function companionPicker(story) {
  const checks=[];const content=el('div',{class:'extra-companions'});
  for(const c of story.cards || []){
    if(!c.name?.trim())continue;
    const cb=el('input',{type:'checkbox','aria-label':'随行人：'+c.name});
    content.append(el('label',{class:'extra-companion'},cb,el('span',{text:c.name})));
    checks.push({cb,person:{kind:'character',cardId:c.id || '',name:c.name.trim()}});
  }
  const free=el('input',{placeholder:'其他随行人姓名，用顿号或逗号分隔','aria-label':'其他随行人'});
  return {el:el('div',{class:'field'},el('label',{text:'随行人（可多选）'}),el('div',{class:'hint',text:'主角默认参与；未指定时由 AI 根据剧情安排。'}),content,free),value:()=>{
    const people=[...checks.filter(x=>x.cb.checked).map(x=>x.person),...free.value.split(/[、,，\n]/).map(s=>s.trim()).filter(Boolean).map(name=>({kind:'named',name}))];
    return people.filter((p,i)=>people.findIndex(q=>q.name===p.name)===i);
  }};
}
export function castNames(cast = {}) { return [cast.owner,cast.reporter,...(cast.companions || [])].filter(p=>p?.name).map(p=>p.name); }
export function castText(cast = {}, layout = '') {
  const person = p => p?.kind === 'mixed' ? '不同人（逐个明确记录归属或观察对象）' : p?.name ? (p.kind==='self'?'主角（你）：':'')+p.name : '根据当前剧情自动安排';
  if(layout==='show')return '【随行人】主角默认参与；'+(cast.companions?.length?cast.companions.map(person).join('、'):'其他随行人根据剧情安排')+'。所有选中的人须持续参与并有独立反应，可以原创其他嘉宾但不能替换所选随行人。';
  if(layout==='chat')return '【记录主人】'+person(cast.owner)+'。'+(cast.owner?.kind==='mixed'?'按人物分组并标清每份记录属于谁。':'各组聊天属于同一位记录主人，可以与不同对象聊天，不随意切换手机主人。')+'聊天中的“我”始终是本组记录主人，“他”是对方；角色名按实际身份填写。记录主人不等于所有聊天对象。';
  if(layout==='report')return '【观察对象】'+person(cast.owner)+'。\n【报告人】'+person(cast.reporter)+'。'+(cast.owner?.kind==='mixed'?'写一份共同主题的多人观察报告，每个人有独立证据和小结，最后联系起来，不拼贴重复模板。':'围绕所选对象写一份完整报告。')+'报告人决定语气和知情范围，无法获知的内容只能注明推测，不能冒充亲历。';
  return '';
}

export function castSummary(cast = {}, layout = '') {
  const name=p=>p?.kind==='mixed'?'不同人':p?.kind==='self'?'主角（你）':p?.name || '自动安排';
  if(layout==='show')return '随行人：主角（你）'+(cast.companions?.length?'、'+cast.companions.map(name).join('、'):'；其他人自动安排');
  if(layout==='chat')return '记录主人：'+name(cast.owner);
  if(layout==='report')return '观察对象：'+name(cast.owner)+' · 报告人：'+name(cast.reporter);
  return '';
}
