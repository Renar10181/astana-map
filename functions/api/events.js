// Дорожные события от водителей: ДТП, пробка, ремонт, перекрытие, полиция, яма, опасность.
// Хранятся в том же Cloudflare KV, что и камеры (привязка CAMERAS), ключ "events".
// У каждого события свой срок жизни; подтверждение «Ещё есть» продлевает его.
const BOX = { w: 70.95, s: 50.85, e: 71.95, n: 51.40 };
const H = 3600e3;
const TTL = { accident: 2 * H, jam: 1 * H, works: 7 * 24 * H, closed: 12 * H, police: 3 * H, pothole: 30 * 24 * H, danger: 6 * H };
const KEY = 'events';

function distM(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
const inBox = (lat, lng) => lat > BOX.s && lat < BOX.n && lng > BOX.w && lng < BOX.e;
const alive = (x, now) => TTL[x.type] && now - x.ts < TTL[x.type];
async function read(env) {
  const now = Date.now();
  return JSON.parse((await env.CAMERAS.get(KEY)) || '[]').filter(x => alive(x, now));
}
const json = (o, status = 200) => Response.json(o, { status, headers: { 'Cache-Control': 'no-store' } });

export async function onRequestGet({ env }) {
  if (!env.CAMERAS) return json({ ok: false, items: [] });
  return json({ ok: true, items: await read(env) });
}

export async function onRequestPost({ request, env }) {
  if (!env.CAMERAS) return json({ ok: false, error: 'storage not configured' }, 503);
  let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
  const lat = +b.lat, lng = +b.lng, type = String(b.type || '');
  if (!TTL[type] || !inBox(lat, lng)) return json({ ok: false, error: 'bad input' }, 400);
  const items = await read(env), now = Date.now();
  let item = items.find(x => x.type === type && distM(x, { lat, lng }) < 100);
  if (item) { item.votes = (item.votes || 1) + 1; item.ts = now; }
  else {
    item = { id: crypto.randomUUID().slice(0, 8), type, lat: +lat.toFixed(6), lng: +lng.toFixed(6), votes: 1, ts: now, t0: now };
    items.push(item);
  }
  if (items.length > 2000) items.splice(0, items.length - 2000);
  await env.CAMERAS.put(KEY, JSON.stringify(items));
  return json({ ok: true, item });
}

export async function onRequestDelete({ request, env }) {
  if (!env.CAMERAS) return json({ ok: false, error: 'storage not configured' }, 503);
  let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
  const items = (await read(env)).filter(x => x.id !== String(b.id || ''));
  await env.CAMERAS.put(KEY, JSON.stringify(items));
  return json({ ok: true });
}
