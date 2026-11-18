// Проверки главной страницы: синтаксис скрипта, нет повторов имён функций, версия совпадает с sw.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const main = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).sort((a, b) => b.length - a.length)[0];

test('скрипт карты без синтаксических ошибок', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'map-')), 'main.js');
  writeFileSync(f, main);
  execFileSync(process.execPath, ['--check', f]);
});

test('нет двух функций с одинаковым именем (тихо ломают друг друга)', () => {
  const names = [...main.matchAll(/^\s*(?:async )?function ([A-Za-z0-9_]+)/gm)].map(m => m[1]);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual([...new Set(dup)], []);
});

test('версия в настройках совпадает с версией кэша sw.js', () => {
  const a = html.match(/Версия ([\d.]+)/)?.[1], b = sw.match(/const V = '([\d.]+)'/)?.[1];
  assert.ok(a); assert.equal(a, b);
});

test('нигде не пишется «Уральск» вместо «Орал» в интерфейсе', () => {
  const ui = main.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n').replace(/\/[^\n/]*уральск[^\n/]*\//gi, '');
  const hits = ui.match(/['"`>][^'"`<\n]*Уральск[^'"`<\n]*['"`<]/g) || [];
  assert.deepEqual(hits, []);
});

test('страница конфиденциальности есть и ссылка на неё в настройках', () => {
  readFileSync(new URL('../privacy.html', import.meta.url), 'utf8');
  assert.ok(main.includes('/privacy.html'));
});
