// 墨游 · 共享状态：阅读偏好、连接、默认规则、页面跳转

import { db } from './db.js';
import { DEFAULT_RULES } from './prompt.js';

export const DEFAULT_PREFS = { fontSize: 17, font: 'serif', indent: true, danmuOpen: true };
let prefs = { ...DEFAULT_PREFS };

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
  r.style.setProperty('--read-size', prefs.fontSize + 'px');
  r.dataset.font = prefs.font;
  r.dataset.indent = prefs.indent ? 'on' : 'off';
}

export async function getDefaultRules() {
  const v = await db.kvGet('defaultRules', null);
  return v == null ? DEFAULT_RULES : v;
}

export async function getConnections() {
  const list = await db.all('connections');
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

export function go(path = '') {
  const h = '#/' + path;
  if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = h;
}
