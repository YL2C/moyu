import { el } from './util.js';
import { inlineText } from './inline.js';

const TYPES = new Set(['论坛','聊天','报告','节目','同人','场景','便笺']);
const ALIASES = {论坛体:'论坛',评论区:'论坛',聊天记录:'聊天',私聊:'聊天',群聊:'聊天',群聊记录:'聊天',报告书:'报告',恋爱脑报告:'报告',恋综:'节目',节目片段:'节目',同人文:'同人',发布页:'同人',同人发布页:'同人',正文场景:'场景',备忘录:'便笺',搜索记录:'便笺',草稿箱:'便笺',日历:'便笺',订单:'便笺',购物车:'便笺',导航记录:'便笺',转账备注:'便笺',歌单:'便笺'};
const ROW_KEYS = new Set(['标题','分区','标签','楼主','补充','热评','系统','会话','时间','他','我','语音','已读','档案','案例','指数','批注','诊断','处方','规则','环节','字幕','观察室','采访','弹幕','作者','简介','数据','正文','报告人','总评','表现','现场','结语','章节','主人','手机主人','备注','内容','条目','对白']);
function marker(line) {
  const clean=line.trim().replace(/^#{1,6}\s+/, '').replace(/^\*\*(.*?)\*\*$/, '$1');
  const m=clean.match(/^(?:【([^】]+)】|\[([^\]]+)\])$/);
  if(!m)return null;
  const label=(m[1]||m[2]).trim();
  if(/^[\/／]/.test(label)||label==='结束')return {end:true};
  const type=ALIASES[label] || label;
  return TYPES.has(type)?{type,label}:null;
}
function fieldsOf(line) {
  const f=line.split(/[｜|│]/).map(v=>v.trim());
  f[0]=f[0].replace(/^\*\*(.*?)\*\*$/, '$1').replace(/^(\d+)楼$/, '#$1').replace(/^#\s+(\d+)$/, '#$1');
  return f;
}
export function parseExtraLayout(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  if (/^#{1,4}\s+/.test(lines[0] || '')) lines.shift();
  const blocks = []; let prose = [];
  const flush = () => { if (prose.join('\n').trim()) blocks.push({ type: '场景', text: prose.join('\n').trim() }); prose = []; };
  for (let i = 0; i < lines.length; i++) {
    const m = marker(lines[i]);
    if (!m || m.end) { prose.push(lines[i]); continue; }
    flush();
    let end = i + 1;
    while (end < lines.length && !marker(lines[end])) end++;
    const closed=!!marker(lines[end]||'')?.end;
    const raw = lines.slice(i, end + (closed?1:0)).join('\n');
    const body = lines.slice(i + 1, end);
    const rows = []; let recognized = 0;
    for (const line of body) {
      if (!line.trim()) { if(rows.length) rows.at(-1)[rows.at(-1).length-1]+='\n'; continue; }
      const fields = fieldsOf(line);
      if (fields.length > 1) {
        // 昵称、原创栏目也保留为独立行，不能吞进上一条消息或丢掉字段名。
        rows.push(fields);
        if(ROW_KEYS.has(fields[0]) || /^#\d+$/.test(fields[0]) || m.type==='聊天')recognized++;
      }
      else if (rows.length) rows.at(-1)[rows.at(-1).length-1] += '\n' + line;
      else rows.push(['正文',line]);
    }
    // 缺少收尾时，在下一块边界恢复；EOF仅恢复有充分结构的材料，残缺文字仍原样回退。
    const usable=rows.length && (closed || end<lines.length || recognized>=2);
    blocks.push(m.type==='场景' ? {type:'场景',text:body.join('\n')} : !usable ? {type:'场景',text:raw,fallback:true} : {type:m.type,label:m.label,rows,raw,recovered:!closed});
    i = end - (closed?0:1);
  }
  flush(); return blocks;
}

export function renderExtraLayout(text, { emphasis = true, dialogueColor = true, reportMode = false, layout = '' } = {}) {
  const out = el('div', {class:'extra-layout'+(reportMode?' ex-report-document':'')});
  const blocks=parseExtraLayout(text);
  const showMode=layout==='show'||blocks.some(b=>b.type==='节目');
  const rich = text => inlineText(String(text || ''), emphasis, dialogueColor);
  const body = (text, className='ex-body') => el('div',{class:className},rich(text));
  const badge = (text, cls='') => el('span',{class:'ex-badge '+cls,text});
  const get = (rows,key) => rows.find(r=>r[0]===key)?.slice(1).join(' · ') || '';
  const heading = (box,rows,label) => {
    box.append(el('div',{class:'ex-eyebrow',text:label}));
    if(get(rows,'标题'))box.append(el('h3',{text:get(rows,'标题')}));
  };
  const showKeys=new Set(['对白','对话','规则','环节','字幕','观察室','采访','弹幕']);
  const showRow=(key,f) => {
    if(key==='弹幕')return el('div',{class:'ex-danmu','aria-label':'节目弹幕'},el('span',{},rich(f.join('：'))));
    if(['对白','对话'].includes(key))return el('aside',{class:'ex-show-dialogue'},badge(f[0]||'嘉宾'),body(f.slice(1).join('｜')));
    if(['字幕','观察室','采访'].includes(key))return el('aside',{class:'ex-callout'},badge(key),body(f.join(' · ')));
    return el('div',{class:'ex-segment'},el('div',{class:'ex-eyebrow',text:key}),body(f.join(' · ')));
  };
  const plain = block => {
    const box=el('div',{class:'ex-scene'+(block.fallback?' ex-fallback':'')});
    for(const p of block.text.split(/\n\s*\n/).filter(s=>s.trim())) {
      if(!showMode || block.fallback){box.append(el('p',{},rich(p)));continue;}
      // 部分模型把对白行放进【场景】或直接漏写【节目】，按显式栏目逐行恢复。
      let row=null, prose=[];
      const flush=()=>{if(row){const [key,...f]=row;box.append(el('div',{class:'ex-show-fragment'},showRow(key,f)));row=null;}if(prose.length){box.append(el('p',{},rich(prose.join('\n'))));prose=[];}};
      for(const line of p.split('\n')){
        const f=fieldsOf(line);
        if(f.length>1 && showKeys.has(f[0])){flush();row=f;}
        else if(row)row[row.length-1]+='\n'+line;
        else prose.push(line);
      }
      flush();
    }
    return box;
  };
  let commentHost=null;
  for(const block of blocks) {
    if(block.type==='场景' || !TYPES.has(block.type)) {out.append(plain(block));commentHost=null;continue;}
    const attachComments=block.type==='论坛' && commentHost;
    if(block.type!=='论坛')commentHost=null;
    const rows=block.rows, box=el('section',{class:'ex-block ex-'+({'论坛':'forum','聊天':'chat','报告':'report','节目':'show','同人':'fic','便笺':'note'}[block.type]),'aria-label':block.type});
    if(block.type==='论坛') {
      if(attachComments){box.classList.remove('ex-block');box.classList.add('ex-fic-comments');box.setAttribute('aria-label','作品评论');box.append(el('div',{class:'ex-comments-title',text:'评论'}));}
      else {heading(box,rows,get(rows,'分区')||'讨论区');if(get(rows,'标签'))box.append(el('div',{class:'ex-tags',text:get(rows,'标签')}));}
      const thread=el('div',{class:'ex-thread'});box.append(thread);
      for(const row of rows){
        const [key,...f]=row;
        if(['标题','分区','标签'].includes(key))continue;
        if(['正文','主帖'].includes(key)){thread.append(body(f.join('｜')));continue;}
        if(key==='系统'){thread.append(body(f.join('｜'),'ex-system'));continue;}
        let nick,time,text,floor,hot=false,likes='',ref='';
        if(key==='热评'){
          [floor,nick,...text]=f;hot=true;
          if(/(?:\d[:：]\d|今天|今日|昨天|刚刚|分钟前|小时前|月.*日)/.test(text[0]||''))time=text.shift();
          if(/^(?:(?:点赞|赞)\s*)?\d+[万千kK]?$/.test(text[0]||''))likes=text.shift().replace(/^(?:点赞|赞)\s*/,'');
          text=text.join('｜').trim();
        }
        else if(key==='楼主'||key==='补充'){[nick,time,...text]=f;text=text.join('｜');floor=key;}
        else if(/^#\d+$/.test(key)){floor=key;[nick,...text]=f;if(text.length>1&&!/^引用\s*#/.test(text[0]))time=text.shift();if(/^引用\s*#\d+$/.test(text[0]||''))ref=text.shift();text=text.join('｜');}
        else {thread.append(body(row.join('｜')));continue;}
        if(!nick || !text){thread.append(body(row.join('｜')));continue;}
        const post=el('article',{class:'ex-post'+(key==='楼主'?' ex-op':'')});
        const header=el('div',{class:'ex-post-head'},el('span',{class:'ex-avatar',text:Array.from(nick)[0]||'匿'}),el('span',{class:'ex-author',text:nick}),badge(floor));
        if(hot)header.append(badge('热评','hot'));
        post.append(header);if(time)post.append(el('div',{class:'ex-time',text:time}));
        if(ref)post.append(el('blockquote',{class:'ex-quote',text:ref.replace('引用','回复 ')}));
        post.append(body(text));if(likes)post.append(el('div',{class:'ex-likes',text:'赞 '+likes}));thread.append(post);
      }
    } else if(block.type==='聊天') {
      box.append(el('div',{class:'ex-chat-head',text:get(rows,'会话')||'聊天记录'}));
      let lastSender = '';
      for(const [key,...f] of rows){
        if(['会话','主人','手机主人'].includes(key))continue;
        if(key==='备注'){box.append(body(f.join(' · '),'ex-chat-note'));continue;}
        if(['时间','系统','已读'].includes(key)){box.append(body(f.join('｜'),'ex-system'));lastSender='';continue;}
        let side=key,nick=f[0],text=f.slice(1).join('｜');
        if(key==='语音'){[side,nick,...text]=f;text='语音 '+(text[0]||'')+' · '+text.slice(1).join('｜');}
        if(!ROW_KEYS.has(key)&&!['我','他'].includes(side)){
          nick=key;side=key===get(rows,'主人')||key===get(rows,'手机主人')?'我':'他';
          text=f.join('｜');
          if(f.length>1 && /^\d{1,2}[:：]\d{2}$/.test(f[0]))text=f.slice(1).join('｜');
        }
        if(!['我','他'].includes(side)||!nick){box.append(body([key,...f].join('｜')));continue;}
        const same = lastSender === side+'|'+nick;
        box.append(el('div',{class:'ex-message'+(side==='我'?' mine':'')+(same?' consecutive':'')},same?null:el('div',{class:'ex-speaker'},el('span',{class:'ex-chat-avatar','aria-hidden':'true',text:Array.from(nick)[0]||'匿'}),el('span',{class:'ex-time',text:nick})),body(text,'ex-bubble')));
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
      for(const [key,...f] of rows){
        if(key==='标题')continue;
        box.append(showRow(key,f));
      }
    } else if(block.type==='便笺') {
      heading(box,rows,block.label || '文字记录');
      for(const [key,...f] of rows){
        if(key==='标题')continue;
        box.append(key==='时间'?body(f.join('｜'),'ex-time'):el('div',{class:'ex-note-row'},key==='正文'?null:badge(key),body(f.join('｜'))));
      }
    } else {
      heading(box,rows,'FANWORK · 同人发布');
      if(get(rows,'作者'))box.append(el('div',{class:'ex-byline',text:'作者 '+get(rows,'作者')}));
      if(get(rows,'标签'))box.append(el('div',{class:'ex-tags',text:get(rows,'标签')}));
      for(const [key,...f] of rows){
        if(['标题','作者','标签'].includes(key))continue;
        if(key==='数据'){box.append(el('div',{class:'ex-stats',text:'喜欢 '+(f[0]||'0')+' · 收藏 '+(f[1]||'0')+' · 模拟数据'}));continue;}
        if(!ROW_KEYS.has(key)){box.append(el('aside',{class:'ex-callout'},badge(key),body(f.join('｜'))));continue;}
        box.append(body(f.join('｜'),key==='简介'?'ex-callout':'ex-fic-text'));
      }
    }
    if(attachComments)attachComments.append(box);
    else out.append(box);
    if(block.type==='同人')commentHost=box;
  }
  return out;
}
