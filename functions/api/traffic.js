// Пробки по данным наших водителей (бета). Водители в поездке анонимно присылают точки (POST /api/probes, live:true),
// они живут в KV 1 час под ключами «live:…». Здесь считаем среднюю скорость по клеткам ~150 м за последние 30 минут.
// Результат кешируем на 3 минуты в ключе «traffic», чтобы не тратить бесплатные лимиты KV.
const CELL = 0.0015, WINDOW = 30 * 60e3, CACHE = 3 * 60e3, MAX_KEYS = 250;
const json = (o, status = 200) => Response.json(o, { status, headers: { 'Cache-Control': 'public, max-age=60' } });
function distM(a, b) {
  const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

export async function onRequestGet({ env }) {
  if (!env.CAMERAS) return json({ ok: false, cells: [] });
  const cached = JSON.parse((await env.CAMERAS.get('traffic')) || 'null');
  if (cached && Date.now() - cached.ts < CACHE) return json(cached);
  const list = await env.CAMERAS.list({ prefix: 'live:', limit: 1000 });
  const keys = list.keys.map(k => k.name).sort().reverse().slice(0, MAX_KEYS);   // ключ начинается со времени — свежие первыми
  const now = Date.now(), cells = new Map();
  const docs = await Promise.all(keys.map(k => env.CAMERAS.get(k)));
  let drivers = 0;
  for (const raw of docs) {
    if (!raw) continue;
    let d; try { d = JSON.parse(raw); } catch { continue; }
    if (!d.t0 || now - d.t0 > WINDOW + 3600e3) continue;
    drivers++;
    const p = d.pts || [];
    for (let i = 1; i < p.length; i++) {
      const at = d.t0 + p[i][2] * 1000; if (now - at > WINDOW) continue;
      const dt = p[i][2] - p[i - 1][2]; if (dt <= 0 || dt > 90) continue;
      const kmh = distM(p[i - 1], p[i]) / dt * 3.6; if (kmh > 140) continue;
      const k = Math.floor(p[i][1] / CELL) + ':' + Math.floor(p[i][0] / CELL);
      const c = cells.get(k) || { s: 0, n: 0, x: p[i][0], y: p[i][1] };
      c.s += kmh; c.n++; cells.set(k, c);
    }
  }
  const out = { ok: true, ts: now, drivers, cells: [...cells.values()].map(c => [+c.x.toFixed(5), +c.y.toFixed(5), Math.round(c.s / c.n), c.n]) };
  await env.CAMERAS.put('traffic', JSON.stringify(out), { expirationTtl: 3600 });
  return json(out);
}
