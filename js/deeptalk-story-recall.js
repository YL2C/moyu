import { db } from './db.js';
import { parseReply } from './parse.js';
import { applyCardState, latestCheckpoint, splitNames, worldEntries, worldEntryTriggers } from './prompt.js';

const SOFT_LIMIT = 600;
const EXCERPT_LIMIT = 800;
const CARD_LIMIT = 80;
const CARD_CHOICES = 'ABC';
const MAX_CANDIDATES = 3;
const CHAPTER_NUMBER = /第\s*([0-9一二两三四五六七八九十百千]+)\s*章/gu;
const LOOKUP = /原文|原话|剧情|跑团|存档|设定|前情|哪一章|哪章|(?:当时|那次|以前|之前|后来|第一次).{0,24}(?:怎么|说了|说过|发生|知道|反应|答应|有没有|送了)|(?:翻|查|回忆).{0,12}(?:那段|旧章|那幕|那一段)/u;
const WORDING = /原文|原话|哪一章|哪章|怎么(?:说|写|反应)|(?:说|写)了什么|当时.{0,20}反应/u;
const SETTING = /人设|设定|背景|身份|性格|角色卡|世界观/u;
const FOLLOW_UP = /^(?:那(?:他|她|他们)?后来|那(?:他|她|他们)?当时|然后|那一段|这段|那章|他(?:当时|后来)|她(?:当时|后来))/u;
const MAX_STORY_TITLE = 60;
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const common = /(?:想知道|第一次|还记得|是什么|发生了|有没有|怎么样|怎么|后来|当时|之前|反应|原文|原话|剧情|跑团|故事|设定|来说|说了|这一段|那一段|那段|一下|哪一章)/gu;
const sentence = /[。！？…!?；;]+[」』”’）)】]?|\n+/gu;
const cutEnd = (text, end) => /[\uD800-\uDBFF]/u.test(text[end - 1] || '') ? end - 1 : end;
const cache = new Map();

function windows(text, limit = EXCERPT_LIMIT) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const parts = [];
  for (let start = 0; start < text.length;) {
    if (text.length - start <= Math.min(SOFT_LIMIT, limit)) {
      parts.push(text.slice(start).trim());
      break;
    }
    const slice = text.slice(start, start + limit);
    const stops = [...slice.matchAll(sentence)].map(match => match.index + match[0].length);
    const before = stops.findLast(end => end <= SOFT_LIMIT && end >= SOFT_LIMIT / 2);
    const after = stops.find(end => end > SOFT_LIMIT);
    const end = cutEnd(text, start + (before ?? after ?? Math.min(SOFT_LIMIT, limit)));
    parts.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    // Keep enough overlap to catch an exchange crossing the boundary.
    start += stops.findLast(at => at <= end - start - 90 && at >= 260) ?? Math.max(250, end - start - 90);
    if (/[\uDC00-\uDFFF]/u.test(text[start])) start++;
  }
  return parts.filter(Boolean).map(raw => ({ raw, search: normalize(raw) }));
}

function pathOf(story, nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const seen = new Set();
  const path = [];
  for (let id = story.headId; byId.has(id) && !seen.has(id);) {
    const node = byId.get(id);
    seen.add(id);
    path.push(node);
    id = node.parentId;
  }
  return path.reverse();
}

function indexStory(story, nodes) {
  const title = String(story.title || '未命名故事').trim();
  const path = pathOf(story, nodes);
  const entries = [];
  const add = (id, kind, label, body, chapter = 0, person = '', searchLabel = label) => {
    const passages = windows(body);
    if (passages.length) entries.push({ id, kind, label, search: normalize(searchLabel), chapter, person, passages });
  };

  let chapter = 0;
  for (const node of path) {
    if (node.role !== 'assistant' || node.kind === 'ooc' || !node.text?.trim()) continue;
    chapter++;
    if ((node.status && node.status !== 'done') || node.error || node.flagged || node.relayJob) continue;
    const { title: name, body } = parseReply(node.text);
    add('chapter/' + node.id, 'chapter', '第' + chapter + '章' + (name ? ' · ' + name : ''), body, chapter);
  }

  const memory = latestCheckpoint(path)?.mem;
  for (const part of memory?.summaries || [])
    add('summary/' + part.from + '-' + part.to, 'summary', '前情档案 · 第' + part.from + '–' + part.to + '章', part.text);
  add('summary/early', 'summary', '前情档案 · 早期概要', memory?.early);
  add('summary/facts', 'summary', '前情档案 · 关键事实', (memory?.irreversible || []).join('\n'));
  add('summary/corrections', 'correction', '前情档案 · 勘误', (memory?.corrections || []).join('\n'));
  add('summary/items', 'summary', '前情档案 · 物品与信物', (memory?.items || []).join('\n'));
  add('summary/threads', 'summary', '前情档案 · 未决事项', (memory?.threads || []).join('\n'));

  add('world', 'setting', '世界设定', story.world);
  for (const entry of worldEntries(story).filter(entry => entry.enabled !== false)) {
    add('world/' + entry.id, 'setting', '按需设定 · ' + entry.name, entry.text, 0, '', worldEntryTriggers(entry).join(' '));
  }
  const protagonist = story.protagonist;
  const cards = [];
  const addCard = (id, label, card, fields) => {
    const details = fields.filter(([, value]) => typeof value === 'string' && value.trim());
    add(id, 'setting', label + ' · ' + (card.name || '未命名角色'),
      details.map(([, value]) => value).join('\n\n'), 0, normalize(card.name));
    if (card.name && details.length)
      cards.push({ name: card.name, names: splitNames(card).map(normalize).filter(name => name.length >= 2), details });
  };
  if (protagonist) addCard('protagonist', '主角卡', protagonist, [['设定', protagonist.note]]);
  for (const [index, base] of (story.cards || []).entries()) {
    const card = applyCardState(base, memory);
    addCard('card/' + (card.id || index), '角色卡', card, [
      ['身份', card.initial], ['关系档案', card.relation], ['性格', card.base], ['当前状态', card.now], ['经历', card.arc],
    ]);
  }
  const names = [protagonist?.name, ...(story.cards || []).flatMap(splitNames)].map(normalize);
  return { title, name: normalize(title), names: [...new Set(names.filter(name => name.length >= 2))], entries, cards };
}

function chapterNumber(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits = '一二三四五六七八九';
  const units = { 十: 10, 百: 100, 千: 1000 };
  let total = 0, digit = 0;
  for (const char of value) {
    if (units[char]) { total += (digit || 1) * units[char]; digit = 0; }
    else digit = char === '两' ? 2 : digits.indexOf(char) + 1;
  }
  return total + digit;
}

function queryPattern(text, limit) {
  const clean = text.replace(CHAPTER_NUMBER, ' ').replace(common, ' ');
  const words = new Set();
  for (const part of clean.split(/[^\p{L}\p{N}]+/u).map(normalize)) {
    for (const size of [4, 2]) {
      for (let i = 0; i <= part.length - size; i++) words.add(part.slice(i, i + size));
    }
  }
  const terms = [...words].sort((a, b) => b.length - a.length).slice(0, limit);
  return terms.length ? new RegExp(terms.join('|'), 'gu') : null;
}

function makeQuery(text, recent) {
  const input = text.normalize('NFKC');
  const current = normalize(input);
  const followUp = FOLLOW_UP.test(input);
  const last = followUp ? normalize(recent) : '';
  const chapters = [...input.matchAll(CHAPTER_NUMBER)].map(match => chapterNumber(match[1]));
  const pattern = queryPattern(input.slice(0, 360), 150);
  const previousPattern = followUp && recent ? queryPattern(recent.slice(0, 105), 40) : null;
  const score = value => {
    const terms = new Set(pattern ? value.match(pattern) || [] : []);
    let weight = 0;
    for (const term of terms) weight += term.length >= 4 ? 7 : 2;
    for (const term of new Set(previousPattern ? value.match(previousPattern) || [] : [])) {
      if (terms.has(term)) continue;
      terms.add(term);
      weight += term.length >= 4 ? 3 : 1;
    }
    return { value: weight, terms: [...terms] };
  };
  return { current, last, explicit: !!chapters.length || LOOKUP.test(input),
    wording: !!chapters.length || WORDING.test(input), setting: SETTING.test(input), chapters, score };
}

function trimCardDetail(text, limit) {
  const raw = text.trim();
  if (raw.length <= limit) return raw;
  const within = raw.slice(0, limit);
  const ends = [...within.matchAll(sentence)];
  const last = ends.at(-1);
  const end = last ? last.index + last[0].length : 0;
  if (end >= limit / 2) return raw.slice(0, end).trim();
  return raw.slice(0, cutEnd(raw, limit - 1)).trimEnd() + '…';
}

function cardChoices(cards, query, passage) {
  const local = normalize(passage);
  const ranked = [];
  for (const card of cards) {
    const asked = card.names.some(name => query.current.includes(name));
    const present = card.names.some(name => local.includes(name));
    if (!asked && !present) continue;
    const values = card.details.map(([label, value], index) => ({
      value: label + '：' + value.trim(), score: query.score(normalize(value).slice(0, 1200)).value + (index ? 0 : 3),
    })).sort((a, b) => b.score - a.score);
    // Prefer a short paired identity and relationship when their sources fit.
    const first = trimCardDetail(values[0].value, values.length > 1 ? 50 : CARD_LIMIT);
    const remaining = CARD_LIMIT - first.length - 1;
    const second = values[1] && remaining >= 14 ? trimCardDetail(values[1].value, remaining) : '';
    ranked.push({ name: card.name.replace(/[\r\n]/g, ' ').trim().slice(0, 16),
      text: [first, second].filter(Boolean).join('\n'), score: (asked ? 30 : 0) + (present ? 15 : 0) + values[0].score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, CARD_CHOICES.length).map(({ name, text }, at) => ({ name, text, id: CARD_CHOICES[at] }));
}

function matchStory(index, query, storyId, stamp) {
  const { current, last, explicit, wording, setting, chapters, score } = query;
  const titled = index.name.length >= 2 && current.includes(index.name);
  const previouslyTitled = !titled && index.name.length >= 2 && last.includes(index.name);
  const roles = index.names.filter(name => current.includes(name) || last.includes(name));
  const titleMatch = score(index.name).value;
  const rank = [];
  for (const entry of index.entries) {
    const { kind, search, chapter, person } = entry;
    const exactChapter = chapter > 0 && chapters.includes(chapter);
    if (chapters.length && !exactChapter) continue;
    if (wording && kind !== 'chapter' && !setting) continue;
    const heading = score(search);
    const role = person && current.includes(person);
    const titleEvidence = titleMatch >= 7 || heading.value >= 7;
    const anchored = titled || previouslyTitled || roles.length || exactChapter;
    if (!anchored && !explicit && !titleEvidence) continue;
    let best;
    for (const passage of entry.passages) {
      const hit = score(passage.search);
      const evidence = heading.value + hit.value;
      if (!titled && !previouslyTitled && !exactChapter && evidence < (roles.length ? 4 : titleEvidence ? 9 : 16)) continue;
      if (!exactChapter && !role && kind !== 'setting' && !evidence) continue;
      if (!exactChapter && !roles.length && !titleEvidence && !titled && !previouslyTitled &&
          !hit.terms.some(term => term.length >= 4)) continue;
      const priority = (exactChapter ? 65 : 0) + (titled ? 30 : previouslyTitled ? 18 : 0) + Math.min(titleMatch, 15) +
        (role ? 9 : 0) + (setting && kind === 'setting' ? 15 : 0) + (wording && kind === 'chapter' ? 12 : 0) +
        (kind === 'correction' ? 12 : kind === 'summary' && !wording ? 4 : 0);
      const total = evidence + heading.value + priority;
      if (!best || total > best.total) best = { total, text: passage.raw, terms: [...heading.terms, ...hit.terms] };
    }
    if (!best) continue;
    const label = entry.label.slice(0, 45);
    const clue = [...new Set(best.terms)].filter(term => term.length >= 4 && !normalize(label + index.title).includes(term)).slice(0, 3).join('、');
    rank.push({ key: 'story/' + JSON.stringify([storyId, entry.id]), storyId, stamp, title: index.title.slice(0, MAX_STORY_TITLE) + ' · ' + label,
      label: ('跑团／' + index.title.slice(0, 36) + '／' + label).replace(/[\r\n]/g, ' '),
      hint: clue, text: best.text, kind, rank: best.total, score: explicit ? 35 : 16, story: true, topic: true });
  }
  rank.sort((a, b) => b.rank - a.rank);
  return { storyId, title: index.title, titled, previouslyTitled, roles, candidates: rank.slice(0, MAX_CANDIDATES), cards: index.cards };
}

export async function findChatStoryReferences({ text, recent, settings, signal }) {
  const query = makeQuery(text, recent);
  if (query.current.length < 2) return { rows: [] };
  const selected = settings.storyRecallScope === 'selected' ? new Set(settings.storyRecallIds || []) : null;
  if (selected && !selected.size) return { rows: [] };
  const catalog = await db.storyLookupCatalog();
  const live = new Set(catalog.map(({ story }) => story.id));
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  const matches = [];
  for (const { story, stamp } of catalog) {
    if (signal?.aborted) return { rows: [] };
    if (selected && !selected.has(story.id)) continue;
    let saved = cache.get(story.id);
    if (saved?.stamp !== stamp) {
      const nodes = story.headId ? await db.byStory(story.id) : [];
      saved = { stamp, index: indexStory(story, nodes) };
      cache.set(story.id, saved);
    }
    const match = matchStory(saved.index, query, story.id, stamp);
    if (match.candidates.length || match.titled || match.previouslyTitled) matches.push(match);
  }
  const named = matches.filter(match => match.titled);
  const previous = matches.filter(match => match.previouslyTitled);
  const scoped = (named.length ? named : previous.length ? previous : matches).filter(match => match.candidates.length);
  scoped.sort((a, b) => b.candidates[0].rank - a.candidates[0].rank);
  const best = scoped[0];
  if (!best) return { rows: [] };
  const ambiguous = scoped.slice(1).filter(match => best.candidates[0].rank - match.candidates[0].rank < 9 &&
    (query.explicit || best.roles.some(name => match.roles.includes(name))));
  if (ambiguous.length) {
    const titles = [...new Set([best, ...ambiguous].map(match => match.title.slice(0, MAX_STORY_TITLE)))].slice(0, 3);
    return { rows: [], ...(query.explicit ? { clarify: titles } : {}) };
  }
  return { rows: best.candidates.map(row => ({
    ...row, cards: row.kind === 'setting' ? [] : cardChoices(best.cards, query, row.text),
  })) };
}

export async function chatStoryReference(rows, choice, text, recent) {
  const found = rows.find(row => row.key === choice.key);
  if (!found || await db.storyLookupStamp(found.storyId) !== found.stamp) return null;
  const cards = found.cards.filter(card => choice.cards.includes(card.id)).slice(0, 2)
    .map(({ name, text }) => ({ 角色: name, 梗概: text }));
  if (!cards.length) return { ...found, cards: [] };

  // Reserve the new JSON field, including JSON escaping and its labels, from the shared budget.
  const cardLength = JSON.stringify({ 角色梗概: cards }).length;
  const limit = EXCERPT_LIMIT - cardLength;
  if (JSON.stringify(found.text).length - 2 <= limit) return { ...found, cards };
  const query = makeQuery(text, recent);
  // Escaped newlines and quotation marks still count toward the input budget.
  const parts = windows(found.text, limit).map(({ raw }) => {
    let end = raw.length;
    while (JSON.stringify(raw.slice(0, end)).length - 2 > limit) end--;
    return raw.slice(0, cutEnd(raw, end)).trimEnd();
  }).sort((a, b) => query.score(normalize(b)).value - query.score(normalize(a)).value);
  return { ...found, text: parts[0], cards };
}
