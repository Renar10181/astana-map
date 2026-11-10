import { pushInit, okEndpoint, subId, vapid, pushTo } from '../../lib/push.js';
// Push-уведомления: подписка, настройки, проверочное, «почтовый ящик» для телефона.
// Хранится в Cloudflare D1 (привязка DB). Подписку определяет её адрес (endpoint) — он известен только этому телефону.
const json = (o, st = 200) => Response.json(o, { status: st, headers: { 'Cache-Control': 'no-store' } });
const KINDS = ['sos', 'family', 'leave', 'weather', 'parking', 'fuel', 'city', 'quests', 'here'];
const cleanPrefs = p => {
  const o = {}; KINDS.forEach(k => { if (typeof p?.[k] === 'boolean') o[k] = p[k]; });
  if (typeof p?.quiet === 'boolean') o.quiet = p.quiet;
  if (p?.home && Number.isFinite(+p.home.lat)) o.home = { lat: +(+p.home.lat).toFixed(4), lng: +(+p.home.lng).toFixed(4) };
  if (p?.work && Number.isFinite(+p.work.lat)) o.work = { lat: +(+p.work.lat).toFixed(4), lng: +(+p.work.lng).toFixed(4) };
  if (/^\d{1,2}:\d{2}$/.test(p?.workAt || '')) o.workAt = p.workAt;
  return o;
};

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ ok: false, error: 'no_db' }, 503);
  const k = await vapid(env.DB);
  return json({ ok: true, key: k.pub });
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: 'no_db' }, 503);
  let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
  await pushInit(db);
  const endpoint = String(b.endpoint || b.sub?.endpoint || '');
  if (!okEndpoint(endpoint)) return json({ ok: false, error: 'endpoint' }, 400);
  const id = await subId(endpoint), now = Date.now();

  switch (String(b.act || '')) {
    case 'sub': {
      let frId = null;
      if (b.fr?.id && b.fr?.tok) {
        const u = await db.prepare('SELECT id FROM fr_users WHERE id = ? AND tok = ?').bind(String(b.fr.id), String(b.fr.tok)).first().catch(() => null);
        frId = u?.id || null;
      }
      await db.prepare(`INSERT INTO push_subs (id, endpoint, prefs, fr_id, city, created, seen, fails) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(id) DO UPDATE SET prefs = excluded.prefs, fr_id = COALESCE(excluded.fr_id, push_subs.fr_id), city = excluded.city, seen = excluded.seen`)
        .bind(id, endpoint, JSON.stringify(cleanPrefs(b.prefs)), frId, String(b.city || '').slice(0, 12), now, now).run();
      const n = await db.prepare('SELECT COUNT(*) AS c FROM push_subs').first();
      return json({ ok: true, fr: !!frId, total: n?.c || 0 });
    }
    case 'unsub': {
      await db.batch([db.prepare('DELETE FROM push_subs WHERE id = ?').bind(id), db.prepare('DELETE FROM push_inbox WHERE sub = ?').bind(id)]);
      return json({ ok: true });
    }
    case 'test': {
      const s = await db.prepare('SELECT * FROM push_subs WHERE id = ?').bind(id).first();
      if (!s) return json({ ok: false, error: 'nosub' }, 404);
      const sent = await pushTo(db, [s], { title: '🔔 Уведомления работают', body: 'Барыс будет присылать только полезное: не больше 1–2 раз в день, ночью — только SOS.', url: '/', tag: 'test', urgent: true });
      return json({ ok: sent > 0, sent });
    }
    case 'inbox': {   // телефон получил сигнал — забирает тексты
      const rows = await db.prepare('SELECT n, msg FROM push_inbox WHERE sub = ? ORDER BY n').bind(id).all();
      const items = (rows.results || []).map(r => { try { return JSON.parse(r.msg); } catch { return null; } }).filter(Boolean);
      if (items.length) await db.prepare('DELETE FROM push_inbox WHERE sub = ? AND n <= ?').bind(id, rows.results.at(-1).n).run();
      await db.prepare('UPDATE push_subs SET seen = ? WHERE id = ?').bind(now, id).run();
      return json({ ok: true, items });
    }
  }
  return json({ ok: false, error: 'act' }, 400);
}
