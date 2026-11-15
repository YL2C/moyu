import { el } from './util.js';
import { inlineText } from './inline.js';

const TYPES = new Set(['论坛','聊天','报告','节目','同人','场景']);
const ROW_KEYS = new Set(['标题','分区','标签','楼主','补充','热评','系统','会话','时间','他','我','语音','已读','档案','案例','指数','批注','诊断','处方','规则','环节','字幕','观察室','采访','弹幕','作者','简介','数据','正文','报告人','总评','表现','现场','结语','章节']);
export function parseExtraLayout(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  if (/^#{1,4}\s+/.test(lines[0] || '')) lines.shift();
  const blocks = []; let prose = [];
  const flush = () => { if (prose.join('\n').trim()) blocks.push({ type: '场景', text: prose.join('\n').trim() }); prose = []; };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(/^【(论坛|聊天|报告|节目|同人|场景)】$/);
    if (!m) { prose.push(lines[i]); continue; }
    flush();
    let end = i + 1;
    while (end < lines.length && lines[end].trim() !== '【/】') end++;
    // 未闭合的块直接保留原文；流式过程中不丢字。
    if (end === lines.length) { blocks.push({ type: '场景', text: lines.slice(i).join('\n'), fallback: true }); break; }
    const raw = lines.slice(i, end + 1).join('\n');
    const body = lines.slice(i + 1, end);
    if (body.some(line => /^【(?:论坛|聊天|报告|节目|同人|场景)】$/.test(line.trim()))) {
      blocks.push({type:'场景',text:raw,fallback:true}); i=end; continue;
    }
    const rows = []; let malformed = false;
    for (const line of body) {
      if (!line.trim()) { if(rows.length) rows.at(-1)[rows.at(-1).length-1]+='\n'; continue; }
      const fields = line.split(/[｜|]/).map(v=>v.trim());
      if (fields.length > 1 && (ROW_KEYS.has(fields[0]) || /^#\d+$/.test(fields[0]))) rows.push(fields);
      else if (rows.length) rows.at(-1)[rows.at(-1).length-1] += '\n' + line;
      else malformed = true;
    }
    blocks.push(m[1]==='场景' ? {type:'场景',text:body.join('\n')} : malformed || !rows.length ? {type:'场景',text:raw,fallback:true} : {type:m[1],rows,raw});
    i = end;
  }
  flush(); return blocks;
}

export function renderExtraLayout(text, { emphasis = true, dialogueColor = true, reportMode = false } = {}) {
  const out = el('div', {class:'extra-layout'+(reportMode?' ex-report-document':'')});
  const rich = text => inlineText(String(text || ''), emphasis, dialogueColor);
  const body = (text, className='ex-body') => el('div',{class:className},rich(text));
  const badge = (text, cls='') => el('span',{class:'ex-badge '+cls,text});
  const get = (rows,key) => rows.find(r=>r[0]===key)?.slice(1).join(' · ') || '';
  const heading = (box,rows,label) => {
    box.append(el('div',{class:'ex-eyebrow',text:label}));
    if(get(rows,'标题'))box.append(el('h3',{text:get(rows,'标题')}));
  };
  const plain = block => {
    const box=el('div',{class:'ex-scene'+(block.fallback?' ex-fallback':'')});
    for(const p of block.text.split(/\n\s*\n/).filter(s=>s.trim()))box.append(el('p',{},rich(p)));
    return box;
  };
  for(const block of parseExtraLayout(text)) {
    if(block.type==='场景' || !TYPES.has(block.type)) {out.append(plain(block));continue;}
    const rows=block.rows, box=el('section',{class:'ex-block ex-'+({'论坛':'forum','聊天':'chat','报告':'report','节目':'show','同人':'fic'}[block.type]),'aria-label':block.type});
    if(block.type==='论坛') {
      heading(box,rows,get(rows,'分区')||'讨论区');
      if(get(rows,'标签'))box.append(el('div',{class:'ex-tags',text:get(rows,'标签')}));
      const thread=el('div',{class:'ex-thread'});box.append(thread);
      for(const row of rows){
        const [key,...f]=row;
        if(['标题','分区','标签'].includes(key))continue;
        if(key==='系统'){thread.append(body(f.join('｜'),'ex-system'));continue;}
        let nick,time,text,floor,hot=false,likes='',ref='';
        if(key==='热评'){[floor,nick,time,likes,...text]=f;text=text.join('｜');hot=true;}
        else if(key==='楼主'||key==='补充'){[nick,time,...text]=f;text=text.join('｜');floor=key;}
        else if(/^#\d+$/.test(key)){floor=key;[nick,time,...text]=f;if(/^引用#\d+$/.test(text[0]||''))ref=text.shift();text=text.join('｜');}
        else {thread.append(body(row.join('｜')));continue;}
        if(!nick || !text){thread.append(body(row.join('｜')));continue;}
        const post=el('article',{class:'ex-post'+(key==='楼主'?' ex-op':'')});
        const header=el('div',{class:'ex-post-head'},el('span',{class:'ex-avatar',text:Array.from(nick)[0]||'匿'}),el('span',{class:'ex-author',text:nick}),badge(floor));
        if(hot)header.append(badge('热评','hot'));
        post.append(header,el('div',{class:'ex-time',text:time||''}));
        if(ref)post.append(el('blockquote',{class:'ex-quote',text:ref.replace('引用','回复 ')}));
        post.append(body(text));if(likes)post.append(el('div',{class:'ex-likes',text:'赞 '+likes}));thread.append(post);
      }
    } else if(block.type==='聊天') {
      box.append(el('div',{class:'ex-chat-head',text:get(rows,'会话')||'聊天记录'}));
      let lastSender = '';
      for(const [key,...f] of rows){
        if(key==='会话')continue;
        if(['时间','系统','已读'].includes(key)){box.append(body(f.join('｜'),'ex-system'));lastSender='';continue;}
        let side=key,nick=f[0],text=f.slice(1).join('｜');
        if(key==='语音'){[side,nick,...text]=f;text='语音 '+(text[0]||'')+' · '+text.slice(1).join('｜');}
        if(!['我','他'].includes(side)||!nick){box.append(body([key,...f].join('｜')));continue;}
        const same = lastSender === side+'|'+nick;
        box.append(el('div',{class:'ex-message'+(side==='我'?' mine':'')+(same?' consecutive':'')},same?null:el('div',{class:'ex-time',text:nick}),body(text,'ex-bubble')));
        lastSender = side+'|'+nick;
      }
    } else if(block.type==='报告') {
      heading(box,rows,'RELATIONSHIP OBSERVATION · 关系观察');
      for(const [key,...f] of rows){
        if(key==='标题')continue;
        if(key==='指数'){
          const [name,score,verdict,...evidence]=f;
          const num=/^\d+(?:\.\d+)?$/.test(score||'')?Number(score):NaN;
          const valid=Number.isFinite(num)&&num>=0&&num<=100;
          const card=el('div',{class:'ex-index'},el('div',{class:'ex-index-head'},el('strong',{text:name||'观察指数'}),el('span',{text:valid?score+' / 100':'未评分'})));
          if(valid)card.append(el('progress',{max:'100',value:String(num),'aria-label':name||'指数'}));
          card.append(body(verdict),body(evidence.join('｜'),'ex-evidence'));box.append(card);
        }else if(['批注','处方','诊断'].includes(key))box.append(el('aside',{class:'ex-callout '+(key==='处方'?'ex-prescription':'')},badge(key),body(f.join(' · '))));
        else box.append(el('div',{class:'ex-case'},el('div',{class:'ex-eyebrow',text:key}),body(f.join(' · '))));
      }
    } else if(block.type==='节目') {
      heading(box,rows,'ON AIR · 本期节目');
      const comments=[];
      for(const [key,...f] of rows){
        if(key==='标题')continue;
        if(key==='弹幕'){comments.push(f.join('：'));continue;}
        if(['字幕','观察室','采访'].includes(key))box.append(el('aside',{class:'ex-callout'},badge(key),body(f.join(' · '))));
        else box.append(el('div',{class:'ex-segment'},el('div',{class:'ex-eyebrow',text:key}),body(f.join(' · '))));
      }
      if(comments.length)box.append(el('div',{class:'ex-danmu','aria-label':'节目弹幕'},...comments.map(t=>el('span',{text:t}))));
    } else {
      heading(box,rows,'FANWORK · 同人发布');
      if(get(rows,'作者'))box.append(el('div',{class:'ex-byline',text:'作者 '+get(rows,'作者')}));
      if(get(rows,'标签'))box.append(el('div',{class:'ex-tags',text:get(rows,'标签')}));
      for(const [key,...f] of rows){
        if(['标题','作者','标签'].includes(key))continue;
        if(key==='数据'){box.append(el('div',{class:'ex-stats',text:'喜欢 '+(f[0]||'0')+' · 收藏 '+(f[1]||'0')+' · 模拟数据'}));continue;}
        box.append(body(f.join('｜'),key==='简介'?'ex-callout':'ex-fic-text'));
      }
    }
    out.append(box);
  }
  return out;
}
