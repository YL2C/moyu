// 只识别明确的思考标签，不依据语言、关键词或段落内容猜测，避免误删小说。
const NAMES = ['think', 'thinking', 'analysis', 'reasoning'];
export const FINAL_OUTPUT_GUIDE = '只输出最终回答；写剧情时只输出最终剧情正文及要求的标题、弹幕、选项或材料。不输出写作计划、推理过程、思维链、自检记录或分析说明，也不把这些内容放入正文。';

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
