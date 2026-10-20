// Отметки камер от водителей. Хранятся в Cloudflare KV (привязка CAMERAS).
//  list   — камеры, отмеченные водителями (с числом подтверждений от РАЗНЫХ водителей; подтверждённая — от 3)
//  hidden — камеры из OpenStreetMap, которые водители пометили как «камеры нет»
const BOX = { w: 70.95, s: 50.85, e: 71.95, n: 51.40 };

function distM(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
const inBox = (lat, lng) => lat > BOX.s && lat < BOX.n && lng > BOX.w && lng < BOX.e;
const read = async (env, key) => JSON.parse((await env.CAMERAS.get(key)) || '[]');
// водителя различаем по хэшу IP с солью — сам IP не храним
async function voter(request) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('astana-map:' + ip));
  return [...new Uint8Array(d)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet({ env }) {
  if (!env.CAMERAS) return Response.json({ ok: false, items: [], hidden: [] });
  const [items, hidden] = await Promise.all([read(env, 'list'), read(env, 'hidden')]);
  return Response.json({ ok: true, items: items.map(({ voters, ...c }) => c), hidden }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestPost({ request, env }) {
  if (!env.CAMERAS) return Response.json({ ok: false, error: 'storage not configured' }, { status: 503 });
  let body; try { body = await request.json(); } catch { return Response.json({ ok: false }, { status: 400 }); }
  const lat = +body.lat, lng = +body.lng;
  if (!inBox(lat, lng)) return Response.json({ ok: false, error: 'outside Astana' }, { status: 400 });
  const items = await read(env, 'list');
  const v = await voter(request);
  let near = items.find(c => distM(c, { lat, lng }) < 60);
  if (near) {
    near.voters = near.voters || [];
    if (!near.voters.includes(v)) { near.voters.push(v); near.votes = (near.votes || 1) + 1; }
    near.ts = Date.now();
  } else {
    near = { id: crypto.randomUUID().slice(0, 8), lat: +lat.toFixed(6), lng: +lng.toFixed(6), votes: 1, voters: [v], ts: Date.now() };
    items.push(near);
  }
  if (items.length > 3000) items.splice(0, items.length - 3000);
  await env.CAMERAS.put('list', JSON.stringify(items));
  // если раньше эту точку помечали «камеры нет» — снимаем пометку
  const hidden = (await read(env, 'hidden')).filter(h => distM(h, { lat, lng }) >= 40);
  await env.CAMERAS.put('hidden', JSON.stringify(hidden));
  return Response.json({ ok: true, count: items.length, votes: near.votes });
}

export async function onRequestDelete({ request, env }) {
  if (!env.CAMERAS) return Response.json({ ok: false, error: 'storage not configured' }, { status: 503 });
  let body; try { body = await request.json(); } catch { return Response.json({ ok: false }, { status: 400 }); }
  const lat = +body.lat, lng = +body.lng;
  if (!inBox(lat, lng)) return Response.json({ ok: false }, { status: 400 });
  if (body.src === 'user') {
    const items = await read(env, 'list');
    const i = items.findIndex(c => distM(c, { lat, lng }) < 60);
    if (i >= 0) items.splice(i, 1);
    await env.CAMERAS.put('list', JSON.stringify(items));
  } else {
    const hidden = await read(env, 'hidden');
    if (!hidden.some(h => distM(h, { lat, lng }) < 40)) hidden.push({ lat: +lat.toFixed(6), lng: +lng.toFixed(6), ts: Date.now() });
    if (hidden.length > 3000) hidden.splice(0, hidden.length - 3000);
    await env.CAMERAS.put('hidden', JSON.stringify(hidden));
  }
  return Response.json({ ok: true });
}
