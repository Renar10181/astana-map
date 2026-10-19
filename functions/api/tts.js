// Озвучка через Microsoft Azure Speech. Ключ хранится в настройках Cloudflare (AZURE_KEY, AZURE_REGION),
// на сайт он не попадает. Готовые фразы кэшируются, повторные запросы бесплатны.
const VOICES = {
  'kk-KZ-AigulNeural': 'kk-KZ', 'kk-KZ-DauletNeural': 'kk-KZ',
  'ru-RU-SvetlanaNeural': 'ru-RU', 'ru-RU-DariyaNeural': 'ru-RU', 'ru-RU-DmitryNeural': 'ru-RU',
};

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const ready = !!(env.AZURE_KEY && env.AZURE_REGION);
  if (url.searchParams.has('ping')) return Response.json({ ok: ready });
  if (!ready) return new Response('TTS not configured', { status: 503 });

  const v = url.searchParams.get('v') || '';
  const t = (url.searchParams.get('t') || '').trim().slice(0, 300);
  if (!VOICES[v] || !t) return new Response('bad request', { status: 400 });

  const cache = caches.default;
  const key = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  const esc = s => s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const ssml = `<speak version="1.0" xml:lang="${VOICES[v]}"><voice name="${v}"><prosody rate="+4%">${esc(t)}</prosody></voice></speak>`;
  const r = await fetch(`https://${env.AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': env.AZURE_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'astana-map',
    },
    body: ssml,
  });
  if (!r.ok) return new Response('tts error ' + r.status, { status: 502 });
  const res = new Response(r.body, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=2592000' } });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
