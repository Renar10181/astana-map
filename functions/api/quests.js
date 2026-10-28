// Квесты Барыса: ответы жителей о местах (часы работы, вход, работает ли, остановка, пандус).
// Хранится в Cloudflare KV (привязка CAMERAS), ключ «quests».
// Факт подтверждён, когда 3 РАЗНЫХ человека дали одинаковый ответ. Не больше 30 ответов в день с одного адреса.
const BOX = { w: 70.95, s: 50.85, e: 71.95, n: 51.40 };
const KINDS = ['hours', 'open', 'entrance', 'access', 'stop'];
const NEED = 3, PER_DAY = 30, MAX_ITEMS = 4000;

async function voter(request) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('astana-map:' + ip));
  return [...new Uint8Array(d)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
}
const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);   // день по времени Астаны
const load = async env => JSON.parse((await env.CAMERAS.get('quests')) || '{"q":{},"day":{"d":"","c":{}}}');

// наружу — без хэшей участников
function pub(q) {
  const out = {};
  for (const [id, x] of Object.entries(q)) {
    const tally = {};
    for (const [v, list] of Object.entries(x.v || {})) tally[v] = list.length;
    out[id] = { k: x.k, n: x.n, lng: x.lng, lat: x.lat, ok: x.ok ?? null, at: x.at ?? null, t: tally };
  }
  return out;
}

export async function onRequestGet({ env }) {
  if (!env.CAMERAS) return Response.json({ ok: false, q: {} });
  const db = await load(env);
  return Response.json({ ok: true, q: pub(db.q) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestPost({ request, env }) {
  if (!env.CAMERAS) return Response.json({ ok: false, error: 'storage not configured' }, { status: 503 });
  let b; try { b = await request.json(); } catch { return Response.json({ ok: false }, { status: 400 }); }
  const id = String(b.id || '').slice(0, 80), kind = String(b.kind || ''), val = String(b.v || '').slice(0, 40);
  const lat = +b.lat, lng = +b.lng, name = String(b.name || '').slice(0, 80);
  if (!id || !KINDS.includes(kind) || !val) return Response.json({ ok: false, error: 'bad request' }, { status: 400 });
  if (!(lat > BOX.s && lat < BOX.n && lng > BOX.w && lng < BOX.e)) return Response.json({ ok: false, error: 'outside Astana' }, { status: 400 });

  const db = await load(env), who = await voter(request), d = today();
  if (db.day.d !== d) db.day = { d, c: {} };
  if ((db.day.c[who] || 0) >= PER_DAY) return Response.json({ ok: false, error: 'limit' }, { status: 429 });

  const x = db.q[id] || (db.q[id] = { k: kind, n: name, lng: +lng.toFixed(6), lat: +lat.toFixed(6), v: {}, ts: Date.now() });
  // один человек — один ответ на квест (можно поменять)
  for (const list of Object.values(x.v)) { const i = list.indexOf(who); if (i >= 0) list.splice(i, 1); }
  (x.v[val] = x.v[val] || []).push(who);
  x.ts = Date.now();
  const best = Object.entries(x.v).sort((a, c) => c[1].length - a[1].length)[0];
  if (best && best[1].length >= NEED) { if (x.ok !== best[0]) { x.ok = best[0]; x.at = Date.now(); } }
  db.day.c[who] = (db.day.c[who] || 0) + 1;

  // не даём ключу разрастись: выкидываем самые старые неподтверждённые
  const ids = Object.keys(db.q);
  if (ids.length > MAX_ITEMS) ids.filter(k => !db.q[k].ok).sort((a, c) => db.q[a].ts - db.q[c].ts).slice(0, ids.length - MAX_ITEMS).forEach(k => delete db.q[k]);

  await env.CAMERAS.put('quests', JSON.stringify(db));
  return Response.json({ ok: true, confirmed: x.ok === val, votes: x.v[val].length, need: NEED, left: PER_DAY - db.day.c[who] });
}
