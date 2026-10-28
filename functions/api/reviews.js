// Отзывы о местах: оценка 1–5 и текст. Хранится в Cloudflare KV (привязка CAMERAS), ключ «rev:<id места>».
// Один отзыв от одного человека на место (можно изменить). Ссылки и мат не пропускаем. Удалить — DELETE ?admin=КЛЮЧ&id=&n=.
const json = (o, status = 200) => Response.json(o, { status, headers: { 'Cache-Control': 'no-store' } });
const BAD = /(х[уy][йеёяю]|пизд|еба[нлт]|ебл|бля[дт]?|сука|мудак|пидор|залуп|шлюх)/i;
async function voter(request) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('astana-map:' + ip));
  return [...new Uint8Array(d)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
}
const okId = id => /^[a-z0-9_-]{4,40}$/i.test(id || '');
function summary(list) {
  const n = list.length, avg = n ? list.reduce((s, x) => s + x.r, 0) / n : 0;
  return { n, avg: Math.round(avg * 10) / 10, items: list.slice().sort((a, b) => b.ts - a.ts).slice(0, 30).map(({ who, ...x }) => x) };
}

export async function onRequestGet({ request, env }) {
  const id = new URL(request.url).searchParams.get('id');
  if (!env.CAMERAS || !okId(id)) return json({ ok: false, n: 0, avg: 0, items: [] });
  const list = JSON.parse((await env.CAMERAS.get('rev:' + id)) || '[]');
  return json({ ok: true, ...summary(list) });
}

export async function onRequestPost({ request, env }) {
  if (!env.CAMERAS) return json({ ok: false, error: 'storage not configured' }, 503);
  let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
  const id = String(b.id || ''), r = Math.round(+b.r);
  const t = String(b.t || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!okId(id) || !(r >= 1 && r <= 5)) return json({ ok: false, error: 'bad request' }, 400);
  if (/https?:\/\/|www\.|t\.me\//i.test(t)) return json({ ok: false, error: 'links' }, 400);
  if (BAD.test(t)) return json({ ok: false, error: 'words' }, 400);
  const who = await voter(request), key = 'rev:' + id;
  const list = JSON.parse((await env.CAMERAS.get(key)) || '[]').filter(x => x.who !== who);
  list.push({ r, t, ts: Date.now(), who });
  await env.CAMERAS.put(key, JSON.stringify(list.slice(-300)));
  return json({ ok: true, ...summary(list) });
}

export async function onRequestDelete({ request, env }) {
  const u = new URL(request.url), id = u.searchParams.get('id'), ts = +u.searchParams.get('ts');
  if (!env.CAMERAS || !env.ADMIN_KEY || u.searchParams.get('admin') !== env.ADMIN_KEY || !okId(id)) return json({ ok: false }, 403);
  const key = 'rev:' + id, list = JSON.parse((await env.CAMERAS.get(key)) || '[]');
  await env.CAMERAS.put(key, JSON.stringify(list.filter(x => x.ts !== ts)));
  return json({ ok: true });
}
