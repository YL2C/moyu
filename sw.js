// 墨游 · 离线缓存
// 只缓存本站的页面文件；API 请求一律不经过缓存。
// 先向服务器核验最新文件，取不到再用离线缓存；安装时绕过 HTTP 旧缓存。
const CACHE_PREFIX = 'moyu-yl2c-personal-';
const CACHE = CACHE_PREFIX + '0.6.15-personal.3';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/util.js',
  './js/state.js',
  './js/db.js',
  './js/personal.js',
  './js/inline.js',
  './js/rules.js',
  './js/attachments.js',
  './js/protagonist.js',
  './js/api.js',
  './js/relay.js',
  './js/prompt.js',
  './js/parse.js',
  './js/cost.js',
  './js/fanwai.js',
  './js/memory.js',
  './js/exporter.js',
  './js/tavern.js',
  './js/vertex.js',
  './js/discuss.js',
  './js/views/discuss.js',
  './js/views/attachment-ui.js',
  './js/views/rules-ui.js',
  './js/views/library.js',
  './js/views/story-edit.js',
  './js/views/story.js',
  './js/views/extras.js',
  './js/views/memory.js',
  './js/views/chars.js',
  './js/views/packs-ui.js',
  './js/views/play.js',
  './js/views/settings.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(ASSETS.map((path) => new Request(new URL(path, self.location.href), { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function timeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 不碰 API 和其他网站
  e.respondWith(
    Promise.race([fetch(req, { cache: 'no-cache' }), timeout(4000)])
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.open(CACHE).then(async (c) => (await c.match(req, { ignoreSearch: true })) || c.match('./index.html'))
      )
  );
});
