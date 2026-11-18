// Защита API (выпуск Г, 18.11.2026): ограничение частоты запросов с одного адреса и запрет записи с чужих сайтов.
// Счётчики живут в памяти сервера Cloudflare (на каждом узле свои) — это не броня, но отсекает спам-скрипты
// и не даёт выжечь бесплатные лимиты (запись в KV — 1000 в сутки, Azure-озвучка, ИИ).
const ORIGINS = /^https:\/\/([a-z0-9-]+\.)?astana-map\.pages\.dev$|^http:\/\/localhost(:\d+)?$/;
const hits = new Map();

export function ipOf(request) { return request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'local'; }

// true — превышен лимит: max запросов за windowMs с одного адреса в «ведре» bucket
export function limited(request, bucket, max, windowMs = 60e3) {
  const k = bucket + ':' + ipOf(request), now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(k, arr);
  if (hits.size > 20000) hits.clear();
  return arr.length > max;
}

// запись разрешена только со страниц самой карты (браузер всегда шлёт Origin при POST/DELETE)
export function foreign(request) {
  const o = request.headers.get('Origin');
  return !!o && !ORIGINS.test(o);
}

export async function ipHash(request, salt = 'astana-map') {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + ipOf(request)));
  return [...new Uint8Array(d)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
}

// сравнение ключа без утечки по времени
export function sameKey(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export function adminKey(request) { return request.headers.get('X-Admin-Key') || new URL(request.url).searchParams.get('admin') || ''; }

export const tooMany = () => Response.json({ ok: false, error: 'limit' }, { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } });
export const forbidden = () => Response.json({ ok: false, error: 'origin' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
