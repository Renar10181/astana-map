// «Поделиться поездкой»: водитель раз в 30 секунд отправляет, где он, — по ссылке #t=ID это видно на карте.
// Хранится в том же Cloudflare KV (привязка CAMERAS), запись живёт 30 минут после последнего обновления.
// Бесплатный KV разрешает ~1000 записей в сутки: одна поездка 30 минут ≈ 60 записей.
const okId = id => /^[a-z0-9]{6,16}$/.test(id || '');
const json = (o, status = 200) => Response.json(o, { status, headers: { 'Cache-Control': 'no-store' } });

export async function onRequestGet({ request, env }) {
  const id = new URL(request.url).searchParams.get('id');
  if (!env.CAMERAS || !okId(id)) return json({ ok: false }, 400);
  const v = JSON.parse((await env.CAMERAS.get('trip:' + id)) || 'null');
  if (!v) return json({ ok: false, ended: true }, 404);
  delete v.key;
  return json({ ok: true, ...v });
}

export async function onRequestPost({ request, env }) {
  if (!env.CAMERAS) return json({ ok: false, error: 'storage not configured' }, 503);
  let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
  if (!okId(b.id) || typeof b.key !== 'string' || b.key.length < 12) return json({ ok: false }, 400);
  const prev = JSON.parse((await env.CAMERAS.get('trip:' + b.id)) || 'null');
  if (prev && prev.key !== b.key) return json({ ok: false }, 403);
  if (b.ended) {
    await env.CAMERAS.put('trip:' + b.id, JSON.stringify({ key: b.key, ended: true, ts: Date.now() }), { expirationTtl: 600 });
    return json({ ok: true });
  }
  const lat = +b.lat, lng = +b.lng;
  if (!(lat > 40 && lat < 56 && lng > 46 && lng < 88)) return json({ ok: false }, 400);   // Казахстан
  const v = {
    key: b.key, ts: Date.now(), lat: +lat.toFixed(5), lng: +lng.toFixed(5), h: +b.h || 0,
    left: Math.max(0, +b.left || 0), eta: +b.eta || Date.now(), to: String(b.to || '').slice(0, 80),
    toLat: +b.toLat || null, toLng: +b.toLng || null,
  };
  await env.CAMERAS.put('trip:' + b.id, JSON.stringify(v), { expirationTtl: 1800 });
  return json({ ok: true });
}
