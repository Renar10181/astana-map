// Отметки камер от пользователей. Хранятся в Cloudflare KV (привязка CAMERAS).
// Если KV ещё не подключён — отвечаем ok:false, карта продолжает работать с камерами из OpenStreetMap.
const BOX = { w: 70.95, s: 50.85, e: 71.95, n: 51.40 };
const KEY = 'list';

function distM(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

export async function onRequestGet({ env }) {
  if (!env.CAMERAS) return Response.json({ ok: false, items: [] });
  const items = JSON.parse((await env.CAMERAS.get(KEY)) || '[]');
  return Response.json({ ok: true, items }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}

export async function onRequestPost({ request, env }) {
  if (!env.CAMERAS) return Response.json({ ok: false, error: 'storage not configured' }, { status: 503 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ ok: false }, { status: 400 }); }
  const lat = +body.lat, lng = +body.lng;
  if (!(lat > BOX.s && lat < BOX.n && lng > BOX.w && lng < BOX.e)) return Response.json({ ok: false, error: 'outside Astana' }, { status: 400 });

  const items = JSON.parse((await env.CAMERAS.get(KEY)) || '[]');
  const near = items.find(c => distM(c, { lat, lng }) < 60);
  if (near) { near.votes = (near.votes || 1) + 1; near.ts = Date.now(); }
  else items.push({ id: crypto.randomUUID().slice(0, 8), lat: +lat.toFixed(6), lng: +lng.toFixed(6), votes: 1, ts: Date.now() });
  if (items.length > 3000) items.splice(0, items.length - 3000);
  await env.CAMERAS.put(KEY, JSON.stringify(items));
  return Response.json({ ok: true, count: items.length });
}
