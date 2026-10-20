// Цены на АЗС от водителей. Ключ "fuel" в Cloudflare KV (привязка CAMERAS): { "широта,долгота": {n, lat, lng, p:{a92,a95,dt,gas}, ts} }
const BOX = { w: 70.95, s: 50.85, e: 71.95, n: 51.40 };
const KINDS = ['a92', 'a95', 'dt', 'gas'];
const json = (o, status = 200) => Response.json(o, { status, headers: { 'Cache-Control': 'no-store' } });
const read = async env => JSON.parse((await env.CAMERAS.get('fuel')) || '{}');

export async function onRequestGet({ env }) {
  if (!env.CAMERAS) return json({ ok: false, items: {} });
  return json({ ok: true, items: await read(env) });
}

export async function onRequestPost({ request, env }) {
  if (!env.CAMERAS) return json({ ok: false, error: 'storage not configured' }, 503);
  let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
  const lat = +b.lat, lng = +b.lng;
  if (!(lat > BOX.s && lat < BOX.n && lng > BOX.w && lng < BOX.e)) return json({ ok: false }, 400);
  const p = {};
  for (const k of KINDS) { const v = Math.round(+b.p?.[k]); if (v >= 100 && v <= 700) p[k] = v; }
  if (!Object.keys(p).length) return json({ ok: false, error: 'no prices' }, 400);
  const items = await read(env);
  const id = lat.toFixed(4) + ',' + lng.toFixed(4);
  items[id] = { n: String(b.name || 'АЗС').slice(0, 60), lat: +lat.toFixed(6), lng: +lng.toFixed(6), p, ts: Date.now() };
  await env.CAMERAS.put('fuel', JSON.stringify(items));
  return json({ ok: true });
}
