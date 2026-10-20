// Анонимные GPS-треки поездок («Записать поездку» / «📡 +5» после поездки).
// Без имени, устройства и IP: только точки [lng, lat, секунды от начала]. Хранятся 120 дней в KV (привязка CAMERAS),
// потом по ним считаем реальные скорости улиц по часам — основа своих «пробок».
const json = (o, status = 200) => Response.json(o, { status, headers: { 'Cache-Control': 'no-store' } });

export async function onRequestPost({ request, env }) {
  if (!env.CAMERAS) return json({ ok: false, error: 'storage not configured' }, 503);
  let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
  const pts = Array.isArray(b.pts) ? b.pts.slice(0, 1500) : [];
  const clean = pts.filter(p => Array.isArray(p) && p.length === 3 && p[1] > 40 && p[1] < 56 && p[0] > 46 && p[0] < 88 && p[2] >= 0 && p[2] < 86400)
    .map(([x, y, t]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5, Math.round(t)]);
  if (clean.length < 5) return json({ ok: false, error: 'too short' }, 400);
  const day = new Date().toISOString().slice(0, 10), hour = new Date().getUTCHours();
  const key = `probe:${day}:${crypto.randomUUID().slice(0, 8)}`;
  await env.CAMERAS.put(key, JSON.stringify({ h: hour, pts: clean }), { expirationTtl: 120 * 86400 });
  return json({ ok: true });
}
