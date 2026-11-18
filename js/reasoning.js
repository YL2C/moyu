// 只识别明确的思考标签，不依据语言、关键词或段落内容猜测，避免误删小说。
const NAMES = ['think', 'thinking', 'analysis', 'reasoning'];
export const FINAL_OUTPUT_GUIDE = '只输出最终回答；写剧情时只输出最终剧情正文及要求的标题、弹幕、选项或材料。不输出写作计划、推理过程、思维链、自检记录或分析说明，也不把这些内容放入正文。';
export const FINAL_BOUNDARY_GUIDE = '【正文边界协议】最终回答必须用单独一行 [MOYU_FINAL] 开始，用单独一行 [/MOYU_FINAL] 结束。这是最外层标记，优先于第一行写标题等旧要求；标题仍写在边界内第一行。只在这两行之间写要给玩家看的最终剧情、标题、弹幕、选项或番外材料；续写时边界内只写本次续写，不重复旧文。不在边界内写规划、分析、自检或思考说明；不要引用或解释这两个标记。';

export function extractFinalOutput(value,{streaming=false}={}) {
  const source=String(value||'');
  const start=/^[ \t]*\[MOYU_FINAL\][ \t]*(?:\r?\n|$)/mi.exec(source);
  if(!start)return {text:'',found:false};
  let text=source.slice(start.index+start[0].length);
  const end=/^[ \t]*\[\/MOYU_FINAL\][ \t]*(?:\r?\n|$)/mi.exec(text);
  if(end)text=text.slice(0,end.index);
  else if(streaming){const i=text.lastIndexOf('\n')+1;const tail=text.slice(i).trim();if(tail && '[/MOYU_FINAL]'.startsWith(tail.toUpperCase()))text=text.slice(0,i);}
  return {text:text.trim(),found:true};
}

const DRAFT_HEADING = /^(?:#{1,6}\s+)?(?:\[|【)?\s*(?:analysis|reasoning|thinking|(?:writing |story )?plan|outline|写作计划|写作思路|思考|推理|分析|自检|提纲|大纲)(?=\s*(?:[:：\]】]|$))/i;

// A complete chapter can still be identified when a model follows the older Markdown
// format. Inspect the whole reply after completion, never an in-progress prefix.
export function extractUnmarkedStory(value) {
  const text = String(value || '').trim().replace(/\r\n/g, '\n');
  const firstBreak = text.indexOf('\n');
  if (firstBreak < 0 || !/^#[ \t]+\S/.test(text)) return '';
  if (text.split('\n').some(line => DRAFT_HEADING.test(line.trim()))) return '';
  const body = text.slice(firstBreak + 1);
  const prose = body.split(/\n\s*\n/).filter(block => {
    const paragraph = block.trim();
    return paragraph.length >= 16 && !/^(?:[#【\[>\x60]|[-*+]\s|\d+[.)、]\s*|[A-Z][.)、]\s*)/.test(paragraph)
      && /[。！？.!?…][”’"'」』）)]*$/.test(paragraph);
  });
  return prose.length >= 2 ? text : '';
}

export function recoverableOutput(error) {
  return error?.kind === 'output_format' ? stripReasoning(error.detail).trim() : '';
}

export function inspectReasoning(value, { streaming = false } = {}) {
  const source=String(value || '');
  const tags=/<\s*(\/?)\s*(think|thinking|analysis|reasoning)(?=[\s/>])[^>]*>/gi;
  const stack=[];let text='',pos=0,hidden=false;
  for(const m of source.matchAll(tags)) {
    if(!stack.length)text+=source.slice(pos,m.index);
    hidden=true;
    const name=m[2].toLowerCase();
    if(m[1]) { const i=stack.lastIndexOf(name);if(i>=0)stack.splice(i); }
    else if(!/\/\s*>$/.test(m[0]))stack.push(name);
    pos=m.index+m[0].length;
  }
  if(stack.length)return {text,hidden:true,pending:true};
  let tail=source.slice(pos);
  const last=tail.lastIndexOf('<');
  if(last>=0){
    const rest=tail.slice(last),m=rest.match(/^<\s*\/?\s*([a-z]*)([^>]*)$/i);
    // 流式标签可能拆成 <th / ink>；完整但未闭合的开标签在结束时也不能泄漏。
    if(m && (streaming && !m[2].trim() && NAMES.some(n=>n.startsWith(m[1].toLowerCase())) || NAMES.includes(m[1].toLowerCase()) && (!m[2] || /^\s/.test(m[2])))) {
      tail=tail.slice(0,last);return {text:text+tail,hidden,pending:true};
    }
  }
  return {text:text+tail,hidden,pending:false};
}
export function stripReasoning(value, options) { return inspectReasoning(value,options).text; }
