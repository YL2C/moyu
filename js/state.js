// 墨游 · 共享状态：阅读偏好、连接、默认规则、页面跳转

import { db } from './db.js';
import { DEFAULT_RULES } from './prompt.js';
import { CURRENT_STORY_KEY } from './personal.js';
import { showReadingFont } from './reading-fonts.js';

export const DEFAULT_PREFS = {
  fontSize: 17, font: 'serif', theme: 'default', paperFontSize: 16, paperFont: 'kinghwa', indent: true, danmuOpen: true,
};
export const READING_THEMES = [
  { id: 'default', label: '默认', sizeKey: 'fontSize', fontKey: 'font', colorKey: 'readingColors' },
  { id: 'paper', label: '纸书', sizeKey: 'paperFontSize', fontKey: 'paperFont', colorKey: 'paperColors' },
];
export const READING_DIMENSIONS = [
  { key: 'size', label: '字号', property: '--read-size', min: 12, max: 32, step: 1, unit: 'px' },
  { key: 'letter', label: '字距', property: '--read-letter-spacing', min: -1, max: 4, step: 0.1, unit: 'px', initial: 0 },
  { key: 'line', label: '行距', property: '--read-line-height', min: 1.2, max: 2.6, step: 0.05, unit: '', initial: 1.9 },
  { key: 'paragraph', label: '段距', property: '--read-paragraph-spacing', min: 0, max: 2, step: 0.05, unit: 'em', initial: 0.85 },
];
let prefs = { ...DEFAULT_PREFS };
export const isReadingColor = (value) => typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value);
export const readingTheme = (id) => READING_THEMES.find(theme => theme.id === id) || READING_THEMES[0];

export function readingDimension(theme, { key, min, max, step, initial }, source = prefs) {
  const value = key === 'size' ? source[theme.sizeKey] : source.readingSpacing?.[theme.id]?.[key];
  if (!Number.isFinite(value)) return initial ?? DEFAULT_PREFS[theme.sizeKey];
  const clamped = Math.min(max, Math.max(min, value));
  return Number((Math.round((clamped - min) / step) * step + min).toFixed(2));
}

export async function loadPrefs() {
  prefs = { ...DEFAULT_PREFS, ...((await db.kvGet('prefs', null)) || {}) };
  applyPrefs();
  return prefs;
}
export function getPrefs() { return prefs; }
export async function setPrefs(patch) {
  prefs = { ...prefs, ...patch };
  applyPrefs();
  await db.kvSet('prefs', prefs);
}
export function applyPrefs() {
  const r = document.documentElement;
  const theme = readingTheme(prefs.theme);
  for (const dimension of READING_DIMENSIONS) {
    const { key, property, unit } = dimension;
    if (key === 'size' || Number.isFinite(prefs.readingSpacing?.[theme.id]?.[key])) {
      r.style.setProperty(property, readingDimension(theme, dimension) + unit);
    } else r.style.removeProperty(property);
  }
  r.dataset.theme = theme.id;
  r.dataset.font = prefs[theme.fontKey] || DEFAULT_PREFS[theme.fontKey];
  r.dataset.indent = prefs.indent ? 'on' : 'off';
  r.dataset.dialogue = prefs.dialogueColor === false ? 'off' : 'on';
  const colors = prefs[theme.colorKey];
  for (const [key, property] of [['narration', '--custom-narration'], ['dialogue', '--custom-dialogue']]) {
    const value = colors?.[key];
    if (isReadingColor(value)) r.style.setProperty(property, value);
    else r.style.removeProperty(property);
  }
  document.querySelectorAll('meta[name="theme-color"][data-paper-color]').forEach(meta => {
    meta.content = meta.dataset[theme.id + 'Color'] || meta.dataset.defaultColor;
  });
  void showReadingFont(r.dataset.font);
}

export async function getDefaultRules() {
  const v = await db.kvGet('defaultRules', null);
  return v == null ? DEFAULT_RULES : v;
}

export async function getConnections() {
  const list = await db.all('connections');
  // 旧版默认输出上限 4000：中文一章加弹幕选项经常写不完（尤其开了思考的模型），统一调到 8000
  for (const c of list) {
    if (!c.mt8000) {
      if (c.maxTokens == null || Number(c.maxTokens) === 4000) c.maxTokens = 8000;
      c.mt8000 = true;
      db.put('connections', c).catch(() => {});
    }
  }
  return list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
export async function getDefaultConnId() { return db.kvGet('defaultConn', null); }
export async function setDefaultConnId(id) { return db.kvSet('defaultConn', id); }

/** 故事用的连接：故事自己选的 → 默认连接 → 第一个 */
export async function resolveConnection(story) {
  const list = await getConnections();
  if (!list.length) return null;
  const own = story?.connectionId && list.find((c) => c.id === story.connectionId);
  if (own) return own;
  const d = await getDefaultConnId();
  return list.find((c) => c.id === d) || list[0];
}

export function connLabel(c) {
  if (!c) return '未连接';
  return c.name?.trim() || c.model || '未命名连接';
}

// 当前故事：底部菜单的“游玩 / 角色 / 番外”指向它
let currentStory = null;
try { currentStory = localStorage.getItem(CURRENT_STORY_KEY) || null; } catch {}
export function getCurrentStory() { return currentStory; }
export function setCurrentStory(id) {
  currentStory = id || null;
  try { if (id) localStorage.setItem(CURRENT_STORY_KEY, id); else localStorage.removeItem(CURRENT_STORY_KEY); } catch {}
}

// 游玩页自己管的字段：别的页面只从它那里同步这些，免得把自己正在编辑、还没存的内容冲掉
export const PLAY_KEYS = ['headId', 'chapters', 'updatedAt', 'lastTitle'];
/**
 * 别的页面保存了同一个故事：把最新内容合进这个页面手里的故事对象。
 * keys 不填就全部同步（游玩页用）；填了只同步这些字段（设定、角色、记忆页用）。返回取消监听的函数
 */
export function watchStory(story, onChange, keys = null) {
  const fn = (e) => {
    const d = e.detail || {};
    if (d.store !== 'stories' || !d.obj || d.obj === story || d.obj.id !== story.id) return;
    const fresh = JSON.parse(JSON.stringify(d.obj));
    if (keys) for (const k of keys) { if (k in fresh) story[k] = fresh[k]; }
    else Object.assign(story, fresh);
    onChange?.();
  };
  window.addEventListener('moyu:put', fn);
  return () => window.removeEventListener('moyu:put', fn);
}

export function go(path = '') {
  const h = '#/' + path;
  if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = h;
}

// ───── 规则模块库（全局，所有故事共用；每个故事自己选启用哪些） ─────
export const MODULE_MODES = { always: '一直发送', manual: '手动开关（情境）', keyword: '出现关键词时发送' };

export async function getModules() {
  const list = (await db.kvGet('modules', null)) || [];
  return Array.isArray(list) ? list : [];
}
export async function saveModules(list) { return db.kvSet('modules', list); }

/** 把 markdown 按“## 标题”拆成模块；没有 ## 的话整份当一个模块 */
export function modulesFromMarkdown(md, fallbackName = '导入的规则', { verbatim = false } = {}) {
  const input = String(md || '');
  const text = verbatim ? input : input.replace(/\r/g, '');
  const parts = text.split(verbatim ? /^##[ \t]+/m : /^##\s+/m);
  const out = [];
  if (parts.length <= 1) {
    const body = text.replace(/^---[\s\S]*?---\n/, '').trim();
    if (body) out.push({ name: fallbackName, text: body });
    return out;
  }
  const head = parts[0].replace(/^---[\s\S]*?---\n/, '').replace(/^#\s+.*$/m, '').trim();
  if (head) out.push({ name: fallbackName + '（开头）', text: head });
  for (const p of parts.slice(1)) {
    const nl = p.indexOf('\n');
    const name = (nl < 0 ? p : p.slice(0, nl)).trim();
    const raw = nl < 0 ? '' : p.slice(nl + 1);
    const body = verbatim ? raw.slice(0, -2).replace(/^\\(?=\\|##[ \t])/gm, '') : raw.trim();
    if (name && (body || verbatim)) out.push({ name, text: body });
  }
  return out;
}

export function modulesToMarkdown(list, { verbatim = false } = {}) {
  // The internal import format escapes body lines that could be read as section headings.
  if (verbatim) return list.map(m => `## ${m.name}\n${m.text.replace(/^(?=\\|##[ \t])/gm, '\\')}\n\n`).join('');
  return list.map((m) => `## ${m.name}\n${m.text.trim()}\n`).join('\n');
}

// ───── 全局备忘：所有故事每轮都带上（讨论页里写入） ─────
export async function getGlobalMemo() { return (await db.kvGet('globalMemo', '')) || ''; }
export async function setGlobalMemo(text) { return db.kvSet('globalMemo', String(text || '')); }
