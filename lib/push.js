// Push-уведомления (Web Push). Без шифрования содержимого: телефон получает «пустой» сигнал,
// а текст забирает сам из «почтового ящика» (таблица push_inbox) — так проще и надёжнее.
// Ключи VAPID создаются автоматически при первом запросе и хранятся в D1 (таблица push_cfg) — вручную ничего вводить не нужно.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS push_cfg (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS push_subs (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, prefs TEXT, fr_id TEXT, city TEXT, created INTEGER, seen INTEGER, fails INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS push_inbox (n INTEGER PRIMARY KEY AUTOINCREMENT, sub TEXT, ts INTEGER, msg TEXT)`,
  `CREATE INDEX IF NOT EXISTS push_subs_fr ON push_subs (fr_id)`,
  `CREATE INDEX IF NOT EXISTS push_inbox_sub ON push_inbox (sub)`,
  `CREATE TABLE IF NOT EXISTS push_log (sub TEXT PRIMARY KEY, ts INTEGER, status INTEGER, info TEXT)`,
  `CREATE TABLE IF NOT EXISTS push_daily (sub TEXT, day TEXT, kind TEXT, val TEXT, PRIMARY KEY (sub, day, kind))`,
];
let ready = false;
export async function pushInit(db) {
  if (ready) return;
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  ready = true;
}

// куда можно отправлять: только настоящие службы push (Google, Mozilla, Apple, Microsoft)
const HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/, /(^|\.)android\.googleapis\.com$/];
export function okEndpoint(e) {
  try { const u = new URL(e); return u.protocol === 'https:' && HOSTS.some(re => re.test(u.hostname)) && e.length < 1000; } catch { return false; }
}

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = new TextEncoder();
export async function subId(endpoint) {
  return b64u(await crypto.subtle.digest('SHA-256', enc.encode(endpoint))).slice(0, 32);
}

// ключи VAPID: создаём один раз
let keys = null;
export async function vapid(db) {
  if (keys) return keys;
  await pushInit(db);
  const row = await db.prepare(`SELECT v FROM push_cfg WHERE k = 'vapid'`).first();
  let jwk, pub;
  if (row) ({ jwk, pub } = JSON.parse(row.v));
  else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
    await db.prepare(`INSERT OR IGNORE INTO push_cfg (k, v) VALUES ('vapid', ?)`).bind(JSON.stringify({ jwk, pub })).run();
    const again = await db.prepare(`SELECT v FROM push_cfg WHERE k = 'vapid'`).first();   // если два запроса пришли одновременно — берём записанный
    ({ jwk, pub } = JSON.parse(again.v));
  }
  const priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  keys = { pub, priv };
  return keys;
}

async function jwt(k, aud) {
  const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const c = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://astana-map.pages.dev' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.priv, enc.encode(h + '.' + c));
  return h + '.' + c + '.' + b64u(sig);
}

// тихие часы по Астане (UTC+5): 22:00–6:30 — только срочное (SOS)
export function quietNow(d = new Date()) { const m = ((d.getUTCHours() + 5) % 24) * 60 + d.getUTCMinutes(); return m >= 22 * 60 || m < 390; }

// последняя попытка доставки на каждый телефон — для кнопки «🩺 Проверить»
export async function logPush(db, sub, status, info) {
  try { await db.prepare('INSERT OR REPLACE INTO push_log (sub, ts, status, info) VALUES (?, ?, ?, ?)').bind(sub, Date.now(), status, String(info || '')).run(); } catch {}
}
// msg: { title, body, url, tag, urgent, kind }
export async function pushTo(db, subs, msg) {
  if (!subs?.length) return 0;
  const k = await vapid(db), now = Date.now();
  let sent = 0;
  for (const s of subs) {
    let prefs = {}; try { prefs = JSON.parse(s.prefs || '{}'); } catch {}
    if (msg.kind && prefs[msg.kind] === false) { await logPush(db, s.id, 0, 'off:' + msg.kind); continue; }
    if (!msg.urgent && prefs.quiet !== false && quietNow()) { await logPush(db, s.id, 0, 'quiet'); continue; }
    await db.prepare('INSERT INTO push_inbox (sub, ts, msg) VALUES (?, ?, ?)').bind(s.id, now, JSON.stringify(msg).slice(0, 2000)).run();
    try {
      const aud = new URL(s.endpoint).origin;
      const r = await fetch(s.endpoint, { method: 'POST', headers: {
        Authorization: `vapid t=${await jwt(k, aud)}, k=${k.pub}`, TTL: String(msg.urgent ? 3600 : 6 * 3600), Urgency: msg.urgent ? 'high' : 'normal', 'Content-Length': '0',
        ...(msg.tag ? { Topic: String(msg.tag).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'map' } : {}) } });
      await logPush(db, s.id, r.status, r.ok ? 'ok ' + (msg.tag || '') : (await r.text().catch(() => '')).slice(0, 160));
      if (r.status === 404 || r.status === 410) await db.batch([db.prepare('DELETE FROM push_subs WHERE id = ?').bind(s.id), db.prepare('DELETE FROM push_inbox WHERE sub = ?').bind(s.id)]);
      else if (r.ok) { sent++; await db.prepare('UPDATE push_subs SET fails = 0 WHERE id = ?').bind(s.id).run(); }
      else await db.prepare('UPDATE push_subs SET fails = fails + 1 WHERE id = ?').bind(s.id).run();
    } catch (e) { await logPush(db, s.id, -1, String(e?.message || e).slice(0, 160)); }
  }
  await db.prepare('DELETE FROM push_inbox WHERE ts < ?').bind(now - 2 * 864e5).run();
  return sent;
}

// уведомить «своих» (семья/друзья) человека frId; ответ: сколько доставлено, у скольких включены уведомления, сколько всего своих
export async function pushFriendsOf(db, frId, msg) {
  await pushInit(db);
  const rows = await db.prepare(`SELECT s.* FROM fr_links l JOIN push_subs s ON s.fr_id = l.b WHERE l.a = ?`).bind(frId).all();
  const links = await db.prepare('SELECT COUNT(*) AS c FROM fr_links WHERE a = ?').bind(frId).first();
  const subs = rows.results || [];
  return { sent: await pushTo(db, subs, msg), subs: subs.length, friends: links?.c || 0 };
}
