// 墨游 · 启动与页面切换

import { ensurePersist } from './db.js';
import { loadPrefs } from './state.js';
import * as library from './views/library.js';
import * as play from './views/play.js';
import * as settings from './views/settings.js';

const root = document.getElementById('app');
let cleanup = null;
let routeToken = 0;

async function route() {
  const token = ++routeToken;
  const h = location.hash.replace(/^#\/?/, '');
  const [name, arg] = h.split('/');
  if (typeof cleanup === 'function') { try { cleanup(); } catch {} }
  cleanup = null;
  let mod = library;
  const params = {};
  if (name === 'play' && arg) { mod = play; params.id = decodeURIComponent(arg); }
  else if (name === 'settings') { mod = settings; params.section = arg || ''; }
  const container = document.createElement('div');
  container.className = 'view-host';
  const c = await mod.render(container, params);
  if (token !== routeToken) { if (typeof c === 'function') c(); return; }
  root.replaceChildren(container);
  cleanup = c;
}

// iPhone 键盘弹出时，让页面高度跟着可见区域走，输入框不被挡住
function fitViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
  if (vv && vv.offsetTop) window.scrollTo(0, 0);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitViewport);
  window.visualViewport.addEventListener('scroll', fitViewport);
}
window.addEventListener('resize', fitViewport);

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
