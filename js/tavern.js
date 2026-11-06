// 墨游 · 导入酒馆（SillyTavern）的东西：预设、世界书、角色卡（JSON / PNG / ZIP）
// 导进来的都记成一个“包”，可以整包删除：
// - 全局：预设、世界书 → 规则模块库（带 pack 标记）；角色卡 → 新建一个故事
// - 某个故事里：预设、世界书 → 这个故事自己的模块（story.localModules）；角色卡 → 加进这个故事的角色卡

import { db } from './db.js';
import { uid } from './util.js';
import { getModules, saveModules, getDefaultRules } from './state.js';

// ───────────── 读文件 ─────────────

const td = (enc = 'utf-8', fatal = false) => new TextDecoder(enc, { fatal });

function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return td().decode(bytes);
  try { return td('utf-8', true).decode(bytes); } catch {}
  try { return td('gbk').decode(bytes); } catch {}
  return td().decode(bytes);
}

async function inflateRaw(u8) {
  if (typeof DecompressionStream === 'undefined') throw new Error('这个浏览器不支持直接解压 ZIP，请先解压，再单独导入里面的文件');
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 最小的 ZIP 读取：只认“不压缩”和“deflate”两种（绝大多数 ZIP 都是这两种） */
export async function unzip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let k = 0; k < count && off + 46 <= u8.length; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const flags = dv.getUint16(off + 8, true);
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = decodeName(u8.subarray(off + 46, off + 46 + nameLen), flags & 0x800);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || /(^|\/)(__MACOSX|\.DS_Store)/.test(name)) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = u8.subarray(start, start + csize);
    if (flags & 1) { out.push({ name, error: '加了密码' }); continue; }
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) out.push({ name, data: await inflateRaw(raw) });
    else out.push({ name, error: '压缩方式不支持' });
  }
  return out;
}

/** PNG 里的文字块（酒馆角色卡把 JSON 用 base64 存在 chara / ccv3 里） */
function pngText(u8) {
  if (u8.length < 8 || u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = {};
  let off = 8;
  while (off + 12 <= u8.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    if (type === 'tEXt') {
      const d = u8.subarray(off + 8, off + 8 + len);
      const z = d.indexOf(0);
      if (z > 0) out[td('latin1').decode(d.subarray(0, z))] = td('latin1').decode(d.subarray(z + 1));
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return out;
}

function b64utf8(s) {
  const bin = atob(String(s).trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return td().decode(bytes);
}

/** 读一个文件，返回 [{ file, json }]（ZIP 会展开成多个）和跳过的 [{ file, why }] */
export async function readTavernFile(file) {
  const items = [];
  const skipped = [];
  const buf = new Uint8Array(await file.arrayBuffer());
  const handle = async (name, data) => {
    const lower = name.toLowerCase();
    if (lower.endsWith('.zip')) {
      for (const e of await unzip(data)) {
        if (e.error) { skipped.push({ file: e.name, why: e.error }); continue; }
        await handle(e.name, e.data);
      }
      return;
    }
    if (lower.endsWith('.png')) {
      const t = pngText(data);
      const raw = t && (t.ccv3 || t.chara);
      if (!raw) { skipped.push({ file: name, why: '图片里没有角色卡数据' }); return; }
      try { items.push({ file: name, json: JSON.parse(b64utf8(raw)) }); } catch { skipped.push({ file: name, why: '角色卡数据读不出来' }); }
      return;
    }
    if (lower.endsWith('.json') || !/\.\w+$/.test(lower)) {
      try { items.push({ file: name, json: JSON.parse(td().decode(data).replace(/^﻿/, '')) }); }
      catch { skipped.push({ file: name, why: '不是有效的 JSON' }); }
      return;
    }
    skipped.push({ file: name, why: /\.(jpe?g|gif|webp|bmp|svg)$/.test(lower) ? '图片' : /\.css$/.test(lower) ? '样式表（美化暂不支持）' : '用不上的文件' });
  };
  await handle(file.name, buf);
  return { items, skipped };
}

// ───────────── 认是什么东西 ─────────────

/** 返回 preset / worldbook / card / regex / theme / instruct / unknown */
export function detectKind(j) {
  if (!j || typeof j !== 'object') return 'unknown';
  if (Array.isArray(j)) return j.length && j.every((x) => x && x.findRegex != null) ? 'regex' : 'unknown';
  if (j.spec === 'chara_card_v2' || j.spec === 'chara_card_v3' || (j.data && j.data.name && (j.data.description != null || j.data.first_mes != null))) return 'card';
  if (Array.isArray(j.prompts)) return 'preset';
  if (j.entries && typeof j.entries === 'object') return 'worldbook';
  if (j.name && (j.first_mes != null || j.char_persona != null || j.personality != null) && j.description != null) return 'card';
  if (j.findRegex != null || Array.isArray(j.regex_scripts)) return 'regex';
  if (j.main_text_color || j.custom_css != null || j.blur_strength != null) return 'theme';
  if (j.input_sequence != null || j.story_string != null || j.system_sequence != null) return 'instruct';
  return 'unknown';
}

export const KIND_LABEL = { preset: '预设', worldbook: '世界书', card: '角色卡', regex: '正则', theme: '主题美化', instruct: '文本补全模板', unknown: '认不出的文件' };

// ───────────── 转成墨游的东西 ─────────────

/** 酒馆的宏：{{user}} {{char}} 换成墨游的说法；注释、trim、变量操作去掉 */
export function cleanMacros(text, { char = '角色', user = '主角' } = {}) {
  return String(text || '')
    .replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
    .replace(/\{\{(?:trim|noop)\}\}/gi, '')
    .replace(/\{\{newline\}\}/gi, '\n')
    .replace(/\{\{(?:setvar|addvar|incvar|decvar|setglobalvar|addglobalvar)::[^}]*\}\}/gi, '')
    .replace(/\{\{user\}\}|<user>/gi, user)
    .replace(/\{\{char\}\}|<bot>/gi, char)
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const shortName = (s, n = 40) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const nameOf = (file) => String(file || '').split('/').pop().replace(/\.(json|png)$/i, '');

/** 预设：每条提示词一个模块；按预设里的顺序；记下预设里原本开没开 */
export function presetToModules(j, pack) {
  const prompts = Array.isArray(j.prompts) ? j.prompts : [];
  const orders = Array.isArray(j.prompt_order) ? j.prompt_order : [];
  const ord = (orders.find((o) => String(o.character_id) === '100001') || orders.find((o) => Array.isArray(o.order) && o.order.length) || {}).order || [];
  const byId = new Map(prompts.map((p) => [p.identifier, p]));
  const seq = [];
  const seen = new Set();
  for (const o of ord) {
    const p = byId.get(o.identifier);
    if (p && !seen.has(p.identifier)) { seen.add(p.identifier); seq.push({ p, on: o.enabled !== false }); }
  }
  for (const p of prompts) if (!seen.has(p.identifier)) seq.push({ p, on: ord.length ? false : p.enabled !== false });
  const mods = [];
  for (const { p, on } of seq) {
    if (p.marker) continue; // 聊天记录、世界书位置这类占位
    const text = cleanMacros(p.content);
    if (!text) continue;
    mods.push({
      id: uid(), name: shortName(p.name || p.identifier || '预设条目'), text, mode: 'always', keywords: '',
      note: `来自酒馆预设「${pack.name}」${p.role && p.role !== 'system' ? `（原本是 ${p.role} 消息）` : ''}`,
      pack: pack.id, defaultOn: on,
    });
  }
  return mods;
}

/** 世界书：每个条目一个模块；常驻的“一直发送”，有关键词的“出现关键词时发送” */
export function worldbookToModules(wb, pack, ctx) {
  const raw = Array.isArray(wb.entries) ? wb.entries : Object.values(wb.entries || {});
  const entries = raw.filter(Boolean).sort((a, b) => (a.order ?? a.insertion_order ?? 0) - (b.order ?? b.insertion_order ?? 0));
  const mods = [];
  let regexKeys = 0;
  entries.forEach((e, i) => {
    const text = cleanMacros(e.content, ctx);
    if (!text) return;
    const keys = [...(e.key || e.keys || [])].map(String).map((k) => k.trim()).filter(Boolean);
    const literal = keys.filter((k) => !/^\/.+\/[a-z]*$/.test(k));
    regexKeys += keys.length - literal.length;
    const constant = !!e.constant;
    mods.push({
      id: uid(), name: shortName(e.comment || e.name || literal[0] || `条目 ${i + 1}`),
      text, mode: constant || !literal.length ? 'always' : 'keyword', keywords: literal.join('、'),
      note: `来自世界书「${pack.name}」${keys.length > literal.length ? '（有正则写法的关键词没导入）' : ''}`,
      pack: pack.id, defaultOn: !(e.disable === true || e.enabled === false),
    });
  });
  return { mods, regexKeys };
}

/** 角色卡（v1 / v2 / v3）统一成一个对象 */
export function readChara(j) {
  const d = j.spec || (j.data && j.data.name) ? (j.data || {}) : j;
  return {
    name: String(d.name || '').trim() || '未命名角色',
    description: d.description || d.char_persona || '', personality: d.personality || '', scenario: d.scenario || '',
    first_mes: d.first_mes || d.char_greeting || '', mes_example: d.mes_example || d.example_dialogue || '',
    system_prompt: d.system_prompt || '', post: d.post_history_instructions || '',
    book: d.character_book && (d.character_book.entries || []).length ? d.character_book : null,
  };
}

function charaToCard(c) {
  const ctx = { char: c.name };
  const voice = cleanMacros(c.mes_example, ctx).replace(/<START>/gi, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12).join('\n');
  return {
    id: uid(), name: c.name, aliases: '', core: true,
    initial: cleanMacros(c.description, ctx), base: cleanMacros(c.personality, ctx), voice, forbid: '',
    arc: '', now: '', relation: '',
  };
}

// ───────────── 导入：全局 ─────────────

export async function getPacks() { return (await db.kvGet('packs', null)) || []; }
async function savePacks(list) { return db.kvSet('packs', list); }

/**
 * 导入到全局。返回 { lines:[说明], newStories:[故事] }
 */
export async function importGlobal(items) {
  const lines = [];
  const newStories = [];
  const modules = await getModules();
  const packs = await getPacks();
  for (const { file, json } of items) {
    const kind = detectKind(json);
    const label = nameOf(file);
    if (kind === 'preset' || kind === 'worldbook') {
      const pack = { id: uid(), name: json.name || label, kind, file, importedAt: Date.now() };
      const mods = kind === 'preset' ? presetToModules(json, pack) : worldbookToModules(json, pack).mods;
      if (!mods.length) { lines.push(`${KIND_LABEL[kind]}「${pack.name}」：没有可用的内容`); continue; }
      pack.count = mods.length;
      pack.chars = mods.reduce((a, m) => a + m.text.length, 0);
      modules.push(...mods);
      packs.push(pack);
      lines.push(`${KIND_LABEL[kind]}「${pack.name}」：${mods.length} 条 → 规则模块（原本开着的 ${mods.filter((m) => m.defaultOn).length} 条）`);
    } else if (kind === 'card') {
      const c = readChara(json);
      const story = await storyFromChara(c, file);
      await db.put('stories', story);
      newStories.push(story);
      lines.push(`角色卡「${c.name}」：建了新故事${story.localModules?.length ? `（带世界书 ${story.localModules.length} 条）` : ''}`);
    } else {
      lines.push(`${label}：${KIND_LABEL[kind]}，${kind === 'regex' || kind === 'theme' ? '美化和正则暂不支持' : kind === 'instruct' ? '墨游用不上' : '认不出来'}`);
    }
  }
  await saveModules(modules);
  await savePacks(packs);
  return { lines, newStories };
}

async function storyFromChara(c, file) {
  const ctx = { char: c.name };
  const card = charaToCard(c);
  const story = {
    id: uid(), title: c.name, rules: await getDefaultRules(),
    world: [cleanMacros(c.scenario, ctx) ? '【情境】\n' + cleanMacros(c.scenario, ctx) : '', `【${c.name}】\n` + cleanMacros(c.description, ctx)].filter(Boolean).join('\n\n'),
    opening: cleanMacros(c.first_mes, ctx),
    cards: [card], modules: {}, manualOn: {}, localModules: [], packs: [],
    danmu: true, options: true, connectionId: null, headId: null,
    createdAt: Date.now(), updatedAt: Date.now(), schema: 1,
  };
  const extra = [cleanMacros(c.system_prompt, ctx), cleanMacros(c.post, ctx)].filter(Boolean);
  if (extra.length) story.rules = story.rules.trim() + '\n\n【角色卡附带的指令】\n' + extra.join('\n');
  const pack = { id: uid(), name: c.name, kind: 'card', file, importedAt: Date.now(), cardIds: [card.id] };
  if (c.book) {
    const { mods } = worldbookToModules(c.book, { ...pack, name: c.name + ' 的世界书' }, ctx);
    for (const m of mods) { story.localModules.push(m); if (m.defaultOn) story.modules[m.id] = true; }
  }
  pack.count = story.localModules.length;
  story.packs.push(pack);
  return story;
}

export async function deleteGlobalPack(id) {
  await saveModules((await getModules()).filter((m) => m.pack !== id));
  await savePacks((await getPacks()).filter((p) => p.id !== id));
}

// ───────────── 导入：某个故事里 ─────────────

/** 直接改 story（调用方负责保存）。返回说明 */
export function importToStory(story, items) {
  story.localModules = story.localModules || [];
  story.packs = story.packs || [];
  story.modules = story.modules || {};
  story.cards = story.cards || [];
  const lines = [];
  const mainChar = story.cards.find((c) => c.core)?.name || '角色';
  for (const { file, json } of items) {
    const kind = detectKind(json);
    const label = nameOf(file);
    if (kind === 'preset' || kind === 'worldbook') {
      const pack = { id: uid(), name: json.name || label, kind, file, importedAt: Date.now() };
      const mods = kind === 'preset' ? presetToModules(json, pack) : worldbookToModules(json, pack, { char: mainChar }).mods;
      if (!mods.length) { lines.push(`${KIND_LABEL[kind]}「${pack.name}」：没有可用的内容`); continue; }
      for (const m of mods) { story.localModules.push(m); if (m.defaultOn) story.modules[m.id] = true; }
      pack.count = mods.length;
      pack.chars = mods.reduce((a, m) => a + m.text.length, 0);
      story.packs.push(pack);
      lines.push(`${KIND_LABEL[kind]}「${pack.name}」：${mods.length} 条，已开 ${mods.filter((m) => m.defaultOn).length} 条（和预设里原来一样）`);
    } else if (kind === 'card') {
      const c = readChara(json);
      if (story.cards.some((x) => x.name === c.name)) { lines.push(`角色卡「${c.name}」：这个故事已经有同名角色，跳过`); continue; }
      const card = charaToCard(c);
      card.core = false;
      story.cards.push(card);
      const pack = { id: uid(), name: c.name, kind: 'card', file, importedAt: Date.now(), cardIds: [card.id], count: 0 };
      if (c.book) {
        const { mods } = worldbookToModules(c.book, { ...pack, name: c.name + ' 的世界书' }, { char: c.name });
        for (const m of mods) { story.localModules.push(m); if (m.defaultOn) story.modules[m.id] = true; }
        pack.count = mods.length;
      }
      story.packs.push(pack);
      lines.push(`角色卡「${c.name}」：加进了角色卡${pack.count ? `，带世界书 ${pack.count} 条` : ''}`);
    } else {
      lines.push(`${label}：${KIND_LABEL[kind]}，${kind === 'regex' || kind === 'theme' ? '美化和正则暂不支持' : kind === 'instruct' ? '墨游用不上' : '认不出来'}`);
    }
  }
  return lines;
}

/** 删掉故事里的一个包：它加的模块、角色卡一起删 */
export function deleteStoryPack(story, id) {
  const pack = (story.packs || []).find((p) => p.id === id);
  if (!pack) return;
  const gone = new Set((story.localModules || []).filter((m) => m.pack === id).map((m) => m.id));
  story.localModules = (story.localModules || []).filter((m) => m.pack !== id);
  for (const k of gone) delete story.modules?.[k];
  if (pack.cardIds?.length) story.cards = (story.cards || []).filter((c) => !pack.cardIds.includes(c.id));
  story.packs = story.packs.filter((p) => p.id !== id);
}

/** 这个故事能用的全部模块：全局模块库 + 自己导入的 */
export function storyModules(story, globalMods = []) {
  return [...globalMods, ...(story?.localModules || [])];
}
