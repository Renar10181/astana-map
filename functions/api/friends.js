// «Свои на карте»: семья и друзья видят друг друга — только по взаимному согласию.
// Хранится в Cloudflare D1 (привязка DB). Таблицы создаются сами при первом запросе.
// Точка хранится одна (последняя), истории нет. «Удалить всё» стирает человека целиком.
const BOX = { w: 70.0, s: 50.0, e: 73.5, n: 52.5 };   // Астана с запасом (дачи, трасса)
const MAX_LINKS = 30, MIN_GAP = 8e3, INVITE_DAYS = 7;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fr_users (id TEXT PRIMARY KEY, tok TEXT NOT NULL, name TEXT NOT NULL, e TEXT, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS fr_pos (id TEXT PRIMARY KEY, lng REAL, lat REAL, spd REAL, bat INTEGER, at TEXT, ts INTEGER, hide INTEGER DEFAULT 0, sos INTEGER DEFAULT 0, share INTEGER DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS fr_links (a TEXT, b TEXT, circle TEXT, created INTEGER, PRIMARY KEY (a, b))`,
  `CREATE TABLE IF NOT EXISTS fr_invites (code TEXT PRIMARY KEY, owner TEXT, circle TEXT, exp INTEGER)`,
];
let ready = false;
async function init(db) {
  if (ready) return;
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  ready = true;
}
const rnd = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
const clean = (s, n) => String(s || '').replace(/[<>"]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const json = (o, st = 200) => Response.json(o, { status: st, headers: { 'Cache-Control': 'no-store' } });
const CIRCLES = ['family', 'friends'];

async function auth(db, b) {
  const id = String(b.id || ''), tok = String(b.tok || '');
  if (!id || !tok) return null;
  const u = await db.prepare('SELECT id, name, e FROM fr_users WHERE id = ? AND tok = ?').bind(id, tok).first();
  return u || null;
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: 'no_db' }, 503);
  let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
  await init(db);
  const now = Date.now(), act = String(b.act || '');

  if (act === 'reg') {
    const name = clean(b.name, 24); if (name.length < 2) return json({ ok: false, error: 'name' }, 400);
    const id = rnd(10), tok = rnd(24);
    await db.batch([
      db.prepare('INSERT INTO fr_users (id, tok, name, e, created) VALUES (?, ?, ?, ?, ?)').bind(id, tok, name, clean(b.e, 4) || '🙂', now),
      db.prepare('INSERT INTO fr_pos (id, ts) VALUES (?, 0)').bind(id),
    ]);
    return json({ ok: true, id, tok });
  }

  const me = await auth(db, b);
  if (!me) return json({ ok: false, error: 'auth' }, 401);

  switch (act) {
    case 'profile': {
      const name = clean(b.name, 24); if (name.length < 2) return json({ ok: false, error: 'name' }, 400);
      await db.prepare('UPDATE fr_users SET name = ?, e = ? WHERE id = ?').bind(name, clean(b.e, 4) || '🙂', me.id).run();
      return json({ ok: true });
    }
    case 'invite': {
      const circle = CIRCLES.includes(b.circle) ? b.circle : 'friends', code = rnd(8);
      await db.batch([
        db.prepare('DELETE FROM fr_invites WHERE exp < ?').bind(now),
        db.prepare('INSERT INTO fr_invites (code, owner, circle, exp) VALUES (?, ?, ?, ?)').bind(code, me.id, circle, now + INVITE_DAYS * 864e5),
      ]);
      return json({ ok: true, code, days: INVITE_DAYS });
    }
    case 'peek': {   // кто приглашает — до согласия
      const inv = await db.prepare('SELECT i.owner, i.circle, u.name, u.e FROM fr_invites i JOIN fr_users u ON u.id = i.owner WHERE i.code = ? AND i.exp > ?').bind(String(b.code || ''), now).first();
      return inv ? json({ ok: true, name: inv.name, e: inv.e, circle: inv.circle, self: inv.owner === me.id }) : json({ ok: false, error: 'expired' }, 404);
    }
    case 'accept': {
      const inv = await db.prepare('SELECT owner, circle FROM fr_invites WHERE code = ? AND exp > ?').bind(String(b.code || ''), now).first();
      if (!inv) return json({ ok: false, error: 'expired' }, 404);
      if (inv.owner === me.id) return json({ ok: false, error: 'self' }, 400);
      const n = await db.prepare('SELECT COUNT(*) AS c FROM fr_links WHERE a = ?').bind(me.id).first();
      if ((n?.c || 0) >= MAX_LINKS) return json({ ok: false, error: 'limit' }, 400);
      await db.batch([
        db.prepare('INSERT OR REPLACE INTO fr_links (a, b, circle, created) VALUES (?, ?, ?, ?)').bind(me.id, inv.owner, inv.circle, now),
        db.prepare('INSERT OR REPLACE INTO fr_links (a, b, circle, created) VALUES (?, ?, ?, ?)').bind(inv.owner, me.id, inv.circle, now),
      ]);
      return json({ ok: true });
    }
    case 'pos': {
      const lng = +b.lng, lat = +b.lat;
      if (!(lat > BOX.s && lat < BOX.n && lng > BOX.w && lng < BOX.e)) return json({ ok: false, error: 'outside' }, 400);
      const last = await db.prepare('SELECT ts FROM fr_pos WHERE id = ?').bind(me.id).first();
      if (last && now - last.ts < MIN_GAP && !b.sos) return json({ ok: true, skipped: true });
      const spd = Math.max(0, Math.min(250, +b.spd || 0)), bat = Number.isFinite(+b.bat) ? Math.max(0, Math.min(100, Math.round(+b.bat))) : null;
      await db.prepare(`INSERT INTO fr_pos (id, lng, lat, spd, bat, at, ts, sos) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET lng = excluded.lng, lat = excluded.lat, spd = excluded.spd, bat = excluded.bat, at = excluded.at, ts = excluded.ts,
        sos = CASE WHEN excluded.sos > 0 THEN excluded.sos ELSE fr_pos.sos END`)
        .bind(me.id, +lng.toFixed(6), +lat.toFixed(6), Math.round(spd), bat, clean(b.at, 40) || null, now, b.sos ? now : 0).run();
      return json({ ok: true });
    }
    case 'list': {
      const rows = await db.prepare(`SELECT u.id, u.name, u.e, l.circle, p.lng, p.lat, p.spd, p.bat, p.at, p.ts, p.hide, p.sos, p.share
        FROM fr_links l JOIN fr_users u ON u.id = l.b LEFT JOIN fr_pos p ON p.id = l.b WHERE l.a = ? ORDER BY l.circle, u.name`).bind(me.id).all();
      const items = (rows.results || []).map(r => {
        const hidden = (r.hide || 0) > now || r.share === 0;
        return { id: r.id, name: r.name, e: r.e, circle: r.circle, hidden,
          ...(hidden || !r.ts ? { ts: hidden ? null : r.ts || null } : { lng: r.lng, lat: r.lat, spd: r.spd, bat: r.bat, at: r.at, ts: r.ts }),
          sos: r.sos && now - r.sos < 3600e3 ? r.sos : 0 };
      });
      const mine = await db.prepare('SELECT hide, share FROM fr_pos WHERE id = ?').bind(me.id).first();
      return json({ ok: true, me: { name: me.name, e: me.e, hide: mine?.hide || 0, share: mine?.share ?? 1 }, items });
    }
    case 'hide': {
      const until = Math.max(0, Math.min(+b.until || 0, now + 400 * 864e5));
      await db.prepare('UPDATE fr_pos SET hide = ? WHERE id = ?').bind(until, me.id).run();
      return json({ ok: true, hide: until });
    }
    case 'share': {
      await db.prepare('UPDATE fr_pos SET share = ? WHERE id = ?').bind(b.on ? 1 : 0, me.id).run();
      return json({ ok: true });
    }
    case 'sosoff': {
      await db.prepare('UPDATE fr_pos SET sos = 0 WHERE id = ?').bind(me.id).run();
      return json({ ok: true });
    }
    case 'remove': {
      const f = String(b.fid || '');
      await db.batch([
        db.prepare('DELETE FROM fr_links WHERE a = ? AND b = ?').bind(me.id, f),
        db.prepare('DELETE FROM fr_links WHERE a = ? AND b = ?').bind(f, me.id),
      ]);
      return json({ ok: true });
    }
    case 'wipe': {
      await db.batch([
        db.prepare('DELETE FROM fr_links WHERE a = ? OR b = ?').bind(me.id, me.id),
        db.prepare('DELETE FROM fr_invites WHERE owner = ?').bind(me.id),
        db.prepare('DELETE FROM fr_pos WHERE id = ?').bind(me.id),
        db.prepare('DELETE FROM fr_users WHERE id = ?').bind(me.id),
      ]);
      return json({ ok: true });
    }
  }
  return json({ ok: false, error: 'act' }, 400);
}

export const onRequestGet = ({ env }) => json({ ok: !!env.DB });
