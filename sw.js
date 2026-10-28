// Карта Астаны — работа без интернета.
// Приложение: сначала сеть, без сети — из памяти. Плитки карты, шрифты и библиотеки — из памяти, если уже есть.
const V = '1.6.1';
const SHELL = 'shell-' + V, TILES = 'tiles-v1', LIBS = 'libs-v1';
const MAX_TILES = 2500;   // сколько просмотренных плиток держать (скачанная карта хранится отдельно и не удаляется)

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['/', '/manifest.webmanifest', '/icons/icon-192.png'])).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin === location.origin){
    if (u.pathname.startsWith('/api/')) return;               // голос, камеры, события — только сеть
    return e.respondWith(netFirst(r, SHELL, r.mode === 'navigate' ? '/' : null));
  }
  if (u.hostname === 'tiles.openfreemap.org'){
    if (/\.(pbf|png|webp)$/.test(u.pathname) || u.pathname.startsWith('/sprites/'))
      return e.respondWith(cacheFirst(r, TILES, true));         // плитки, шрифты, значки
    return e.respondWith(netFirst(r, TILES));                  // стиль и описание плиток — свежие, без сети из памяти
  }
  if (['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(u.hostname))
    return e.respondWith(cacheFirst(r, LIBS));
});

let puts = 0;
async function cacheFirst(r, name, trim){
  const hit = await caches.match(r.url);
  if (hit) return hit;
  const res = await fetch(r);
  if (res.ok || res.type === 'opaque'){
    const c = await caches.open(name);
    c.put(r.url, res.clone());
    if (trim && ++puts % 100 === 0) trimCache(c);
  }
  return res;
}
async function netFirst(r, name, fallback){
  try{
    const res = await fetch(r);
    if (res.ok) (await caches.open(name)).put(r.mode === 'navigate' ? '/' : r.url, res.clone());
    return res;
  }catch(err){
    const hit = await caches.match(r.mode === 'navigate' ? '/' : r.url) || (fallback && await caches.match(fallback));
    if (hit) return hit;
    throw err;
  }
}
async function trimCache(c){
  const keys = await c.keys();
  if (keys.length > MAX_TILES) for (const k of keys.slice(0, keys.length - MAX_TILES)) await c.delete(k);
}
