// Своя анонимная аналитика (выпуск Г, 18.11.2026): без cookies, без IP, без сторонних сервисов.
// POST /api/stats {e:'open'|'route'|..., c:'astana'|'oral', l:'ru'|'kk'|'en', pwa:0|1} — +1 к счётчику дня
// GET  /api/stats (заголовок X-Admin-Key) — счётчики за 30 дней
import { sameKey, adminKey } from '../../lib/guard.js';

const EVENTS = new Set(['open', 'route', 'nav', 'search', 'voice', 'sos', 'push_on', 'fr_msg', 'here', 'taxi', 'offline', 'install']);
const json = (d, s = 200) => Response.json(d, { status: s, headers: { 'Cache-Control': 'no-store' } });
const day = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10); // время Астаны

async function init(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS stats (d TEXT, k TEXT, n INTEGER, PRIMARY KEY (d, k))').run();
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: true, off: true });
  let b = {}; try { b = await request.json(); } catch {}
  const e = String(b.e || ''); if (!EVENTS.has(e)) return json({ ok: false }, 400);
  const keys = ['e:' + e];
  if (e === 'open') {
    if (['astana', 'oral'].includes(b.c)) keys.push('c:' + b.c);
    if (['ru', 'kk', 'en'].includes(b.l)) keys.push('l:' + b.l);
    keys.push(b.pwa ? 'pwa:1' : 'pwa:0');
  }
  await init(env.DB);
  const d = day();
  await env.DB.batch(keys.map(k => env.DB.prepare('INSERT INTO stats (d, k, n) VALUES (?, ?, 1) ON CONFLICT(d, k) DO UPDATE SET n = n + 1').bind(d, k)));
  return json({ ok: true });
}

export async function onRequestGet({ request, env }) {
  if (!env.DB || !env.ADMIN_KEY || !sameKey(adminKey(request), env.ADMIN_KEY)) return json({ ok: false }, 403);
  await init(env.DB);
  const { results } = await env.DB.prepare("SELECT d, k, n FROM stats WHERE d >= date('now', '-30 day') ORDER BY d DESC, k").all();
  const out = {};
  for (const r of results || []) (out[r.d] ||= {})[r.k] = r.n;
  return json({ ok: true, days: out });
}
