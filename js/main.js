// 墨游 · 启动与页面切换

import { ensurePersist } from './db.js';
import { loadPrefs } from './state.js';
import * as library from './views/library.js';
import * as play from './views/play.js';
import * as settings from './views/settings.js';
import * as storyPage from './views/story.js';
import * as extrasPage from './views/extras.js';
import * as memoryPage from './views/memory.js';
import * as charsPage from './views/chars.js';
import * as discussPage from './views/discuss.js';
import { getCurrentStory, setCurrentStory } from './state.js';

const root = document.getElementById('app');
let current = null;   // 正在显示的页面 { key, name, el, api }
const parked = new Map();   // 切走时还在生成的页面：留在后台接着写，切回来接着看
let routeToken = 0;

function dispose(entry) {
  if (!entry) return;
  if (typeof entry.api === 'function') { try { entry.api(); } catch {} }
  entry.el.remove();
}

/** 离开一个页面：有生成在跑就停到后台，写完再收掉；否则直接收掉 */
function retire(entry) {
  if (!entry) return;
  const api = entry.api;
  if (api && typeof api.busy === 'function' && api.busy()) {
    entry.el.classList.add('parked');
    parked.set(entry.key, entry);
    entry.stopIdle?.();
    entry.stopIdle = api.onIdle?.(() => {
      if (parked.get(entry.key) === entry) { parked.delete(entry.key); dispose(entry); }
      if (current) placeTabs(current.name);
    });
    return;
  }
  dispose(entry);
}

async function route() {
  const token = ++routeToken;
  const h = location.hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  const [name, arg, arg2] = h.split('/');
  const key = h;
  let mod = library;
  const params = {};
  if (name === 'play' && arg) { mod = play; params.id = decodeURIComponent(arg); }
  else if (name === 'discuss') { mod = discussPage; params.id = arg ? decodeURIComponent(arg) : ''; }
  else if (name === 'settings') { mod = settings; params.section = arg || ''; }
  else if (name === 'memory' && arg) { mod = memoryPage; params.id = decodeURIComponent(arg); }
  else if (name === 'chars' && arg) { mod = charsPage; params.id = decodeURIComponent(arg); }
  else if (name === 'extra' && arg) { mod = extrasPage; params.id = decodeURIComponent(arg); params.extraId = arg2 ? decodeURIComponent(arg2) : ''; }
  else if (name === 'story' && arg && arg2 === 'cards') { location.replace('#/chars/' + arg); return; }
  else if (name === 'story' && arg) { mod = storyPage; params.id = decodeURIComponent(arg); params.tab = arg2 || 'setting'; }
  // 进了哪个故事，底部的“游玩 / 角色 / 番外”就指向哪个故事
  if (params.id && ['play', 'chars', 'extra', 'memory', 'story'].includes(name)) setCurrentStory(params.id);

  // 同一页又跳一次（比如刷新自己）：正在生成就别重来
  if (current && current.key === key && current.api?.busy?.()) { current.api.show?.(); return; }
  // 后台还在写的那一页：直接拿回来
  if (parked.has(key)) {
    const entry = parked.get(key);
    parked.delete(key);
    entry.stopIdle?.(); entry.stopIdle = null;
    const prev = current;
    current = entry;
    entry.el.classList.remove('parked');
    if (prev && prev !== entry) retire(prev);
    placeTabs(name);
    entry.api.show?.();
    return;
  }

  const container = document.createElement('div');
  container.className = 'view-host';
  const c = await mod.render(container, params);
  if (token !== routeToken) { if (typeof c === 'function' && !(c.busy && c.busy())) c(); else if (typeof c === 'function') retire({ key, name, el: container, api: c }); return; }
  const prev = current;
  current = { key, name, el: container, api: c };
  if (prev) retire(prev);
  root.insertBefore(container, root.querySelector('#tabbar'));
  placeTabs(name);
  root.classList.add('has-tabs');
}

// 删了故事：后台还在写这个故事的页面一起收掉
window.addEventListener('moyu:story-deleted', (e) => {
  const id = e.detail?.id;
  for (const [k, entry] of [...parked]) {
    if (k.split('/').map(decodeURIComponent).includes(id)) { parked.delete(k); dispose(entry); }
  }
});

function placeTabs(name) {
  const old = root.querySelector('#tabbar');
  const bar = tabBar(name);
  if (old) old.replaceWith(bar); else root.append(bar);
}

// 底部菜单（照老版）：故事 / 游玩 / 角色 / 番外 / 设置
const TABS = [
  { key: 'home', icon: '📚', label: '故事', to: () => '' },
  { key: 'play', icon: '📖', label: '游玩', story: true, to: (id) => 'play/' + encodeURIComponent(id) },
  { key: 'chars', icon: '👤', label: '角色', story: true, to: (id) => 'chars/' + encodeURIComponent(id) },
  { key: 'extra', icon: '🎴', label: '番外', story: true, to: (id) => 'extra/' + encodeURIComponent(id) },
  { key: 'discuss', icon: '💬', label: '讨论', to: () => 'discuss' },
  { key: 'settings', icon: '⚙️', label: '设置', to: () => 'settings' },
];
const TAB_OF = { '': 'home', play: 'play', memory: 'play', story: 'play', chars: 'chars', extra: 'extra', discuss: 'discuss', settings: 'settings' };
function tabBar(routeName) {
  const active = TAB_OF[routeName || ''] || '';
  const cur = getCurrentStory();
  const bar = document.createElement('nav');
  bar.id = 'tabbar';
  for (const t of TABS) {
    const b = document.createElement('button');
    // 后台还在写：游玩 / 番外 上亮个小点
    const busy = [...parked.values()].some((p) => TAB_OF[p.name] === t.key);
    b.className = 'tab' + (t.key === active ? ' on' : '') + (t.story && !cur ? ' off' : '') + (busy ? ' busy' : '');
    b.dataset.tab = t.key;
    b.innerHTML = '<span class="ic"></span><span class="lb"></span>';
    b.firstChild.textContent = t.icon;
    b.lastChild.textContent = t.label;
    b.addEventListener('click', () => {
      const id = getCurrentStory();
      if (t.story && !id) { import('./util.js').then((u) => u.toast('先在“故事”里选一个故事')); return; }
      const target = '#/' + t.to(id);
      if (location.hash === target || (target === '#/' && !location.hash.replace(/^#\/?/, ''))) return;
      location.hash = target;
    });
    bar.append(b);
  }
  return bar;
}

// iPhone 键盘弹出时：把应用钉在“可见区域”上（高度 + 系统平移的偏移量），输入框不被挡住。
// 不再强行把页面滚回顶部——那会和系统“把输入框移到键盘上方”的动作打架。
let fullH = 0;
let lastW = 0;
function fitViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  const top = vv ? Math.max(0, vv.offsetTop) : 0;
  const w = window.innerWidth;
  if (w !== lastW) { fullH = 0; lastW = w; } // 横竖屏切换时重新记录完整高度
  fullH = Math.max(fullH, h);
  const r = document.documentElement;
  r.style.setProperty('--app-h', Math.round(h) + 'px');
  r.style.setProperty('--vv-top', Math.round(top) + 'px');
  r.classList.toggle('kb', fullH - h > 140);
  keepFocusVisible();
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitViewport);
  window.visualViewport.addEventListener('scroll', fitViewport);
}
window.addEventListener('resize', fitViewport);

// 弹出层里的输入框获得焦点后，把它滚到弹出层可见范围内
let focusTimer = 0;
function keepFocusVisible() {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    const t = document.activeElement;
    if (!t || !t.closest) return;
    const box = t.closest('.sheet .sb');
    if (!box) return;
    const r = t.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top + 8 || r.bottom > b.bottom - 8) {
      box.scrollTop += r.top - b.top - Math.min(80, b.height / 4);
    }
  }, 250);
}
document.addEventListener('focusin', keepFocusVisible);

async function start() {
  fitViewport();
  await loadPrefs();
  window.addEventListener('hashchange', route);
  await route();
  ensurePersist();
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start().catch((e) => {
  root.innerHTML = '';
  const p = document.createElement('p');
  p.style.padding = '24px';
  p.textContent = '墨游启动失败：' + (e?.message || e) + '。如果是在无痕模式下打开的，请换成普通模式。';
  root.append(p);
  console.error(e);
});
