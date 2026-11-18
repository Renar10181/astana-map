import { inCities } from '../../lib/cities.js';
import { ipHash } from '../../lib/guard.js';
// Отметки камер от водителей. Хранятся в Cloudflare KV (привязка CAMERAS).
//  list   — камеры, отмеченные водителями (с числом подтверждений от РАЗНЫХ водителей; подтверждённая — от 3)
//  hidden — камеры из OpenStreetMap, которые водители пометили как «камеры нет»

function distM(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
const inBox = (lat, lng) => inCities(lat, lng);
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
  if (!inBox(lat, lng)) return Response.json({ ok: false, error: 'outside city' }, { status: 400 });
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
  // убрать камеру — нужны голоса двух разных людей (один человек не может стереть камеры с карты)
  const votes = JSON.parse((await env.CAMERAS.get('camvotes')) || '{}'), vk = lat.toFixed(4) + ',' + lng.toFixed(4), who = await ipHash(request);
  const now = Date.now(); for (const k of Object.keys(votes)) if (now - (votes[k].t || 0) > 30 * 864e5) delete votes[k];
  const v = votes[vk] || { w: [], t: now }; if (!v.w.includes(who)) v.w.push(who); v.t = now; votes[vk] = v;
  if (v.w.length < 2) { await env.CAMERAS.put('camvotes', JSON.stringify(votes)); return Response.json({ ok: true, pending: true }); }
  delete votes[vk]; await env.CAMERAS.put('camvotes', JSON.stringify(votes));
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
