// 墨游 · 每轮重新拼装发给模型的内容
// 顺序：不常变的放前面（规则 → 设定 → 格式），剧情原文在后——以后加缓存时省钱。

import { forContext } from './parse.js';

export const DEFAULT_RULES = `【玩法】
- 你是这场文字互动小说的主持人（GM）兼叙述者，负责世界和其中所有角色；玩家扮演主角，用第二人称“你”称呼主角。
- 玩家输入里，“”内是主角说出口的话；引号外是动作或内心想法。内心想法其他角色听不到，也无从得知。
- 不替主角说话、做决定或主动行动；主角身体的自然反应可以写。
- 只有玩家宣布才算结局。

【节奏】
- 每轮只推进一个场景里的一两个关键动作，不跳时间、不切场景，不用“几天后”“两人聊了很久”这类概括带过。
- 停在局面发生变化、需要主角接招的地方，不替主角把反应写完。
- 世界不需要主角推动也会运转：角色有自己的目标和生活，会主动出手。

【人物】
- 每个角色有自己的动机、立场和说话方式，按人设行事，不为剧情需要突然变脸。
- 感情变化要有来由，建立在和主角共同经历的具体事件上，不凭空生出深情或敌意。
- 角色只知道通过合理渠道得知的事，不开上帝视角。

【文风】
- 小说式文笔，传统中文自然段，对白、动作、心理融合在段落里；不一句一段，也不堆成大块。
- 感情交给细节和动作，不替人物总结；少用套话和固定句式。`;

export function formatContract({ danmu = true, options = true } = {}) {
  const parts = [
    '每次回复严格按下面的格式，不要输出格式以外的说明：',
    '# 本章标题（第一行，四到十二个字，不写“第几章”）',
    '（空一行后写正文）',
  ];
  if (danmu) {
    parts.push(
      '【弹幕】',
      '网名：弹幕内容',
      '（3到8条，一行一条。弹幕是正在看这段剧情的读者实况：吐槽、嗑CP、站队、预测、尖叫，长短错落；不复述正文原句，不写分析文。剧中人物不知道弹幕存在。）'
    );
  }
  if (options) {
    parts.push(
      '【选项】',
      'A. ……',
      'B. ……',
      'C. ……',
      '（3个方向明显不同的参考行动：写具体能做的事，不写结果，不泄露隐藏信息。玩家也可以完全不按选项来。）'
    );
  }
  parts.push('', '玩家以“（出戏）”开头的话是场外交流：用场外身份简短直接地回答，不推进剧情，不用上面的格式。');
  return parts.join('\n');
}

export function userContent(node, { withDirector = false } = {}) {
  let c;
  if (node.kind === 'start') {
    c = '（开始游戏）\n' + (node.text?.trim()
      ? '开场：' + node.text.trim()
      : '请根据设定写开场：交代主角此刻所处的情境，停在第一个需要主角行动的地方。');
  } else if (node.kind === 'continue') {
    c = '（继续：让剧情自然往前走一步，不替我做选择）';
  } else if (node.kind === 'ooc') {
    c = '（出戏）' + (node.text || '');
  } else {
    c = node.text || '';
  }
  if (withDirector && node.director?.trim()) {
    c += '\n\n【导演指令·仅本轮有效，来自玩家的场外要求：照做，但不要在正文里提到】\n' + node.director.trim();
  }
  return c;
}

export const CONTINUE_MSG = '（系统：上一条回复中途断开了。请从断开的地方直接接着往下写完，不要重复已经写过的内容，不要加任何开场白。）';

/**
 * path：从第一条到当前的节点（最后一条通常是刚发出的玩家输入）
 * 返回 { system, messages, info }
 */
export function buildContext(story, path, { budgetChars = 60000, keepRawLast = 2 } = {}) {
  const system = [
    '你正在主持一场文字互动小说。',
    story.rules?.trim() ? '【规则】\n' + story.rules.trim() : '',
    story.world?.trim() ? '【世界与角色设定】\n' + story.world.trim() : '',
    '【输出格式】\n' + formatContract({ danmu: story.danmu !== false, options: story.options !== false }),
  ].filter(Boolean).join('\n\n');

  // 出戏对话：之后已经回到正戏的，就不再发给模型
  let lastPlayUser = -1;
  path.forEach((n, i) => { if (n.role === 'user' && n.kind !== 'ooc') lastPlayUser = i; });
  const kept = path.filter((n, i) => !(n.kind === 'ooc' && i < lastPlayUser));

  // 最近 keepRawLast 轮的回复保留弹幕和选项（让模型延续口气），更早的只留正文
  const playReplies = kept.filter((n) => n.role === 'assistant' && n.kind !== 'ooc');
  const rawSet = new Set(playReplies.slice(-keepRawLast).map((n) => n.id));

  const lastUserIdx = kept.map((n) => n.role).lastIndexOf('user');
  let messages = [];
  kept.forEach((n, i) => {
    if (n.role === 'user') {
      messages.push({ role: 'user', content: userContent(n, { withDirector: i === lastUserIdx }) });
    } else if (n.text && n.text.trim()) {
      const content = n.kind === 'ooc' || rawSet.has(n.id) ? n.text.trim() : forContext(n.text);
      messages.push({ role: 'assistant', content });
    }
  });

  // 超出预算时从最早的开始丢（至少保留最后 6 条）
  let trimmed = 0;
  const size = (ms) => ms.reduce((a, m) => a + m.content.length, 0);
  while (messages.length > 6 && size(messages) + system.length > budgetChars) {
    messages.shift();
    trimmed++;
  }
  const historyChars = size(messages);
  return {
    system,
    messages,
    info: { systemChars: system.length, historyChars, totalChars: system.length + historyChars, trimmed, count: messages.length },
  };
}
