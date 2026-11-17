import { inCities } from '../../lib/cities.js';
import { pushFriendsOf, pushInit as pushInitSafe, pushTo } from '../../lib/push.js';
// «Свои на карте»: семья и друзья видят друг друга — только по взаимному согласию.
// Хранится в Cloudflare D1 (привязка DB). Таблицы создаются сами при первом запросе.
// Точка хранится одна (последняя), истории нет. «Удалить всё» стирает человека целиком.
const MAX_LINKS = 30, MIN_GAP = 8e3, INVITE_DAYS = 7;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fr_users (id TEXT PRIMARY KEY, tok TEXT NOT NULL, name TEXT NOT NULL, e TEXT, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS fr_pos (id TEXT PRIMARY KEY, lng REAL, lat REAL, spd REAL, bat INTEGER, at TEXT, ts INTEGER, hide INTEGER DEFAULT 0, sos INTEGER DEFAULT 0, share INTEGER DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS fr_links (a TEXT, b TEXT, circle TEXT, created INTEGER, PRIMARY KEY (a, b))`,
  `CREATE TABLE IF NOT EXISTS fr_invites (code TEXT PRIMARY KEY, owner TEXT, circle TEXT, exp INTEGER)`,
  // 2.20.0: сообщения своим и фото
  `CREATE TABLE IF NOT EXISTS fr_msgs (n INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b TEXT, text TEXT, ts INTEGER, urgent INTEGER DEFAULT 0, read INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS fr_msgs_ab ON fr_msgs (a, b)`,
  `CREATE INDEX IF NOT EXISTS fr_msgs_b ON fr_msgs (b, read)`,
  `CREATE TABLE IF NOT EXISTS fr_photo (id TEXT PRIMARY KEY, data TEXT, v INTEGER)`,
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
      if (!inCities(lat, lng, 1)) return json({ ok: false, error: 'outside' }, 400);
      const last = await db.prepare('SELECT ts, sos, at, hide, share FROM fr_pos WHERE id = ?').bind(me.id).first();
      if (last && now - last.ts < MIN_GAP && !b.sos) return json({ ok: true, skipped: true });
      const spd = Math.max(0, Math.min(250, +b.spd || 0)), bat = Number.isFinite(+b.bat) ? Math.max(0, Math.min(100, Math.round(+b.bat))) : null;
      await db.prepare(`INSERT INTO fr_pos (id, lng, lat, spd, bat, at, ts, sos) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET lng = excluded.lng, lat = excluded.lat, spd = excluded.spd, bat = excluded.bat, at = excluded.at, ts = excluded.ts,
        sos = CASE WHEN excluded.sos > 0 THEN excluded.sos ELSE fr_pos.sos END`)
        .bind(me.id, +lng.toFixed(6), +lat.toFixed(6), Math.round(spd), bat, clean(b.at, 40) || null, now, b.sos ? now : 0).run();
      // SOS — сразу push-уведомление своим (не чаще раза в 10 минут); отвечаем, сколько дошло
      let push = null;
      if (b.sos && !(last?.sos && now - last.sos < 600e3)) {
        push = await pushFriendsOf(db, me.id, { title: `🆘 ${me.e || ''} ${me.name} просит помощи`.replace(/\s+/g, ' ').trim(), body: `${clean(b.at, 40) ? clean(b.at, 40) + ' · ' : ''}Нажмите — покажу на карте`, url: '/#fr-open', tag: 'sos-' + me.id, urgent: true, kind: 'sos' }).catch(() => ({ sent: 0, subs: 0, friends: 0, error: true }));
      } else if (b.sos) push = { repeat: true };
      // «дошёл до школы», «приехал на работу»: человек оказался у своего сохранённого места — своим уведомление (не чаще раза в 2 часа на место)
      const at = clean(b.at, 40);
      if (!b.sos && at && at !== (last?.at || '') && !((last?.hide || 0) > now) && last?.share !== 0) {
        try {
          await pushInitSafe(db);
          const key = `arr:${me.id}:${at}`, prev = await db.prepare('SELECT v FROM push_cfg WHERE k = ?').bind(key).first();
          if (!prev || now - +prev.v > 2 * 3600e3) {
            await db.prepare('INSERT OR REPLACE INTO push_cfg (k, v) VALUES (?, ?)').bind(key, String(now)).run();
            await pushFriendsOf(db, me.id, { title: `${me.e || '🙂'} ${me.name}: ${at}`, body: 'На месте. Нажмите — покажу на карте', url: '/#fr-open', tag: 'arr-' + me.id, kind: 'family' });
          }
        } catch {}
      }
      return json({ ok: true, ...(push ? { push } : {}) });
      return json({ ok: true });
    }
    case 'list': {
      const rows = await db.prepare(`SELECT u.id, u.name, u.e, l.circle, p.lng, p.lat, p.spd, p.bat, p.at, p.ts, p.hide, p.sos, p.share, ph.v AS pv,
        (SELECT COUNT(*) FROM fr_msgs m WHERE m.a = l.b AND m.b = l.a AND m.read = 0) AS unread
        FROM fr_links l JOIN fr_users u ON u.id = l.b LEFT JOIN fr_pos p ON p.id = l.b LEFT JOIN fr_photo ph ON ph.id = l.b WHERE l.a = ? ORDER BY l.circle, u.name`).bind(me.id).all();
      const items = (rows.results || []).map(r => {
        const hidden = (r.hide || 0) > now || r.share === 0;
        return { id: r.id, name: r.name, e: r.e, circle: r.circle, hidden, pv: r.pv || 0, unread: r.unread || 0,
          ...(hidden || !r.ts ? { ts: hidden ? null : r.ts || null } : { lng: r.lng, lat: r.lat, spd: r.spd, bat: r.bat, at: r.at, ts: r.ts }),
          sos: r.sos && now - r.sos < 3600e3 ? r.sos : 0 };
      });
      const mine = await db.prepare('SELECT hide, share FROM fr_pos WHERE id = ?').bind(me.id).first();
      const myPh = await db.prepare('SELECT v FROM fr_photo WHERE id = ?').bind(me.id).first();
      return json({ ok: true, me: { id: me.id, name: me.name, e: me.e, hide: mine?.hide || 0, share: mine?.share ?? 1, pv: myPh?.v || 0 }, items });
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
    case 'photo': {   // своё фото: маленькая JPEG до ~40 КБ; пусто — убрать
      const data = String(b.data || '');
      if (!data) { await db.prepare('DELETE FROM fr_photo WHERE id = ?').bind(me.id).run(); return json({ ok: true, pv: 0 }); }
      if (!/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(data) || data.length > 60000) return json({ ok: false, error: 'photo' }, 400);
      await db.prepare('INSERT OR REPLACE INTO fr_photo (id, data, v) VALUES (?, ?, ?)').bind(me.id, data, now).run();
      return json({ ok: true, pv: now });
    }
    case 'msg': {   // сообщение своему: текст до 500 знаков; «срочно» — уведомление даже ночью
      const to = String(b.to || ''), text = String(b.text || '').replace(/[<>]/g, '').trim().slice(0, 500);
      if (!text) return json({ ok: false, error: 'empty' }, 400);
      const link = await db.prepare('SELECT 1 AS x FROM fr_links WHERE a = ? AND b = ?').bind(me.id, to).first();
      if (!link) return json({ ok: false, error: 'notfriend' }, 403);
      const cnt = await db.prepare('SELECT COUNT(*) AS c FROM fr_msgs WHERE a = ? AND ts > ?').bind(me.id, now - 3600e3).first();
      if ((cnt?.c || 0) >= 60) return json({ ok: false, error: 'limit' }, 429);
      const urgent = b.urgent ? 1 : 0;
      await db.batch([
        db.prepare('INSERT INTO fr_msgs (a, b, text, ts, urgent) VALUES (?, ?, ?, ?, ?)').bind(me.id, to, text, now, urgent),
        db.prepare('DELETE FROM fr_msgs WHERE ts < ?').bind(now - 30 * 864e5),
      ]);
      let pushed = 0;
      try {
        await pushInitSafe(db);
        const subs = (await db.prepare('SELECT * FROM push_subs WHERE fr_id = ?').bind(to).all()).results || [];
        pushed = await pushTo(db, subs, { title: `${urgent ? '🔴 ' : '✉ '}${me.e || ''} ${me.name}`.replace(/\s+/g, ' ').trim(), body: text.slice(0, 160), url: '/#fr-chat=' + me.id, tag: 'msg-' + me.id, urgent: !!urgent, kind: 'msg' });
      } catch {}
      return json({ ok: true, ts: now, pushed });
    }
    case 'msgs': {   // переписка с одним человеком (последние 60), входящие — прочитаны
      const w = String(b.with || '');
      const rows = await db.prepare(`SELECT a, text, ts, urgent, read FROM fr_msgs WHERE (a = ? AND b = ?) OR (a = ? AND b = ?) ORDER BY n DESC LIMIT 60`).bind(me.id, w, w, me.id).all();
      await db.prepare('UPDATE fr_msgs SET read = 1 WHERE a = ? AND b = ? AND read = 0').bind(w, me.id).run();
      return json({ ok: true, items: (rows.results || []).reverse().map(r => ({ mine: r.a === me.id, text: r.text, ts: r.ts, urgent: !!r.urgent, read: !!r.read })) });
    }
    case 'wipe': {
      await db.batch([
        db.prepare('DELETE FROM fr_msgs WHERE a = ? OR b = ?').bind(me.id, me.id),
        db.prepare('DELETE FROM fr_photo WHERE id = ?').bind(me.id),
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

// фото: /api/friends?photo=ID — картинка (кэшируется, версия в ?v=)
export async function onRequestGet({ request, env }) {
  const id = new URL(request.url).searchParams.get('photo');
  if (!id) return json({ ok: !!env.DB });
  if (!env.DB) return new Response('', { status: 503 });
  await init(env.DB);
  const r = await env.DB.prepare('SELECT data FROM fr_photo WHERE id = ?').bind(String(id).slice(0, 16)).first();
  const m = r?.data?.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!m) return new Response('', { status: 404 });
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=604800' } });
}
