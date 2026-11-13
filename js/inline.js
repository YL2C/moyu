// 仅解析两种文字标记，永不把模型文本当作HTML执行。
export function inlineText(text, enabled = true) {
  const fragment = document.createDocumentFragment();
  const value = String(text || '');
  const pattern = /\*\*([^*\n]{1,160})\*\*|==([^=\n]{1,160})==/g;
  let pos = 0;
  for (const match of value.matchAll(pattern)) {
    fragment.append(document.createTextNode(value.slice(pos, match.index)));
    if (enabled) {
      const node = document.createElement(match[1] ? 'strong' : 'span');
      if (match[2]) node.className = 'text-highlight';
      node.textContent = match[1] || match[2]; fragment.append(node);
    } else fragment.append(document.createTextNode(match[1] || match[2]));
    pos = match.index + match[0].length;
  }
  fragment.append(document.createTextNode(value.slice(pos))); return fragment;
}

export const EMPHASIS_GUIDE = '排版可以少量突出真正重要的短语：关键承诺或事实用 **加粗**，关键线索或转折可用 ==强调色==。每轮最多三处，每处尽量短；不强行凑数，不强调整段，不在选项或弹幕中加标记。';
