// Автотесты API (выпуск Г). Запуск: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as M from '../functions/api/_middleware.js';
import * as E from '../functions/api/events.js';
import * as S from '../functions/api/stats.js';
import { sameKey, foreign } from '../lib/guard.js';

const SITE = 'https://astana-map.pages.dev';
const ctx = (url, method = 'GET', h = {}) => ({
  request: new Request(url, { method, headers: { 'CF-Connecting-IP': h.ip || '1.1.1.1', ...h }, body: method === 'GET' ? undefined : '{}' }),
  next: async () => new Response('ok'),
});
const kvEnv = () => { const kv = new Map(); return { CAMERAS: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) } }; };

// D1 поверх встроенного sqlite
function d1() {
  const db = new DatabaseSync(':memory:');
  const st = (sql, args = []) => ({
    bind: (...a) => st(sql, a),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
  });
  return { prepare: sql => st(sql), batch: async list => Promise.all(list.map(s => s.run())) };
}

test('ключ админа сравнивается точно', () => {
  assert.equal(sameKey('abc', 'abc'), true);
  assert.equal(sameKey('abc', 'abd'), false);
  assert.equal(sameKey('', ''), false);
});

test('запись с чужого сайта запрещена, со своего и с тестового — можно', async () => {
  assert.equal((await M.onRequest(ctx(SITE + '/api/events', 'POST', { Origin: 'https://evil.com' }))).status, 403);
  assert.equal((await M.onRequest(ctx(SITE + '/api/events', 'POST', { Origin: SITE }))).status, 200);
  assert.equal((await M.onRequest(ctx(SITE + '/api/events', 'POST', { Origin: 'https://cities.astana-map.pages.dev' }))).status, 200);
  assert.equal(foreign(new Request(SITE, { headers: { Origin: 'https://astana-map.pages.dev.evil.com' } })), true);
});

test('лимит частоты: 11-я отметка за минуту — 429', async () => {
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await M.onRequest(ctx(SITE + '/api/events', 'POST', { Origin: SITE, ip: '2.2.2.2' }))).status);
  assert.equal(codes.slice(0, 10).every(c => c === 200), true);
  assert.equal(codes[10], 429);
});

test('озвучку нельзя вызывать с чужих сайтов', async () => {
  assert.equal((await M.onRequest(ctx(SITE + '/api/tts?t=x', 'GET', { 'Sec-Fetch-Site': 'cross-site' }))).status, 403);
});

test('будильник рассылки (cron) не ограничивается', async () => {
  const rs = await Promise.all(Array.from({ length: 150 }, () => M.onRequest(ctx(SITE + '/api/push?cron=1', 'GET', { ip: '3.3.3.3' }))));
  assert.equal(rs.filter(r => r.status !== 200).length, 0);
});

test('отметку «Уже нет» снимают двое разных людей', async () => {
  const env = kvEnv();
  const post = async (b, ip) => (await E.onRequestPost({ request: new Request('http://x', { method: 'POST', body: JSON.stringify(b), headers: { 'CF-Connecting-IP': ip } }), env })).json();
  const del = async (b, ip) => (await E.onRequestDelete({ request: new Request('http://x', { method: 'DELETE', body: JSON.stringify(b), headers: { 'CF-Connecting-IP': ip } }), env })).json();
  const a = await post({ type: 'accident', lat: 51.1, lng: 71.4 }, '9.9.9.1');
  await post({ type: 'accident', lat: 51.1, lng: 71.4 }, '9.9.9.2');
  assert.equal((await del({ id: a.item.id }, '8.8.8.1')).removed, false);
  assert.equal((await del({ id: a.item.id }, '8.8.8.1')).removed, false);
  assert.equal((await del({ id: a.item.id }, '8.8.8.2')).removed, true);
});

test('статистика: считает только разрешённые события, читать — только с ключом', async () => {
  const env = { DB: d1(), ADMIN_KEY: 'k123' };
  const hit = b => S.onRequestPost({ request: new Request('http://x', { method: 'POST', body: JSON.stringify(b) }), env });
  assert.equal((await hit({ e: 'open', c: 'oral', l: 'kk', pwa: 1 })).status, 200);
  await hit({ e: 'open', c: 'astana', l: 'ru' });
  await hit({ e: 'route' });
  assert.equal((await hit({ e: 'hack' })).status, 400);
  assert.equal((await S.onRequestGet({ request: new Request('http://x'), env })).status, 403);
  const j = await (await S.onRequestGet({ request: new Request('http://x', { headers: { 'X-Admin-Key': 'k123' } }), env })).json();
  const d = Object.values(j.days)[0];
  assert.equal(d['e:open'], 2); assert.equal(d['e:route'], 1); assert.equal(d['c:oral'], 1); assert.equal(d['pwa:1'], 1);
});

test('кабинет бизнеса: статистику видит только владелец', async () => {
  const B = await import('../functions/api/bizstats.js');
  const { createHash } = await import('node:crypto');
  const tok = 'x'.repeat(20);
  const owner = createHash('sha256').update('owner:' + tok).digest('hex').slice(0, 16);
  const kv = new Map([['biz', JSON.stringify({ items: [{ id: 'abc123', name: 'Кофейня', owner }] })]]);
  const env = { DB: d1(), CAMERAS: { get: async k => kv.get(k) ?? null } };
  const hit = b => B.onRequestPost({ request: new Request('http://x', { method: 'POST', body: JSON.stringify(b) }), env });
  await hit({ id: 'abc123', k: 'view' }); await hit({ id: 'abc123', k: 'view' }); await hit({ id: 'abc123', k: 'call' });
  assert.equal((await hit({ id: 'abc123', k: 'hack' })).status, 400);
  const get = t => B.onRequestGet({ request: new Request('http://x/api/bizstats?id=abc123', { headers: { 'X-Biz-Token': t } }), env });
  assert.equal((await get('y'.repeat(20))).status, 403);
  const j = await (await get(tok)).json();
  assert.equal(j.total.view, 2); assert.equal(j.total.call, 1);
});
