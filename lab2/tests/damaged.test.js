import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, analyzeBytes } from './helpers.js';
import { detectFormat } from '../js/model/analyze.js';

const DAMAGED = [
  ['broken_png_no_iend.png', /IEND/],
  ['broken_png_truncated.png', /выходит за конец файла/],
  ['broken_png_crc.png', /CRC/],
  ['broken_jpeg_no_eoi.jpg', /EOI \(FF D9\)/],
  ['broken_jpeg_truncated.jpg', /EOI/],
  ['broken_jpeg_header.jpg', /выходит за конец файла/],
  ['broken_bmp_truncated.bmp', /меньше указанного в заголовке bfSize/],
  ['broken_gif_truncated.gif', /обрезан/],
  ['broken_tiff_truncated.tif', /файл обрезан/],
  ['broken_pcx_no_palette.pcx', /палитры/],
];

for (const [name, reason] of DAMAGED) {
  test(`${name} — «Файл повреждён»`, async () => {
    const r = await fixture(name);
    assert.equal(r.status, 'damaged');
    assert.ok(r.problems.some(p => reason.test(p)), r.problems.join(' | '));
  });
}

test('Текстовый файл с расширением .jpg — не изображение, подмена расширения', async () => {
  const r = await fixture('fake_text.jpg');
  assert.equal(r.status, 'unknown');
  assert.equal(r.format, null);
  assert.equal(r.extMismatch, true);
  assert.match(r.problems[0], /текстовый файл/);
});

test('Случайные байты и пустой файл не роняют разбор', async () => {
  for (const name of ['fake_random.bmp', 'empty.png']) {
    const r = await fixture(name);
    assert.equal(r.status, 'unknown');
  }
});

test('PNG, переименованный в .jpg, распознаётся по сигнатуре', async () => {
  const r = await fixture('png_renamed.jpg');
  assert.equal(r.format, 'PNG');
  assert.equal(r.status, 'ok');
  assert.equal(r.extMismatch, true);
  assert.equal(r.width, 50);
});

test('JPEG, переименованный в .gif, распознаётся по сигнатуре', async () => {
  const r = await fixture('jpeg_renamed.gif');
  assert.equal(r.format, 'JPEG');
  assert.equal(r.extMismatch, true);
});

test('Данные после EOI — предупреждение, а не повреждение', async () => {
  const r = await fixture('jpeg_trailing.jpg');
  assert.equal(r.status, 'ok');
  assert.match(r.warnings[0], /100 байт/);
});

test('Любой обрезанный префикс корректного файла не вызывает исключений', async () => {
  const { readFileSync } = await import('node:fs');
  const { FIXTURES } = await import('./helpers.js');
  for (const name of ['jpeg_exif.jpg', 'png_rgb.png', 'gif_anim.gif', 'tiff_multipage.tif', 'bmp_rle8.bmp', 'pcx_8bit.pcx']) {
    const data = new Uint8Array(readFileSync(FIXTURES + name));
    for (let len = 0; len < data.length; len += Math.max(1, Math.floor(data.length / 97))) {
      const r = await analyzeBytes(data.subarray(0, len), name);
      assert.notEqual(r.status, 'ok', `${name}, обрезан до ${len} байт`);
    }
  }
});

test('Случайная порча байтов заголовка не вызывает исключений', async () => {
  const { readFileSync } = await import('node:fs');
  const { FIXTURES } = await import('./helpers.js');
  let seed = 7;
  const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (const name of ['jpeg_exif.jpg', 'png_rgb.png', 'gif_anim.gif', 'tiff_multipage.tif', 'bmp_24.bmp', 'pcx_24.pcx']) {
    const orig = new Uint8Array(readFileSync(FIXTURES + name));
    for (let k = 0; k < 200; k++) {
      const data = orig.slice();
      for (let j = 0; j < 4; j++) data[4 + rnd(Math.min(200, data.length - 4))] = rnd(256);
      const r = await analyzeBytes(data, name);
      assert.ok(['ok', 'damaged', 'unknown'].includes(r.status));
    }
  }
});

test('Определение формата по сигнатуре', () => {
  const b = (...x) => new Uint8Array(x);
  assert.equal(detectFormat(b(0xFF, 0xD8, 0xFF, 0xE0)), 'JPEG');
  assert.equal(detectFormat(b(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)), 'PNG');
  assert.equal(detectFormat(new TextEncoder().encode('GIF89a')), 'GIF');
  assert.equal(detectFormat(b(0x49, 0x49, 42, 0)), 'TIFF');
  assert.equal(detectFormat(b(0x4D, 0x4D, 0, 42)), 'TIFF');
  assert.equal(detectFormat(b(0x0A, 5, 1, 8)), 'PCX');
  assert.equal(detectFormat(new TextEncoder().encode('BM hello world, not a bitmap')), null);
  assert.equal(detectFormat(new TextEncoder().encode('hello')), null);
});

test('JPEG с большим «хвостом» после EOI (motion photo) — предупреждение, а не повреждение', async () => {
  const { readFileSync } = await import('node:fs');
  const { FIXTURES } = await import('./helpers.js');
  for (const name of ['jpeg_baseline.jpg', 'jpeg_progressive.jpg', 'jpeg_exif.jpg']) {
    const jpeg = new Uint8Array(readFileSync(FIXTURES + name));
    // 200 КБ посторонних данных, в том числе с байтами FF D9 внутри.
    const trailer = Uint8Array.from({ length: 200 * 1024 }, (_, i) => (i % 1000 === 0 ? 0xFF : i % 1000 === 1 ? 0xD9 : i & 0x7F));
    const data = new Uint8Array(jpeg.length + trailer.length);
    data.set(jpeg);
    data.set(trailer, jpeg.length);
    const r = await analyzeBytes(data, name);
    assert.equal(r.status, 'ok', `${name}: ${r.problems.join()}`);
    assert.match(r.warnings[0], new RegExp(`${trailer.length} байт`), name);
  }
});

test('GIF с ошибкой в блоке изображения не получает ложного предупреждения о терминаторе', async () => {
  const { readFileSync } = await import('node:fs');
  const { FIXTURES } = await import('./helpers.js');
  const g = new Uint8Array(readFileSync(FIXTURES + 'gif_static.gif'));
  let pos = 13 + (g[10] & 0x80 ? 3 * (1 << ((g[10] & 7) + 1)) : 0);
  while (g[pos] === 0x21) { pos += 2; while (g[pos]) pos += 1 + g[pos]; pos++; }
  assert.equal(g[pos], 0x2C);
  g[pos + 10 + (g[pos + 9] & 0x80 ? 3 * (1 << ((g[pos + 9] & 7) + 1)) : 0)] = 12; // мин. размер кода LZW > 8
  const r = await analyzeBytes(g, 'bad.gif');
  assert.equal(r.status, 'damaged');
  assert.match(r.problems[0], /LZW/);
  assert.equal(r.warnings.some(w => /терминатор/.test(w)), false);
});
