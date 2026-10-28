// Голосовой ассистент «Эй, Барыс» — понимание сложных фраз через Cloudflare Workers AI.
// Простые команды («домой», «найди заправку») приложение разбирает само, без этого сервера.
// Нужна привязка Workers AI с именем AI: Pages → Settings → Bindings → Add → Workers AI.
// Бесплатно ~10 000 «нейронов» в сутки ≈ 500 запросов.

const MODELS = ['@cf/qwen/qwen3-30b-a3b-fp8', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];
const CATS = ['fuel', 'ev', 'food', 'cafe', 'pharm', 'shop', 'atm', 'park', 'wash', 'tyre', 'wc'];
const EVENTS = ['accident', 'jam', 'works', 'closed', 'police', 'pothole', 'danger', 'ice', 'snow'];
const ACTIONS = ['route_to', 'find_category', 'report', 'eta', 'weather', 'taxi', 'start_nav', 'stop_nav', 'my_car', 'quests', 'about', 'open_now', 'where_am_i', 'fuel_price', 'events_ahead', 'nearby', 'facts', 'none'];

// грубое ограничение: не больше 40 запросов в час с одного адреса (в памяти воркера)
const hits = new Map();
function limited(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  h.push(now); hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.length > 40;
}

function prompt(lang, ctx) {
  return `Ты — Барыс, весёлый барсёнок-помощник в навигаторе «Карта Астаны» (город Астана, Казахстан).
Пользователь говорит голосом${ctx.driving ? ' и сейчас ЗА РУЛЁМ — отвечай очень коротко' : ''}.
Отвечай на языке пользователя (${lang === 'kk' ? 'казахский' : 'русский'}), не длиннее 20 слов.
Верни ТОЛЬКО JSON без пояснений: {"say":"фраза для озвучки","action":"<действие>","args":{...}}
Действия:
- route_to {"query":"куда ехать, как сказал пользователь"} — построить маршрут к месту или адресу
- find_category {"cat":"${CATS.join('|')}"} — найти рядом или по пути (fuel=АЗС, ev=зарядка, food=еда, cafe=кофе, pharm=аптека, shop=продукты, atm=банкомат, park=парковка, wash=мойка, tyre=шиномонтаж, wc=туалет)
- report {"type":"${EVENTS.join('|')}"} — сообщить о событии на дороге
- eta {} — сколько ехать / когда приедем
- weather {} — погода
- taxi {} — вызвать такси
- start_nav {} — начать поездку
- stop_nav {} — завершить поездку
- my_car {} — где я оставил машину
- quests {} — открыть квесты
- about {"query":"место или тема"} — рассказать о месте Астаны (из Википедии)
- open_now {"query":"название или категория"} — работает ли сейчас
- where_am_i {} — где я, какой район
- fuel_price {"kind":"a92|a95|dt|gas"} — где дешевле топливо
- events_ahead {} — что на дороге впереди: ДТП, пробки, камеры
- nearby {} — что интересного рядом
- facts {"topic":"sos|parking|lrt|scooter|districts|roads"} — справка по городу
- none {} — просто ответить
Факты об Астане (используй, не выдумывай другие):
- Районы: Есиль, Алматы, Сарыарка, Байқоңыр, Нұра.
- Экстренные номера: 112, 101 пожарные, 102 полиция, 103 скорая, 104 газ, 109 iKomek (городские проблемы).
- Парковки: зоны 200/150/100 ₸ в час, оплата за день до 23:59 в UIMS Parking.
- LRT: 18 станций от аэропорта до «Нұрлы жол», 6:00–23:00, поездка 200 ₸, месяц 7 500 ₸, оплата QR в Kaspi.
- Самокаты: с 25.08.2026 по тротуарам нельзя, штраф 8 650 ₸.
- Трассы: КазАвтоЖол 1403, приложение Sapar.
Контекст: ${JSON.stringify(ctx).slice(0, 600)}
Не выдумывай адреса, цены и часы работы. Если не знаешь — так и скажи.`;
}

function parse(text) {
  const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function onRequestPost({ request, env }) {
  if (!env.AI) return Response.json({ ok: false, error: 'no_ai' }, { status: 503 });
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (limited(ip)) return Response.json({ ok: false, error: 'limit' }, { status: 429 });
  let body; try { body = await request.json(); } catch { return Response.json({ ok: false }, { status: 400 }); }
  const text = String(body.text || '').slice(0, 300).trim();
  if (!text) return Response.json({ ok: false }, { status: 400 });
  const lang = body.lang === 'kk' ? 'kk' : 'ru';
  const ctx = typeof body.ctx === 'object' && body.ctx ? body.ctx : {};
  const messages = [{ role: 'system', content: prompt(lang, ctx) }, { role: 'user', content: text + (MODELS[0].includes('qwen3') ? ' /no_think' : '') }];

  for (const model of MODELS) {
    try {
      const r = await env.AI.run(model, { messages, max_tokens: 220, temperature: 0.3 });
      const out = r?.response ?? r?.choices?.[0]?.message?.content ?? '';
      const j = typeof out === 'object' ? out : parse(out);
      if (!j || typeof j.say !== 'string') continue;
      const action = ACTIONS.includes(j.action) ? j.action : 'none';
      const args = typeof j.args === 'object' && j.args ? j.args : {};
      if (action === 'find_category' && !CATS.includes(args.cat)) return Response.json({ ok: true, say: j.say.slice(0, 200), action: 'none', args: {} });
      if (action === 'report' && !EVENTS.includes(args.type)) return Response.json({ ok: true, say: j.say.slice(0, 200), action: 'none', args: {} });
      return Response.json({ ok: true, say: j.say.slice(0, 200), action, args, model });
    } catch (e) { /* пробуем следующую модель */ }
  }
  return Response.json({ ok: false, error: 'ai_failed' }, { status: 502 });
}
