// Анонимные GPS-треки поездок («Записать поездку» / «📡 +5» после поездки).
// Без имени, устройства и IP: только точки [lng, lat, секунды от начала]. Хранятся 120 дней в KV (привязка CAMERAS),
// потом по ним считаем реальные скорости улиц по часам — основа своих «пробок».
// live:true — точки из идущей поездки для слоя пробок (/api/traffic), живут 1 час.
const json = (o, status = 200) => Response.json(o, { status, headers: { 'Cache-Control': 'no-store' } });

export async function onRequestPost({ request, env }) {
  if (!env.CAMERAS) return json({ ok: false, error: 'storage not configured' }, 503);
  let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
  const pts = Array.isArray(b.pts) ? b.pts.slice(0, 1500) : [];
  const clean = pts.filter(p => Array.isArray(p) && p.length === 3 && p[1] > 40 && p[1] < 56 && p[0] > 46 && p[0] < 88 && p[2] >= 0 && p[2] < 86400)
    .map(([x, y, t]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5, Math.round(t)]);
  if (clean.length < (b.live ? 2 : 5)) return json({ ok: false, error: 'too short' }, 400);
  // живые точки из поездки — для слоя пробок, хранятся 1 час
  if (b.live) {
    const t0 = +b.t0; if (!(t0 > Date.now() - 4 * 3600e3 && t0 <= Date.now() + 60e3)) return json({ ok: false, error: 'time' }, 400);
    await env.CAMERAS.put(`live:${Date.now()}:${crypto.randomUUID().slice(0, 6)}`, JSON.stringify({ t0, pts: clean.slice(0, 300) }), { expirationTtl: 3600 });
    return json({ ok: true });
  }
  const day = new Date().toISOString().slice(0, 10), hour = new Date().getUTCHours();
  const key = `probe:${day}:${crypto.randomUUID().slice(0, 8)}`;
  await env.CAMERAS.put(key, JSON.stringify({ h: hour, pts: clean }), { expirationTtl: 120 * 86400 });
  return json({ ok: true });
}
