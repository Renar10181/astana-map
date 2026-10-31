// Перевод для Барыса и интерфейса: ru → kk (когда выбран қазақша) и ru → en (для иностранцев).
// Та же бесплатная привязка Workers AI, что у ассистента: AI_BARYS.
// Одиночный текст: { text, to }  →  { ok, text }
// Пачка строк интерфейса: { items:[...], to }  →  { ok, items:[...] }
const json = (o, status = 200) => Response.json(o, { status, headers: { 'Cache-Control': 'no-store' } });
const MODELS = ['@cf/qwen/qwen3-30b-a3b-fp8', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];
const hits = new Map();

const SYS = {
  kk: 'Ты переводчик. Переведи текст пользователя с русского на казахский язык (кириллица, литературный, простой разговорный стиль). Названия мест, улиц, брендов, числа, цены в ₸ и эмодзи оставь как есть. Термины: парковка — тұрақ, платная — ақылы, пробка — кептеліс, заправка/АЗС — ЖҚС, остановка — аялдама, светофор — бағдаршам, поворот налево — солға бұрылу, маршрут — маршрут, пешком — жаяу, район — аудан.',
  en: 'You are a translator for a navigation app in Astana, Kazakhstan. Translate the user text from Russian (or Kazakh) to natural, short, friendly English. Keep emoji, numbers, prices in ₸ and units. Transliterate place, street and brand names in Latin letters (Хан Шатыр → Khan Shatyr, Байтерек → Baiterek, проспект Абая → Abay Avenue, улица → Street). Terms: АЗС — gas station, парковка — parking, пробка — traffic jam, остановка — bus stop, светофор — traffic light, Барыс — Barys.',
};

async function run(AI, messages, max) {
  for (const model of MODELS) {
    try {
      const r = await AI.run(model, { messages, max_tokens: max, temperature: 0.2 });
      const out = String(r?.response ?? r?.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (out) return out;
    } catch { /* следующая модель */ }
  }
  return '';
}

export async function onRequestPost({ request, env }) {
  const AI = env.AI_BARYS || env.AI;
  if (!AI) return json({ ok: false, error: 'no_ai' }, 503);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 3600e3); h.push(now); hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  if (h.length > 150) return json({ ok: false, error: 'limit' }, 429);
  let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
  const to = b.to === 'en' ? 'en' : 'kk';

  if (Array.isArray(b.items)) {
    const items = b.items.map(x => String(x || '').slice(0, 300)).slice(0, 40);
    if (!items.length || items.join('').length > 5000) return json({ ok: false }, 400);
    const out = await run(AI, [
      { role: 'system', content: SYS[to] + ' The user sends a JSON array of interface strings. Return ONLY a JSON array of the same length with translations in the same order, nothing else.' },
      { role: 'user', content: JSON.stringify(items) + ' /no_think' },
    ], 2500);
    const m = out.match(/\[[\s\S]*\]/);
    try { const arr = JSON.parse(m[0]); if (Array.isArray(arr) && arr.length === items.length) return json({ ok: true, items: arr.map(String) }); } catch {}
    return json({ ok: false, error: 'ai_failed' }, 502);
  }

  const text = String(b.text || '').slice(0, 600).trim();
  if (!text) return json({ ok: false }, 400);
  let out = await run(AI, [
    { role: 'system', content: SYS[to] + ' Верни ТОЛЬКО перевод, без пояснений и кавычек. / Return ONLY the translation.' },
    { role: 'user', content: text + ' /no_think' },
  ], 400);
  out = out.replace(/^["«]|["»]$/g, '').trim();
  if (out && out.length < text.length * 3 + 20) return json({ ok: true, text: out });
  return json({ ok: false, error: 'ai_failed' }, 502);
}
