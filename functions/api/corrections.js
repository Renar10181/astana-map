// «Здесь не так?» — сообщения водителей об ошибках карты. KV (привязка CAMERAS), ключ "corrections", до 3000 последних.
// GET отдаёт только счётчики (сами сообщения проверяет владелец карты).
const BOX = { w: 70.95, s: 50.85, e: 71.95, n: 51.40 };
const json = (o, status = 200) => Response.json(o, { status, headers: { 'Cache-Control': 'no-store' } });
const read = async env => JSON.parse((await env.CAMERAS.get('corrections')) || '[]');

export async function onRequestGet({ env }) {
  if (!env.CAMERAS) return json({ ok: false, count: 0 });
  const items = await read(env);
  return json({ ok: true, count: items.length, last: items.length ? items[items.length - 1].ts : null });
}

export async function onRequestPost({ request, env }) {
  if (!env.CAMERAS) return json({ ok: false, error: 'storage not configured' }, 503);
  let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
  const lat = +b.lat, lng = +b.lng;
  if (!(lat > BOX.s && lat < BOX.n && lng > BOX.w && lng < BOX.e)) return json({ ok: false }, 400);
  const items = await read(env);
  items.push({ lat: +lat.toFixed(6), lng: +lng.toFixed(6), type: String(b.type || '').slice(0, 80), text: String(b.text || '').slice(0, 500), ts: Date.now() });
  if (items.length > 3000) items.splice(0, items.length - 3000);
  await env.CAMERAS.put('corrections', JSON.stringify(items));
  return json({ ok: true, count: items.length });
}
