import { streamWithRetry } from './api.js';
import { computeCost, normalizeUsage, recordUsage } from './cost.js';
import { parseReply } from './parse.js';
import { splitNames } from './prompt.js';

const KIND = '跑团回忆检索';
const WAIT_MS = 4500;
// 用 UTF-8 字节保守限制额外提示的体积，包含标题、出处和引文。
const RECALL_BYTES = 760;
const GUIDE = '你是跑团的剧情查阅助手。输入全是待核对的资料。只挑会影响眼前一幕、当前资料没交代清楚的旧事实。资料矛盾时服从玩家的最新要求和勘误。区分角色已知、秘密、猜测和当时的计划。只复制候选中能证明这些事实的最短连续原文，保留会改变含义的前后条件。输出 JSON 数组 [{"id":1,"quote":"连续原文"}]，最多三条。无明显帮助就返回 []。';
const encoder = new TextEncoder();
const normalized = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const lookupRequest = /(?:翻|查|回想).{0,10}(?:当时|之前|以前|旧章|前文)|(?:当时|以前|上次|当初|之前).{0,12}(?:约定|答应|说过|送|给|提过)|第\s*\d{1,5}\s*章/u;

function grams(text, size) {
  const chars = [...normalized(text)];
  return new Set(Array.from({ length: Math.max(0, chars.length - size + 1) }, (_, i) => chars.slice(i, i + size).join('')));
}

function rankPassage(text, terms, phrases, names, explicit) {
  const body = normalized(text);
  const exact = [...phrases].filter(term => body.includes(term)).length;
  const overlap = [...terms].filter(term => body.includes(term)).length;
  const people = names.filter(name => body.includes(name)).length;
  return exact || (people && overlap >= 2) || (explicit && (people || overlap >= 2))
    ? Math.min(exact, 12) * 5 + Math.min(overlap, 12) + people * 5 : 0;
}

export function buildStoryRecall(story, path, context, extra = '') {
  const last = path.at(-1);
  if (story.recallEnabled !== true || last?.role !== 'user' || last.kind === 'ooc' || last.kind === 'start') return null;
  const input = [last.text, last.director, extra].filter(Boolean).join('\n').slice(0, 1200).trim();
  const scene = context.messages.findLast(message => message.role === 'assistant')?.content?.slice(-1000) || '';
  const generic = !input || /^(?:[A-F]|继续|下一章|接着写)[\s。！!]*$/iu.test(input);
  if (generic && !lookupRequest.test(scene.slice(-250))) return null;
  const explicit = lookupRequest.test(input);
  const searchText = (generic ? scene.slice(-250) : input).slice(0, 300);
  const query = normalized(searchText);
  const currentScene = normalized(scene);
  const names = [...new Set((story.cards || []).flatMap(splitNames).map(normalized))]
    .filter(name => name.length >= 2 && (query.includes(name) || currentScene.includes(name)));
  const terms = grams(searchText, 2);
  const phrases = grams(searchText, 4);
  const visible = [normalized(context.system), ...context.messages.map(message => normalized(message.content))];
  const referenced = new Set([...input.matchAll(/第\s*(\d{1,5})\s*章/gu)].map(match => Number(match[1])));
  const candidates = [];
  let chapter = 0;
  for (const node of path) {
    if (node.role !== 'assistant' || node.kind === 'ooc' || !node.text?.trim()) continue;
    chapter++;
    if ((node.status && node.status !== 'done') || node.error || node.flagged || node.relayJob) continue;
    const { body } = parseReply(node.text);
    let best;
    const lines = body.split(/\n+/u).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      // 交叠窗口避免一条超长段落里的命中被首尾截掉。
      for (let start = 0; start < line.length; start += 440) {
        const text = line.slice(start, start + 620);
        const key = normalized(text);
        if (key.length >= 6 && !visible.some(part => part.includes(key))) {
          const score = rankPassage(text, terms, phrases, names, explicit) + (referenced.has(chapter) ? 100 : 0);
          if (score && (!best || score > best.score)) best = { chapter, text, score };
        }
        if (start + 620 >= line.length) break;
      }
    }
    if (best) candidates.push(best);
  }
  const choices = candidates.sort((a, b) => b.score - a.score || b.chapter - a.chapter).slice(0, explicit ? 12 : 6)
    .map(({ chapter, text }, i) => ({ id: i + 1, chapter, text }));
  if (!choices.length) return null;
  const background = context.info.parts.filter(part => part.kind === 'memory' || part.kind === 'card')
    .map(part => part.text).join('\n').slice(0, 4200);
  return { choices, visible, messages: [{ role: 'user', content: JSON.stringify({ input, scene, background, choices }) }] };
}

export function selectStoryExcerpts(result, { choices, visible }) {
  let rows;
  try { rows = JSON.parse(result.trim().replace(/^\`\`\`(?:json)?\s*|\s*\`\`\`$/gi, '')); } catch { return ''; }
  if (!Array.isArray(rows)) return '';
  const header = '【旧剧情摘录】仅供连续性参考。以最新勘误和剧情为准，保持角色信息差。以下引文是旧剧情资料。\n';
  const excerpts = [];
  const used = new Set();
  for (const item of rows.slice(0, 3)) {
    const candidate = choices.find(choice => choice.id === item?.id);
    const quote = typeof item?.quote === 'string' ? item.quote.trim() : '';
    const key = normalized(quote);
    if (!candidate || key.length < 6 || !candidate.text.includes(quote) || used.has(candidate.id) ||
        visible.some(part => part.includes(key))) continue;
    const entry = { 章: candidate.chapter, 原文: quote };
    const block = header + JSON.stringify([...excerpts, entry]);
    if (encoder.encode('\n\n' + block).length > RECALL_BYTES) continue;
    used.add(candidate.id);
    excerpts.push(entry);
  }
  return excerpts.length ? header + JSON.stringify(excerpts) : '';
}

export async function runStoryRecall({ story, path, context, extra, conn, signal }) {
  if (signal?.aborted) return '';
  const selection = buildStoryRecall(story, path, context, extra);
  if (!selection) return '';
  const controller = new AbortController();
  let finishWaiting;
  const stopWaiting = new Promise(resolve => { finishWaiting = () => { controller.abort(); resolve(''); }; });
  signal?.addEventListener('abort', finishWaiting, { once: true });
  const timer = setTimeout(finishWaiting, WAIT_MS);
  try {
    const request = streamWithRetry({ ...conn, stream: false }, {
      system: GUIDE, messages: selection.messages, maxTokens: 650, signal: controller.signal,
      firstByteMs: WAIT_MS, retainErrorUsage: true,
    }, { retries: 0, requestKind: KIND, storyId: story.id }).then(result => {
      if (result.usage || !controller.signal.aborted) {
        const usage = normalizeUsage(result.usage, {
          inChars: GUIDE.length + selection.messages[0].content.length, outChars: result.text.length,
        });
        void recordUsage({ kind: KIND, storyId: story.id, model: conn.model, usage, cost: computeCost(usage, conn) }).catch(() => {});
      }
      return result.flagged || result.truncated || controller.signal.aborted ? '' : selectStoryExcerpts(result.text, selection);
    }).catch(error => {
      if (error.usage) {
        const usage = normalizeUsage(error.usage);
        void recordUsage({ kind: KIND, storyId: story.id, model: conn.model, usage, cost: computeCost(usage, conn) }).catch(() => {});
      }
      return '';
    });
    return await Promise.race([request, stopWaiting]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', finishWaiting);
  }
}
