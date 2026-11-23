// Кабинет бизнеса (выпуск Д, 23.11.2026): сколько раз карточку открыли, позвонили, построили маршрут, перешли на сайт, нажали «Записаться».
// POST /api/bizstats {id, k}         — +1 к счётчику дня (без cookies и IP)
// GET  /api/bizstats?id=… (заголовок X-Biz-Token) — статистика за 30 дней; только владелец (секретный ключ из его телефона)
const KINDS = new Set(['view', 'call', 'route', 'web', 'book']);
const json = (d, s = 200) => Response.json(d, { status: s, headers: { 'Cache-Control': 'no-store' } });
const day = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const okId = id => /^[a-z0-9-]{4,16}$/i.test(id || '');
async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}
const init = db => db.prepare('CREATE TABLE IF NOT EXISTS bizstats (d TEXT, id TEXT, k TEXT, n INTEGER, PRIMARY KEY (d, id, k))').run();

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: true, off: true });
  let b = {}; try { b = await request.json(); } catch {}
  const id = String(b.id || ''), k = String(b.k || '');
  if (!okId(id) || !KINDS.has(k)) return json({ ok: false }, 400);
  await init(env.DB);
  await env.DB.prepare('INSERT INTO bizstats (d, id, k, n) VALUES (?, ?, ?, 1) ON CONFLICT(d, id, k) DO UPDATE SET n = n + 1').bind(day(), id, k).run();
  return json({ ok: true });
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url), id = u.searchParams.get('id') || '', token = request.headers.get('X-Biz-Token') || '';
  if (!env.DB || !env.CAMERAS || !okId(id) || token.length < 16) return json({ ok: false }, 403);
  const db = JSON.parse((await env.CAMERAS.get('biz')) || '{"items":[]}');
  const it = (db.items || []).find(x => x.id === id);
  if (!it || it.owner !== await sha('owner:' + token)) return json({ ok: false, error: 'not owner' }, 403);
  await init(env.DB);
  const { results } = await env.DB.prepare("SELECT d, k, n FROM bizstats WHERE id = ? AND d >= date('now', '-30 day') ORDER BY d").bind(id).all();
  const total = {}, days = {};
  for (const r of results || []) { total[r.k] = (total[r.k] || 0) + r.n; (days[r.d] ||= {})[r.k] = r.n; }
  return json({ ok: true, name: it.name, total, days });
}
