import { limited, foreign, tooMany, forbidden } from '../../lib/guard.js';
// Общая защита всех /api/* (выпуск Г): лимит запросов с одного адреса и запись только со страниц карты.
// Запросов в минуту с одного адреса: [метод записи, чтение]
const LIMITS = {
  events: [10, 240], cameras: [10, 240], fuel: [10, 240], corrections: [5, 60], reviews: [6, 240], business: [10, 240],
  probes: [20, 60], trip: [20, 240], friends: [120, 240], push: [60, 120], quests: [20, 240], traffic: [60, 120],
  tts: [60, 60], assistant: [20, 60], translate: [30, 60], stats: [30, 60],
};
export async function onRequest(ctx) {
  const { request } = ctx, url = new URL(request.url), name = url.pathname.split('/')[2] || '';
  const write = request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS';
  const admin = !!(request.headers.get('X-Admin-Key') || url.searchParams.get('admin'));
  // запись — только со страниц карты; озвучку чужие сайты тоже не используют
  if ((write || name === 'tts') && foreign(request)) return forbidden();
  if (name === 'tts' && request.headers.get('Sec-Fetch-Site') === 'cross-site') return forbidden();
  if (!admin && !(name === 'push' && url.searchParams.has('cron'))) {
    const [w, r] = LIMITS[name] || [30, 240];
    if (limited(request, name + (write ? ':w' : ':r'), write ? w : r)) return tooMany();
  }
  return ctx.next();
}
