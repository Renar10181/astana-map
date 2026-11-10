// Уведомления по расписанию (запускает GitHub Actions каждые 15 минут утром): погода/гололёд и «когда выезжать на работу».
// Каждое уведомление — не чаще раза в день (таблица push_daily). Повторный запуск ничего не дублирует.
import { pushInit, pushTo } from './push.js';

const CITY = { astana: { lat: 51.13, lng: 71.43, name: 'Астана', v: 'в Астане' }, oral: { lat: 51.23, lng: 51.37, name: 'Орал', v: 'в Орале' } };
const local = (d = new Date()) => new Date(d.getTime() + 5 * 3600e3);   // время Казахстана (UTC+5)
const dayKey = () => local().toISOString().slice(0, 10);
const hm = mins => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(Math.round(mins % 60)).padStart(2, '0')}`;

async function once(db, sub, kind, val) {
  const r = await db.prepare('INSERT OR IGNORE INTO push_daily (sub, day, kind, val) VALUES (?, ?, ?, ?)').bind(sub, dayKey(), kind, val == null ? '' : String(val)).run();
  return (r?.meta?.changes ?? r?.changes ?? 0) > 0;
}
async function getDaily(db, sub, kind) {
  return (await db.prepare('SELECT val FROM push_daily WHERE sub = ? AND day = ? AND kind = ?').bind(sub, dayKey(), kind).first())?.val ?? null;
}

// погода на сегодня: гололёд, снегопад, метель, сильный мороз
export async function weatherToday(c) {
  const j = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lng}&hourly=temperature_2m,apparent_temperature,precipitation,rain,snowfall,wind_gusts_10m,weather_code&wind_speed_unit=ms&past_days=1&forecast_days=1&timezone=Asia%2FAlmaty`)).json();
  const H = j.hourly; if (!H?.time) return null;
  const today = dayKey(), idx = H.time.map((t, i) => [t, i]);
  const day = idx.filter(([t]) => t.startsWith(today) && +t.slice(11, 13) >= 6 && +t.slice(11, 13) <= 21).map(([, i]) => i);
  const past = idx.filter(([t]) => { const ms = Date.parse(t + ':00+05:00'); return ms <= Date.now() && ms > Date.now() - 12 * 3600e3; }).map(([, i]) => i);
  if (!day.length) return null;
  const minFeel = Math.min(...day.map(i => H.apparent_temperature[i])), minT = Math.min(...day.map(i => H.temperature_2m[i]));
  const snow = day.reduce((s, i) => s + (H.snowfall[i] || 0), 0), gust = Math.max(...day.map(i => H.wind_gusts_10m[i] || 0));
  const wetPast = past.some(i => (H.rain[i] || 0) > 0 || ((H.precipitation[i] || 0) > 0 && H.temperature_2m[i] > -2));
  const freezingRain = day.some(i => [56, 57, 66, 67].includes(H.weather_code[i]));
  const morningT = Math.min(...day.filter(i => +H.time[i].slice(11, 13) <= 10).map(i => H.temperature_2m[i]));
  const out = [];
  if (freezingRain || (wetPast && morningT <= 0)) out.push('гололёд — на дорогах и тротуарах скользко');
  if (snow >= 3) out.push(`снегопад, до ${Math.round(snow)} см`);
  if (gust >= 15 && snow > 0) out.push(`метель, порывы до ${Math.round(gust)} м/с`);
  else if (gust >= 20) out.push(`сильный ветер, порывы до ${Math.round(gust)} м/с`);
  if (minFeel <= -30) out.push(`сильный мороз: ощущается до ${Math.round(minFeel)}°`);
  return { list: out, minT: Math.round(minT), minFeel: Math.round(minFeel), ice: out.some(x => /гололёд/.test(x)) };
}

async function carMinutes(a, b) {
  const j = await (await fetch(`https://routing.openstreetmap.de/routed-car/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`)).json();
  const d = j.routes?.[0]; return d ? { min: d.duration / 60, km: d.distance / 1000 } : null;
}

export async function runCron(db) {
  await pushInit(db);
  const now = local(), mins = now.getUTCHours() * 60 + now.getUTCMinutes(), wd = now.getUTCDay();   // 0 = воскресенье
  const res = { weather: 0, leave: 0, at: hm(mins) };
  // защита от частых запусков: не чаще раза в 5 минут
  const last = await db.prepare(`SELECT v FROM push_cfg WHERE k = 'cronAt'`).first();
  if (last && Date.now() - +last.v < 5 * 60e3) return { ...res, skipped: true };
  await db.prepare(`INSERT OR REPLACE INTO push_cfg (k, v) VALUES ('cronAt', ?)`).bind(String(Date.now())).run();
  if (mins < 390 || mins > 660) return res;   // работаем с 6:30 до 11:00 по Астане

  const subs = (await db.prepare('SELECT * FROM push_subs WHERE fails < 5').all()).results || [];
  const wx = {};
  for (const id of Object.keys(CITY)) {
    try { wx[id] = await weatherToday(CITY[id]); } catch { wx[id] = null; }
  }
  // 1) погода — один раз за утро, с 6:30
  for (const s of subs) {
    const w = wx[s.city] || wx.astana; if (!w?.list.length) continue;
    if (!(await once(db, s.id, 'weather'))) continue;
    res.weather += await pushTo(db, [s], { title: `❄️ Осторожно сегодня ${(CITY[s.city] || CITY.astana).v}`, body: w.list.join(', ') + '. Выезжайте пораньше.', url: '/', tag: 'weather', kind: 'weather', morning: true });
  }
  // 2) когда выезжать на работу — по будням, по сохранённым «Дом» и «Работа»
  if (wd >= 1 && wd <= 5) for (const s of subs) {
    let p = {}; try { p = JSON.parse(s.prefs || '{}'); } catch {}
    if (p.leave === false || !p.home || !p.work) continue;
    const [h, m] = (p.workAt || '09:00').split(':').map(Number), workMin = h * 60 + m;
    let dur = await getDaily(db, s.id, 'leaveDur');
    if (dur == null) {
      if (mins > workMin) continue;
      try { const r = await carMinutes(p.home, p.work); if (!r || r.km < 1) { await once(db, s.id, 'leaveDur', -1); continue; } dur = Math.round(r.min * 1.4 + 5); } catch { continue; }   // час пик ×1,4 и 5 минут на парковку
      await once(db, s.id, 'leaveDur', dur);
    }
    dur = +dur; if (dur < 0) continue;
    const w = wx[s.city] || wx.astana, extra = w?.ice || w?.list.some(x => /снегопад|метель/.test(x)) ? 10 : 0;
    const leaveAt = workMin - dur - extra;
    if (mins < leaveAt - 20 || mins > workMin - 10) continue;
    if (!(await once(db, s.id, 'leave'))) continue;
    res.leave += await pushTo(db, [s], { title: `🚗 Выезжайте в ${hm(leaveAt)}`, body: `До работы ~${dur} мин в час пик${extra ? `, +${extra} мин на ${w.ice ? 'гололёд' : 'снег'}` : ''}. Быть к ${p.workAt || '09:00'}.`, url: '/#go=work', tag: 'leave', kind: 'leave', morning: true });
  }
  await db.prepare('DELETE FROM push_daily WHERE day < ?').bind(new Date(Date.now() - 3 * 864e5 + 5 * 3600e3).toISOString().slice(0, 10)).run();
  return res;
}
