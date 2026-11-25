import test from 'node:test';
import assert from 'node:assert/strict';
import { ScanViewModel } from '../js/viewmodel/scanViewModel.js';
import { analyzeBytes } from './helpers.js';

const fakeFile = (name, size = 100) => ({ name, size });

const result = (id, name, extra = {}) => ({
  id, name, path: name, ext: name.split('.').pop(), size: 100 * (id + 1), format: 'PNG', width: 10 * (id + 1), height: 10,
  dpiX: null, dpiY: null, depth: 24, colorModel: 'RGB', compression: 'Deflate', status: 'ok', extMismatch: false,
  problems: [], warnings: [], details: [], bytesRead: 50, ...extra,
});

/** Сканер, который отдаёт результаты, когда тест вызовет release(). */
function manualScanner() {
  const s = {
    cancelled: false,
    scan(items, onResults) {
      s.items = items;
      s.onResults = onResults;
      return new Promise(res => { s.finish = res; });
    },
    cancel() { s.cancelled = true; s.finish?.(false); },
  };
  return s;
}

test('Прогресс и счётчики обновляются по мере поступления результатов', async () => {
  const scanner = manualScanner();
  let time = 0;
  const vm = new ScanViewModel({ scanner, now: () => time });
  let notifications = 0;
  vm.subscribe(() => notifications++);
  const done = vm.start(['a.png', 'b.png', 'c.jpg', 'd.txt'].map(n => ({ file: fakeFile(n) })));
  assert.equal(vm.getState().scanning, true);
  assert.equal(vm.getState().total, 4);
  scanner.onResults([result(0, 'a.png'), result(2, 'c.jpg', { extMismatch: true })]);
  time = 500;
  let s = vm.getState();
  assert.equal(s.done, 2);
  assert.equal(s.progress, 0.5);
  assert.equal(s.filesPerSecond, 4);
  assert.equal(s.counts.mismatch, 1);
  scanner.onResults([result(1, 'b.png', { status: 'damaged', problems: ['нет IEND'] }), result(3, 'd.txt', { status: 'unknown', format: null })]);
  scanner.finish(true);
  assert.equal(await done, true);
  s = vm.getState();
  assert.equal(s.scanning, false);
  assert.deepEqual(s.counts, { all: 4, ok: 2, damaged: 1, unknown: 1, mismatch: 1 });
  assert.deepEqual(s.rows.map(r => r.id), [0, 1, 2, 3]);
  assert.ok(notifications >= 4);
});

test('Фильтры, поиск и сортировка', async () => {
  const scanner = manualScanner();
  const vm = new ScanViewModel({ scanner, now: () => 0 });
  vm.start(['b.png', 'a.png', 'c.png'].map(n => ({ file: fakeFile(n) })));
  scanner.onResults([result(0, 'b.png'), result(1, 'a.png', { status: 'damaged' }), result(2, 'c.png')]);
  vm.setFilter('damaged');
  assert.deepEqual(vm.getState().rows.map(r => r.name), ['a.png']);
  vm.setFilter('all');
  vm.setSort('name');
  assert.deepEqual(vm.getState().rows.map(r => r.name), ['a.png', 'b.png', 'c.png']);
  vm.setSort('name');
  assert.deepEqual(vm.getState().rows.map(r => r.name), ['c.png', 'b.png', 'a.png']);
  vm.setSort('name');
  assert.equal(vm.getState().sort, null);
  vm.setSort('pixels');
  assert.deepEqual(vm.getState().rows.map(r => r.width), [10, 20, 30]);
  vm.setQuery('  C.P ');
  assert.deepEqual(vm.getState().rows.map(r => r.name), ['c.png']);
  assert.throws(() => vm.setFilter('nope'));
});

test('Выбор файла и экспорт CSV', async () => {
  const scanner = manualScanner();
  const vm = new ScanViewModel({ scanner, now: () => 0 });
  vm.start([{ file: fakeFile('x;y.png') }]);
  scanner.onResults([result(0, 'x;y.png', { problems: ['CRC "IHDR"'], status: 'damaged' })]);
  vm.select(0);
  assert.equal(vm.getState().selected.name, 'x;y.png');
  const csv = vm.toCsv();
  assert.ok(csv.startsWith('﻿Путь;Формат'));
  assert.match(csv, /"x;y\.png";PNG;10;10;;;24;RGB;Deflate;100;Файл повреждён;"CRC ""IHDR"""/);
});

test('Отмена обхода и повторный запуск', async () => {
  const scanner = manualScanner();
  const vm = new ScanViewModel({ scanner, now: () => 0 });
  const first = vm.start([{ file: fakeFile('a.png') }, { file: fakeFile('b.png') }]);
  vm.cancel();
  assert.equal(await first, false);
  assert.equal(vm.getState().cancelled, true);
  assert.equal(vm.getState().scanning, false);
  const second = vm.start([{ file: fakeFile('c.png') }]);
  scanner.onResults([result(0, 'c.png')]);
  scanner.finish(true);
  assert.equal(await second, true);
  assert.equal(vm.getState().total, 1);
  assert.equal(vm.getState().cancelled, false);
});

test('Результат настоящего разбора подходит для ViewModel', async () => {
  const scanner = manualScanner();
  const vm = new ScanViewModel({ scanner, now: () => 0 });
  vm.start([{ file: fakeFile('t.jpg', 5) }]);
  const r = await analyzeBytes(new TextEncoder().encode('hello'), 't.jpg');
  scanner.onResults([{ ...r, id: 0 }]);
  vm.setFilter('mismatch');
  assert.equal(vm.getState().rows.length, 1);
  assert.equal(vm.getState().counts.unknown, 1);
});
