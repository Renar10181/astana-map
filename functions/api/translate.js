// Перевод ответов Барыса на казахский (когда в приложении выбран қазақша).
// Та же бесплатная привязка Workers AI, что у ассистента: AI_BARYS.
const json = (o, status = 200) => Response.json(o, { status, headers: { 'Cache-Control': 'no-store' } });
const MODELS = ['@cf/qwen/qwen3-30b-a3b-fp8', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];
const hits = new Map();

export async function onRequestPost({ request, env }) {
  const AI = env.AI_BARYS || env.AI;
  if (!AI) return json({ ok: false, error: 'no_ai' }, 503);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 3600e3); h.push(now); hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  if (h.length > 120) return json({ ok: false, error: 'limit' }, 429);
  let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
  const text = String(b.text || '').slice(0, 600).trim();
  if (!text) return json({ ok: false }, 400);
  const messages = [
    { role: 'system', content: 'Ты переводчик. Переведи текст пользователя с русского на казахский язык (кириллица, литературный, простой разговорный стиль). Названия мест, улиц, брендов, числа, цены в ₸ и эмодзи оставь как есть. Верни ТОЛЬКО перевод, без пояснений и кавычек.' },
    { role: 'user', content: text + ' /no_think' },
  ];
  for (const model of MODELS) {
    try {
      const r = await AI.run(model, { messages, max_tokens: 400, temperature: 0.2 });
      let out = String(r?.response ?? r?.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      out = out.replace(/^["«]|["»]$/g, '').trim();
      if (out && out.length < text.length * 3) return json({ ok: true, text: out });
    } catch { /* следующая модель */ }
  }
  return json({ ok: false, error: 'ai_failed' }, 502);
}
