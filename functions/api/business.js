// Организации, которые добавили сами владельцы. Хранится в Cloudflare KV (привязка CAMERAS), ключ «biz».
// GET  /api/business               — публичный список (без контактов для связи)
// POST /api/business               — добавить или обновить карточку (до 5 в день с одного адреса)
// GET  /api/business?admin=КЛЮЧ    — всё, включая заявки на продвижение (ключ — Secret ADMIN_KEY в Cloudflare)
// PATCH/DELETE ?admin=КЛЮЧ         — изменить продвижение (promo: none|priority|logo, до даты) или удалить
// Рекламные форматы (2.6): ads = { objav, premium, navlogo, stopbanner, routebb, billboard, stories: { until, text, img, radius } }
//   PATCH { id, ad:'objav', until, text, img, radius }  — включить формат;  { id, ad:'objav', off:true } — выключить
//   PATCH { id, pack:'lite'|'start'|'media', until, text } — включить пакет (несколько форматов сразу)
const BOX = { w: 70.95, s: 50.85, e: 71.95, n: 51.40 };
const PER_DAY = 5, MAX = 5000;
const json = (o, status = 200) => Response.json(o, { status, headers: { 'Cache-Control': 'no-store' } });
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function voter(request) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('astana-map:' + ip));
  return [...new Uint8Array(d)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
}
const load = async env => JSON.parse((await env.CAMERAS.get('biz')) || '{"items":[],"day":{"d":"","c":{}}}');
const isAdmin = (url, env) => env.ADMIN_KEY && new URL(url).searchParams.get('admin') === env.ADMIN_KEY;
const promoOn = x => x.promo && x.promo !== 'none' && (!x.until || x.until > Date.now());
// [lng, lat, name, cat, addr, phone, web, "biz", hours, desc, id, promo]
const FORMATS = ['objav', 'premium', 'navlogo', 'stopbanner', 'routebb', 'billboard', 'stories'];
const PACKS = { lite:['objav'], start:['objav', 'navlogo'], media:['objav', 'navlogo', 'premium', 'stopbanner'] };
const PACK_PROMO = { lite:'priority', start:'logo', media:'logo' };
const WANTS = ['priority', 'logo', ...FORMATS, 'lite', 'start', 'media'];
// активные рекламные форматы — для показа в приложении
const adsOf = items => items.filter(x => !x.hidden && x.ads).flatMap(x => Object.entries(x.ads)
  .filter(([f, a]) => FORMATS.includes(f) && a && (!a.until || a.until > Date.now()))
  .map(([f, a]) => ({ id:x.id, f, lng:x.lng, lat:x.lat, name:x.name, cat:x.cat, phone:x.phone, web:x.web, addr:x.addr, text:a.text || x.adText || x.desc || '', img:a.img || '', radius:a.radius || 0 })));
const pub = x => [x.lng, x.lat, x.name, x.cat, x.addr, x.phone, x.web, 'biz', x.hours, x.desc, x.id, promoOn(x) ? x.promo : ''];

export async function onRequestGet({ request, env }) {
  if (!env.CAMERAS) return json({ ok: false, items: [] });
  const db = await load(env);
  if (isAdmin(request.url, env)) return json({ ok: true, admin: true, items: db.items });
  return json({ ok: true, items: db.items.filter(x => !x.hidden).map(pub), ads: adsOf(db.items) });
}

export async function onRequestPost({ request, env }) {
  if (!env.CAMERAS) return json({ ok: false, error: 'storage not configured' }, 503);
  let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
  const lat = +b.lat, lng = +b.lng, name = str(b.name, 80);
  if (!name || name.length < 2) return json({ ok: false, error: 'name' }, 400);
  if (!(lat > BOX.s && lat < BOX.n && lng > BOX.w && lng < BOX.e)) return json({ ok: false, error: 'outside Astana' }, 400);
  if (/https?:\/\/\S+\s+https?:\/\//i.test(b.desc || '')) return json({ ok: false, error: 'spam' }, 400);
  const db = await load(env), who = await voter(request), d = new Date().toISOString().slice(0, 10);
  // владелец — по секретному ключу из его телефона (IP у мобильного меняется), иначе по хэшу адреса
  const owner = typeof b.token === 'string' && b.token.length >= 16 ? await sha('owner:' + b.token) : who;
  if (db.day.d !== d) db.day = { d, c: {} };
  if ((db.day.c[who] || 0) >= PER_DAY) return json({ ok: false, error: 'limit' }, 429);
  const item = {
    id: str(b.id, 16) || crypto.randomUUID().slice(0, 10), name, lng: +lng.toFixed(6), lat: +lat.toFixed(6),
    cat: str(b.cat, 40), addr: str(b.addr, 120), phone: str(b.phone, 30), web: str(b.web, 120),
    hours: str(b.hours, 80), desc: str(b.desc, 300), want: WANTS.includes(b.want) ? b.want : '', adText: str(b.adText, 70), adImg: /^https:\/\/\S+$/.test(String(b.adImg || '')) ? str(b.adImg, 300) : '',
    contact: str(b.contact, 60), owner, ts: Date.now(), promo: 'none',
  };
  const i = db.items.findIndex(x => x.id === item.id);
  if (i >= 0) {
    if (db.items[i].owner !== owner) return json({ ok: false, error: 'not owner' }, 403);
    item.promo = db.items[i].promo; item.until = db.items[i].until; item.ads = db.items[i].ads;
    db.items[i] = item;
  } else {
    if (db.items.length >= MAX) return json({ ok: false, error: 'full' }, 507);
    db.items.push(item);
  }
  db.day.c[who] = (db.day.c[who] || 0) + 1;
  await env.CAMERAS.put('biz', JSON.stringify(db));
  return json({ ok: true, id: item.id, item: pub(item) });
}

export async function onRequestPatch({ request, env }) {
  if (!env.CAMERAS || !isAdmin(request.url, env)) return json({ ok: false }, 403);
  let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
  const db = await load(env), x = db.items.find(y => y.id === b.id);
  if (!x) return json({ ok: false, error: 'not found' }, 404);
  if (['none', 'priority', 'logo'].includes(b.promo)) x.promo = b.promo;
  if (b.until !== undefined) x.until = +b.until || 0;
  if (b.hidden !== undefined) x.hidden = !!b.hidden;
  const until = +b.until || 0, text = b.text !== undefined ? str(b.text, 70) : undefined;
  const img = /^https:\/\/\S+$/.test(String(b.img || '')) ? str(b.img, 300) : '';
  if (FORMATS.includes(b.ad)) {
    x.ads = x.ads || {};
    if (b.off) delete x.ads[b.ad];
    else x.ads[b.ad] = { until, text: text ?? x.adText ?? '', img: img || x.adImg || '', radius: Math.min(5000, Math.max(0, +b.radius || 0)) };
  }
  if (PACKS[b.pack]) {
    x.ads = x.ads || {};
    PACKS[b.pack].forEach(f => { x.ads[f] = { until, text: text ?? x.adText ?? '', img: img || x.adImg || '', radius: 0 }; });
    x.promo = PACK_PROMO[b.pack]; x.until = until;
  }
  if (b.promo === 'none' && b.clearAds) x.ads = {};
  await env.CAMERAS.put('biz', JSON.stringify(db));
  return json({ ok: true, item: x });
}

export async function onRequestDelete({ request, env }) {
  if (!env.CAMERAS || !isAdmin(request.url, env)) return json({ ok: false }, 403);
  const id = new URL(request.url).searchParams.get('id');
  const db = await load(env), n = db.items.length;
  db.items = db.items.filter(x => x.id !== id);
  await env.CAMERAS.put('biz', JSON.stringify(db));
  return json({ ok: true, removed: n - db.items.length });
}
