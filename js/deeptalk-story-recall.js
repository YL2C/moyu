import { db } from './db.js';
import { parseReply, optionsForReply } from './parse.js';
import { stripReasoning } from './reasoning.js';
import { extraBlocks } from './fanwai.js';
import { protagonistState, PROTAGONIST_FIELDS } from './protagonist.js';
import { getModules, getGlobalMemo } from './state.js';
import { getPacks } from './tavern.js';
import { applyCardState, latestCheckpoint, splitNames, worldEntries, worldEntryTriggers } from './prompt.js';

const SOFT_LIMIT = 600;
const EXCERPT_LIMIT = 800;
const CARD_LIMIT = 80;
const CARD_CHOICES = 'ABC';
const MAX_CANDIDATES = 9;
const MAX_EVIDENCE = 3;
const HISTORY_QUERY = /旧版|历史版本|其他分支|旧分支|原分支|不同版本|被替换|废案|改写前|第\s*\d+\s*版|版本\s*\d+/u;
const IDENTITY_QUERY = /(?:你知道|还记得|介绍一下).{2,30}(?:吗|么|[？?!！]|$)|是什么|是谁|叫什么/u;
const IDENTITY_SUBJECT = /(?:你知道|还记得|介绍一下)\s*([^，。！？?!,]+?)\s*(?:吗|么)?[。！？?!]*$|(?:^|[，。！？?!,])\s*([^，。！？?!,]+?)(?:是什么|是谁|叫什么)[。！？?!]*$/u;
const SOURCE_QUERIES = [
  ['extra', /番外|同人|IF线|恋综|恋爱脑报告/u],
  ['discussion', /讨论|提案|草案|附件/u],
  ['ooc', /出戏|场外/u],
  ['opening', /开场|开局/u],
  ['module', /规则|世界书|预设|模块/u],
  ['summary', /前情|档案里|信息差|未决事项|暗处动向/u],
  ['option', /选项|候选行动/u],
  ['danmu', /弹幕|评论/u],
  ['player', /玩家输入|导演指令|我(?:当时|那时)?说[了过]/u],
];
const archiveFields = [
  ['irreversible', '关键事实'], ['corrections', '勘误'], ['items', '物品与信物'], ['threads', '未决事项'],
  ['knowledge', '信息差'], ['offscreen', '暗处动向'], ['repeats', '写法记录'],
  ['conflicts', '待理清的冲突'], ['unsure', '待确认'],
];
const CHAPTER_NUMBER = /第\s*([0-9一二两三四五六七八九十百千]+)\s*章/gu;
const LOOKUP = /原文|原话|剧情|跑团|存档|设定|前情|哪一章|哪章|(?:当时|那次|以前|之前|后来|第一次).{0,24}(?:怎么|说了|说过|发生|知道|反应|答应|有没有|送了)|(?:翻|查|回忆).{0,12}(?:那段|旧章|那幕|那一段)/u;
const WORDING = /原文|原话|哪一章|哪章|怎么(?:说|写|反应)|(?:说|写)了什么|当时.{0,20}反应/u;
const SETTING = /人设|设定|背景|身份|性格|角色卡|世界观/u;
const FOLLOW_UP = /^(?:那(?:他|她|他们)?后来|那(?:他|她|他们)?当时|然后|那一段|这段|那章|他(?:当时|后来)|她(?:当时|后来))/u;
const MAX_STORY_TITLE = 60;
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const common = /(?:想知道|谁知道|第一次|还记得|是什么|发生了|有没有|怎么样|怎么|后来|当时|之前|反应|原文|原话|剧情|跑团|故事|设定|前情里|来说|说了|这一段|那一段|那段|一下|哪一章)/gu;
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
    const span = end - start;
    start += stops.findLast(at => at <= span - 90 && at >= 260) ?? Math.max(1, span - Math.min(90, Math.floor(span / 3)));
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

const validText = row => typeof row?.text === 'string' && row.text.trim() && (!row.status || row.status === 'done') &&
  !row.error && !row.flagged && !row.relayJob;

function indexStory(story, nodes, extras, discussions, shared) {
  const title = String(story.title || '未命名故事').trim();
  const path = pathOf(story, nodes);
  const current = new Set(path.map(node => node.id));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const chapterNumbers = new Map();
  const entries = [];
  function chapterOf(node) {
    const lineage = [];
    const seen = new Set();
    while (node && !chapterNumbers.has(node.id) && !seen.has(node.id)) {
      lineage.push(node);
      seen.add(node.id);
      node = byId.get(node.parentId);
    }
    let no = chapterNumbers.get(node?.id) || 0;
    for (const ancestor of lineage.reverse()) {
      if (ancestor.role === 'assistant' && ancestor.kind !== 'ooc' && ancestor.text?.trim()) no++;
      chapterNumbers.set(ancestor.id, no);
    }
    return no;
  }

  const add = (id, kind, label, body, options = {}) => {
    const passages = windows(body);
    if (!passages.length) return;
    const { chapter = 0, version = 0, person = '', name = '', triggers = [], historical = false } = options;
    entries.push({ id, kind, label,
      search: normalize([label, ...triggers].join(' ')), name: normalize(name),
      chapter, version, person, passages, historical, entity: id.startsWith('world/'),
      triggers: [...new Set(triggers.map(normalize).filter(term => term.length >= 2))] });
  };
  for (const node of nodes) {
    const historical = !current.has(node.id);
    const chapter = chapterOf(node);
    const branch = historical ? '旧分支 #' + String(node.id).slice(-8) + ' · ' : '';
    if (node.kind === 'ooc') {
      if (validText(node)) add('ooc/' + node.id, 'ooc', branch + '出戏 · ' + (node.role === 'user' ? '玩家' : '回复'),
        stripReasoning(node.text), { historical });
      continue;
    }
    if (node.role === 'user') {
      const label = branch + '第' + (chapter + 1) + '章 · ';
      add('player/' + node.id, 'player', label + '玩家发言', node.text, { historical, chapter: chapter + 1 });
      add('director/' + node.id, 'player', label + '导演指令', node.director, { historical, chapter: chapter + 1 });
      continue;
    }
    if (node.role !== 'assistant' || !validText(node)) continue;
    const parsed = parseReply(node.text);
    const label = branch + '第' + chapter + '章' + (parsed.title ? ' · ' + parsed.title : '');
    const source = { chapter, historical, name: parsed.title, triggers: parsed.title ? [parsed.title] : [] };
    add('chapter/' + node.id, 'chapter', label, parsed.body, source);
    add('option/' + node.id, 'option', label + ' · 候选选项', optionsForReply(node, parsed).join('\n'), { chapter, historical });
    add('danmu/' + node.id, 'danmu', label + ' · 弹幕', parsed.danmu.map(line =>
      [line.name, line.text].filter(Boolean).join('：')).join('\n'), { chapter, historical });
  }

  const checkpoint = latestCheckpoint(path);
  const addArchive = (node, currentArchive) => {
    const memory = node.checkpoint;
    const prefix = currentArchive ? '前情档案' : (current.has(node.id) ? '旧前情档案' : '旧分支前情档案') + ' · 第' + chapterOf(node) + '章';
    const archived = { historical: !currentArchive };
    for (const part of memory.summaries || []) add('summary/' + node.id + '/' + part.from + '-' + part.to,
      'summary', prefix + ' · 第' + part.from + '–' + part.to + '章', part.text, archived);
    add('summary/' + node.id + '/early', 'summary', prefix + ' · 早期概要', memory.early, archived);
    for (const [field, label] of archiveFields) {
      const values = memory[field];
      if (Array.isArray(values)) add('summary/' + node.id + '/' + field, field === 'corrections' ? 'correction' : 'summary',
        prefix + ' · ' + label, values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n'), archived);
    }
  };
  for (const node of nodes) if (node.checkpoint) addArchive(node, checkpoint?.node.id === node.id);

  add('world', 'setting', '世界设定', story.world);
  add('opening', 'opening', '故事开场', story.opening);
  add('rules', 'module', '故事规则', story.rules);
  for (const entry of worldEntries(story)) {
    if (entry.enabled !== false)
      add('world/' + entry.id, 'setting', '按需设定 · ' + entry.name, entry.text,
        { name: entry.name, triggers: worldEntryTriggers(entry) });
  }
  const packs = new Map([...shared.packs, ...(story.packs || [])].map(pack => [pack.id, pack]));
  for (const module of [...(story.localModules || []), ...shared.modules]) {
    if (!story.modules?.[module.id]) continue;
    const type = packs.get(module.pack)?.kind === 'worldbook' ? '世界书' : '规则模块';
    add('module/' + module.id, 'module', type + ' · ' + module.name, module.text,
      { name: module.name, triggers: worldEntryTriggers(module) });
  }
  add('globalMemo', 'module', '全局备忘', shared.memo);

  const protagonist = story.protagonist;
  const cards = [];
  const addCard = (id, label, card, fields) => {
    const details = fields.filter(([, value]) => typeof value === 'string' && value.trim());
    const names = splitNames(card);
    add(id, 'setting', label + ' · ' + (card.name || '未命名角色'),
      [names.length > 1 ? '别名：' + names.slice(1).join('、') : '', ...details.map(([field, value]) => field + '：' + value)].filter(Boolean).join('\n\n'),
      { person: normalize(card.name), name: card.name, triggers: names });
    if (card.name && details.length) cards.push({ name: card.name, names: names.map(normalize).filter(name => name.length >= 2), details });
  };
  if (protagonist) {
    const state = protagonistState(protagonist, path);
    addCard('protagonist', '主角卡', protagonist, [['性别', protagonist.gender], ['设定', protagonist.note],
      ...Object.entries(state).map(([field, entry]) => [PROTAGONIST_FIELDS[field], entry.value])]);
    for (const [i, entry] of (protagonist.stateEntries || []).entries()) {
      if (Object.values(state).includes(entry)) continue;
      add('protagonist/history/' + i, 'setting', '主角卡 · 历史状态 · ' + (PROTAGONIST_FIELDS[entry.field] || '状态'),
        entry.value, { historical: true });
    }
  }
  for (const [index, base] of (story.cards || []).entries()) {
    const card = applyCardState(base, checkpoint?.mem);
    addCard('card/' + (card.id || index), '角色卡', card, [
      ['身份', card.initial], ['关系档案', card.relation], ['性格', card.base], ['当前状态', card.now], ['经历', card.arc],
      ['原话', card.voice], ['禁止清单', card.forbid],
    ]);
  }

  for (const extra of extras) {
    const versions = extra.versions || [];
    for (const [number, version] of versions.entries()) {
      if (!validText(version)) continue;
      const { title: name } = extraBlocks(version.text);
      const historical = number !== (extra.cur ?? 0);
      const label = '番外 · ' + (name || extra.tplName || '未命名番外') + ' · 第' + (number + 1) + '版' +
        (historical ? '（旧版）' : '');
      add('extra/' + extra.id + '/' + (version.id || number), 'extra', label, stripReasoning(version.text),
        { name, triggers: [name, extra.tplName].filter(Boolean), historical, version: number + 1 });
    }
  }
  for (const discussion of discussions) {
    for (const [i, message] of (discussion.messages || []).entries()) {
      if (!['user', 'assistant'].includes(message.role) || message.streaming || message.error) continue;
      const label = '关联讨论 · ' + (discussion.title || '未命名讨论');
      add('disc/' + discussion.id + '/' + i, 'discussion', label, stripReasoning(message.content || ''),
        { name: discussion.title, triggers: [discussion.title].filter(Boolean) });
      for (const [a, attachment] of (message.attachments || []).entries()) {
        for (const [j, part] of (attachment.sections || []).entries()) {
          if (part.selected === false || attachment.include === false) continue;
          add('disc/' + discussion.id + '/' + i + '/' + a + '/' + j, 'discussion', label + ' · 附件 · ' + part.name, part.text,
            { name: part.name, triggers: [part.name, attachment.name].filter(Boolean) });
        }
      }
    }
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
  const identity = IDENTITY_QUERY.test(input);
  const [, asked, named] = identity ? input.match(IDENTITY_SUBJECT) || [] : [];
  const subject = normalize(asked || named);
  const source = SOURCE_QUERIES.find(([, rule]) => rule.test(input))?.[0] ??
    (/其他分支|旧分支|原分支|改写前/u.test(input) ? 'chapter' : undefined);
  const versionMatch = input.match(/第\s*([0-9一二两三四五六七八九十百千]+)\s*版|版本\s*(\d+)/u);
  const version = versionMatch ? chapterNumber(versionMatch[1] || versionMatch[2]) : 0;
  return { current, last, identity, subject: subject.length >= 3 && subject.length <= 44 ? subject : '',
    source, version, historical: !!version || HISTORY_QUERY.test(input),
    explicit: identity || !!chapters.length || !!source || HISTORY_QUERY.test(input) || LOOKUP.test(input),
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

function matchingSnippet(raw, words) {
  const span = 76;
  if (raw.length <= span) return raw;
  const wanted = new Set(words.filter(word => word.length >= 2));
  const sentenceStarts = [0, ...[...raw.matchAll(sentence)].map(match => match.index + match[0].length)];
  let best = '', relevance = -1;
  const lower = raw.normalize('NFKC').toLowerCase();
  for (const word of wanted) {
    const at = lower.indexOf(word);
    if (at > span / 2) sentenceStarts.push(at - Math.floor(span / 3));
  }
  for (const start of sentenceStarts) {
    const beginning = /[\uDC00-\uDFFF]/u.test(raw[start]) ? start + 1 : start;
    const excerpt = raw.slice(beginning, cutEnd(raw, start + span)).trim();
    if (!excerpt) continue;
    const normalized = normalize(excerpt);
    const score = [...wanted].reduce((result, term) => result + (normalized.includes(term) ? term.length : 0), 0);
    if (score > relevance) { best = excerpt; relevance = score; }
  }
  return best;
}

function matchStory(index, query, storyId, stamp) {
  const { current, last, explicit, wording, setting, chapters, score, identity, subject, source } = query;
  const titled = index.name.length >= 2 && current.includes(index.name);
  const previouslyTitled = !titled && index.name.length >= 2 && last.includes(index.name);
  const roles = index.names.filter(name => current.includes(name) || last.includes(name));
  const entities = index.entries.filter(entry => ['setting', 'module'].includes(entry.kind) && entry.name.length >= 2);
  const actualNames = new Set(entities.map(entry => entry.name));
  const includes = term => current.includes(term) || last.includes(term);
  const names = entities.filter(entry => includes(entry.name));
  const aliasMatches = entities.filter(entry => entry.triggers.some(term => !actualNames.has(term) && includes(term)));
  // A cross-reference to another named entry is useful evidence, but is not an alias.
  const aliases = [...new Set([...names, ...aliasMatches].flatMap(entry =>
    [entry.name, ...entry.triggers.filter(term => !actualNames.has(term))]))];
  const titleMatch = score(index.name).value;
  const rank = [];
  for (const entry of index.entries) {
    const { kind, search, chapter, version, person, triggers, name, historical, entity } = entry;
    const direct = name.length >= 2 && current.includes(name);
    const mentioned = triggers.filter(term => current.includes(term) || last.includes(term));
    const exactChapter = chapter > 0 && chapters.includes(chapter);
    const requestedType = kind === source;
    if (chapters.length && !exactChapter && !requestedType) continue;
    if (kind === 'extra' && query.version && version !== query.version) continue;
    const heading = score(search);
    const role = person && (current.includes(person) || last.includes(person));
    const titleEvidence = titleMatch >= 7 || heading.value >= 7;
    let best;
    for (const passage of entry.passages) {
      const hit = score(passage.search);
      const linked = aliases.some(term => passage.search.includes(term));
      const subjectMatch = subject && passage.search.includes(subject);
      const evidence = heading.value + hit.value;
      const requestedTerms = requestedType && (titled || previouslyTitled ||
        (query.historical && hit.terms.some(term => term.length >= 4)));
      if (!direct && !mentioned.length && !linked && !subjectMatch && !exactChapter && !requestedTerms &&
          evidence < (titled || previouslyTitled || roles.length || (requestedType && explicit) ? 4 : titleEvidence ? 9 : 14)) continue;
      const priority = (exactChapter ? 75 : 0) + (direct ? (requestedType || (!wording && (identity || setting)) ? 100 : wording ? 10 : 45) : 0) +
        (linked ? 18 : 0) + (subjectMatch ? 28 : 0) + (mentioned.length ? 17 : 0) + (role ? 9 : 0) +
        (requestedType ? 45 : 0) + (setting && kind === 'setting' ? 20 : 0) +
        (wording && !source && kind === 'chapter' ? 58 : 0) + (historical ? (query.historical ? 35 : -30) : 0) +
        (kind === 'correction' && !source && !wording ? 12 : 0) +
        (['option', 'danmu', 'discussion', 'ooc'].includes(kind) && !requestedType ? -14 : 0);
      const total = evidence + heading.value + priority;
      if (!best || total > best.total) best = { total, raw: passage.raw,
        terms: [...heading.terms, ...hit.terms], linked };
    }
    if (!best) continue;
    const label = entry.label.slice(0, 65);
    const clue = [...new Set(best.terms)].filter(term => term.length >= 4 && !normalize(label + index.title).includes(term)).slice(0, 3).join('、');
    rank.push({ key: 'story/' + JSON.stringify([storyId, entry.id]), storyId, stamp,
      title: index.title.slice(0, MAX_STORY_TITLE) + ' · ' + label,
      label: ('跑团／' + index.title.slice(0, 36) + '／' + label).replace(/[\r\n]/g, ' '),
      hint: clue, text: best.raw, snippetTerms: [...best.terms, ...aliases], kind, mentioned, direct, entity,
      historical, linked: best.linked,
      rank: best.total + (titled ? 30 : previouslyTitled ? 18 : 0) + Math.min(titleMatch, 15),
      score: explicit ? 35 : 16, story: true, topic: true });
  }
  rank.sort((a, b) => b.rank - a.rank);
  const pin = identity && !chapters.length && (!source || source === 'module') ?
    rank.find(row => row.direct && !row.historical && (row.entity || (!wording && ['setting', 'module'].includes(row.kind)))) : null;
  const currentKinds = new Set(rank.filter(row => !row.historical && row.rank >= 12).map(row => row.kind));
  const eligible = rank.filter(row => !row.historical || query.historical ||
    (!currentKinds.has(row.kind) && row.rank >= 18));
  if (query.historical) {
    const historicalPriority = row => row.historical && row.kind === (source || 'chapter') ? 1 : 0;
    eligible.sort((a, b) => historicalPriority(b) - historicalPriority(a) || b.rank - a.rank);
  }
  const first = pin || eligible[0];
  const diverse = new Map();
  for (const row of eligible) {
    if (row !== first && !diverse.has(row.kind)) diverse.set(row.kind, row);
  }
  const candidates = first ? [...new Set([first, ...diverse.values(), ...eligible])].slice(0, MAX_CANDIDATES) : [];
  return { storyId, title: index.title, titled, previouslyTitled, roles, candidates, pin, cards: index.cards };
}

export async function findChatStoryReferences({ text, recent, settings, signal }) {
  const query = makeQuery(text, recent);
  if (query.current.length < 2) return { rows: [] };
  const selected = settings.storyRecallScope === 'selected' ? new Set(settings.storyRecallIds || []) : null;
  if (selected && !selected.size) return { rows: [] };
  const [catalog, modules, packs, memo, discussionList] = await Promise.all([
    db.storyLookupCatalog(), getModules(), getPacks(), getGlobalMemo(), db.kvGet('disc.index', []),
  ]);
  const shared = { modules, packs, memo };
  const sharedStamp = JSON.stringify([modules.map(({ id, name, pack, keywords, text }) => [id, name, pack, keywords, text]),
    packs.map(({ id, kind }) => [id, kind]), memo]);
  const discussions = new Map();
  for (const item of Array.isArray(discussionList) ? discussionList : []) {
    if (!item.storyId || (selected && !selected.has(item.storyId))) continue;
    if (!discussions.has(item.storyId)) discussions.set(item.storyId, []);
    discussions.get(item.storyId).push(item);
  }
  const live = new Set(catalog.map(({ story }) => story.id));
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  const matches = [];
  for (const { story, stamp } of catalog) {
    if (signal?.aborted) return { rows: [] };
    if (selected && !selected.has(story.id)) continue;
    const metadata = discussions.get(story.id) || [];
    const discussionStamp = JSON.stringify(metadata);
    let saved = cache.get(story.id);
    if (saved?.stamp !== stamp || saved.sharedStamp !== sharedStamp || saved.discussionStamp !== discussionStamp) {
      const [nodes, extras, linked] = await Promise.all([db.byStory(story.id), db.extrasOf(story.id),
        Promise.all(metadata.map(item => db.kvGet('disc.' + item.id, null)))]);
      saved = { stamp, sharedStamp, discussionStamp, index: indexStory(story, nodes, extras,
        linked.filter(item => item?.storyId === story.id), shared) };
      cache.set(story.id, saved);
    }
    const match = matchStory(saved.index, query, story.id, stamp);
    if (match.candidates.length || match.titled || match.previouslyTitled) matches.push(match);
  }

  const named = matches.filter(match => match.titled);
  const previous = matches.filter(match => match.previouslyTitled);
  const scoped = (named.length ? named : previous.length ? previous : matches).filter(match => match.candidates.length);
  const attach = (row, match) => {
    const { snippetTerms, ...candidate } = row;
    return { ...candidate, snippet: matchingSnippet(row.text, snippetTerms),
      cards: row.kind === 'setting' ? [] : cardChoices(match.cards, query, row.text), pinned: row === match.pin };
  };
  if (named.length > 1 && /比较|对比|分别|有啥区别|有什么区别/u.test(text)) {
    const balanced = scoped.slice(0, 3).flatMap(match => match.candidates.slice(0, 3).map(row => attach(row, match)));
    return { rows: balanced };
  }
  scoped.sort((a, b) => (b.pin?.rank ?? b.candidates[0].rank) - (a.pin?.rank ?? a.candidates[0].rank));
  const best = scoped[0];
  if (!best) return { rows: [] };
  const head = best.candidates[0];
  const ambiguous = scoped.slice(1).filter(match => {
    const other = match.candidates[0];
    const sameEntity = head.mentioned.some(term => other.mentioned.includes(term));
    if (head.kind === 'module' && other.kind === 'module' && head.text === other.text) return false;
    return (best.pin && match.pin && sameEntity) || (head.rank - other.rank < 9 &&
      (query.explicit || best.roles.some(name => match.roles.includes(name)) || sameEntity));
  });
  if (ambiguous.length) {
    const titles = [...new Set([best, ...ambiguous].map(match => match.title.slice(0, MAX_STORY_TITLE)))].slice(0, 4);
    return { rows: [], ...(query.explicit ? { clarify: titles } : { ambiguous: true }) };
  }
  return { rows: best.candidates.map(row => attach(row, best)) };
}

const evidenceSize = part => JSON.stringify({ 出处: part.title, 原文: part.text,
  ...(part.cards.length ? { 角色梗概: part.cards } : {}) }).length;
const serializedTextLength = text => JSON.stringify(text).length - 2;

function cropEvidence(text, limit, query, snippet) {
  if (serializedTextLength(text) <= limit) return text;
  const preview = normalize(snippet);
  const score = text => {
    const normalized = normalize(text);
    return query.score(normalized).value + (preview && normalized.includes(preview) ? 12 : 0);
  };
  return windows(text, limit).map(({ raw }) => {
    let end = raw.length;
    while (serializedTextLength(raw.slice(0, end)) > limit) end--;
    return raw.slice(0, cutEnd(raw, end)).trimEnd();
  }).sort((a, b) => score(b) - score(a))[0] || '';
}

export async function chatStoryReferences(rows, choices, text, recent, { keepPinned = true } = {}) {
  const keyChoices = new Map(choices.map(choice => [choice.key, choice.cards]));
  const picked = rows.filter(row => keyChoices.has(row.key) || (keepPinned && row.pinned))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const revisions = new Map(await Promise.all([...new Set(picked.map(row => row.storyId))]
    .map(async id => [id, await db.storyLookupStamp(id)])));
  const selected = picked.filter(row => revisions.get(row.storyId) === row.stamp);
  const query = makeQuery(text, recent);
  const usedCards = new Set();
  const relevant = [];
  for (const row of selected) {
    const plain = normalize(row.text);
    if (!plain || relevant.some(previous => {
      const earlier = normalize(previous.text);
      const shorter = Math.min(plain.length, earlier.length);
      const longer = Math.max(plain.length, earlier.length);
      return earlier === plain || (shorter >= 30 && shorter >= longer * 0.75 &&
        (earlier.includes(plain) || plain.includes(earlier)));
    })) continue;
    relevant.push(row);
    if (relevant.length === MAX_EVIDENCE) break;
  }
  let remaining = EXCERPT_LIMIT;
  const results = [];
  for (const [i, row] of relevant.entries()) {
    const selectedCards = keyChoices.get(row.key) || [];
    const cards = row.cards.filter(card => selectedCards.includes(card.id) && !usedCards.has(row.storyId + '/' + card.name))
      .slice(0, 2 - usedCards.size).map(({ name, text }) => ({ 角色: name, 梗概: text }));
    const part = { ...row, cards, text: '' };
    const reserve = relevant.slice(i + 1).reduce((sum, next) => sum + Math.min(230, evidenceSize({ ...next, cards: [] }) + 35), 0);
    const limit = remaining - reserve - evidenceSize(part);
    if (limit <= 0) continue;
    part.text = cropEvidence(row.text, limit, query, row.snippet);
    if (!part.text) continue;
    remaining -= evidenceSize(part);
    for (const card of cards) usedCards.add(row.storyId + '/' + card.角色);
    results.push(part);
  }
  return results;
}
