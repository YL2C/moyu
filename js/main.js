// 墨游 · 启动与页面切换

import { ensurePersist } from './db.js';
import { loadPrefs } from './state.js';
import * as library from './views/library.js';
import * as play from './views/play.js';
import * as settings from './views/settings.js';
import * as storyPage from './views/story.js';

const root = document.getElementById('app');
let cleanup = null;
let routeToken = 0;

async function route() {
  const token = ++routeToken;
  const h = location.hash.replace(/^#\/?/, '');
  const [name, arg, arg2] = h.split('/');
  if (typeof cleanup === 'function') { try { cleanup(); } catch {} }
  cleanup = null;
  let mod = library;
  const params = {};
  if (name === 'play' && arg) { mod = play; params.id = decodeURIComponent(arg); }
  else if (name === 'settings') { mod = settings; params.section = arg || ''; }
  else if (name === 'story' && arg) { mod = storyPage; params.id = decodeURIComponent(arg); params.tab = arg2 || 'setting'; }
  const container = document.createElement('div');
  container.className = 'view-host';
  const c = await mod.render(container, params);
  if (token !== routeToken) { if (typeof c === 'function') c(); return; }
  root.replaceChildren(container);
  cleanup = c;
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
