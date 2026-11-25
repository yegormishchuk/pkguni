import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, analyzeBytes } from './helpers.js';

// Эталонные значения заданы при генерации файлов (tests/fixtures/make_fixtures.py) и сверены с Pillow.
const EXPECTED = [
  ['jpeg_baseline.jpg', 'JPEG', 64, 48, 72, 24, /Baseline/, 'YCbCr'],
  ['jpeg_progressive.jpg', 'JPEG', 80, 60, 300, 24, /Progressive/, 'YCbCr'],
  ['jpeg_gray.jpg', 'JPEG', 40, 30, null, 8, /Baseline/, 'Оттенки серого'],
  ['jpeg_cmyk.jpg', 'JPEG', 32, 32, 150, 32, /Baseline/, 'CMYK'],
  ['jpeg_exif.jpg', 'JPEG', 48, 36, 180, 24, /Baseline/, 'YCbCr'],
  ['png_rgb.png', 'PNG', 50, 40, 96, 24, /Deflate/, 'RGB (Truecolor)'],
  ['png_rgba.png', 'PNG', 20, 10, null, 32, /Deflate/, 'RGBA (Truecolor + альфа)'],
  ['png_palette4.png', 'PNG', 16, 16, null, 4, /Deflate/, 'Индексированный (палитра)'],
  ['png_mono.png', 'PNG', 33, 17, null, 1, /Deflate/, 'Оттенки серого'],
  ['png_gray16.png', 'PNG', 12, 8, null, 16, /Deflate/, 'Оттенки серого'],
  ['gif_static.gif', 'GIF', 30, 20, null, 5, /LZW/, 'Индексированный, палитра 32 цв.'],
  ['gif_anim.gif', 'GIF', 24, 24, null, 6, /LZW/, 'Индексированный, палитра 64 цв.'],
  ['tiff_lzw.tif', 'TIFF', 60, 40, 300, 24, /LZW/, 'RGB'],
  ['tiff_deflate_cm.tif', 'TIFF', 60, 40, 300, 8, /Deflate/, 'Оттенки серого (0 — чёрный)'],
  ['tiff_multipage.tif', 'TIFF', 20, 10, null, 8, /PackBits/, 'Индексированный (палитра)'],
  ['tiff_cmyk.tif', 'TIFF', 17, 9, null, 32, /Нет/, 'CMYK'],
  ['bmp_24.bmp', 'BMP', 31, 21, 96, 24, /BI_RGB/, 'RGB (B, G, R по 8 бит)'],
  ['bmp_mono.bmp', 'BMP', 40, 10, 96, 1, /BI_RGB/, 'Палитра, оттенки серого (2)'],
  ['bmp_32.bmp', 'BMP', 10, 10, 96, 32, /BI_RGB/, 'RGB + 8 неиспользуемых бит'],
  ['bmp_gray8.bmp', 'BMP', 25, 25, 96, 8, /BI_RGB/, 'Палитра, оттенки серого (256)'],
  ['bmp_rle8.bmp', 'BMP', 8, 2, 96, 8, /BI_RLE8/, 'Индексированный, палитра 4 цв.'],
  ['pcx_8bit.pcx', 'PCX', 30, 20, 100, 8, /RLE/, 'Индексированный, палитра 256 цв.'],
  ['pcx_24.pcx', 'PCX', 30, 20, 100, 24, /RLE/, 'RGB (3 плоскости по 8 бит)'],
  ['pcx_mono.pcx', 'PCX', 33, 7, 100, 1, /RLE/, 'Монохромный'],
  ['pcx_gray.pcx', 'PCX', 19, 11, 100, 8, /RLE/, 'Оттенки серого'],
];

for (const [name, format, width, height, dpi, depth, compression, colorModel] of EXPECTED) {
  test(`${name}: ${format} ${width}×${height}, ${dpi ?? '—'} dpi, ${depth} бит`, async () => {
    const r = await fixture(name);
    assert.deepEqual(r.problems, []);
    assert.equal(r.status, 'ok');
    assert.equal(r.format, format);
    assert.equal(r.width, width);
    assert.equal(r.height, height);
    assert.equal(r.dpiX, dpi);
    assert.equal(r.dpiY, dpi);
    assert.equal(r.depth, depth);
    assert.match(r.compression, compression);
    assert.equal(r.colorModel, colorModel);
  });
}

const detailOf = (r, label) => r.details.find(d => d.label === label)?.value;

test('PNG: поля IHDR — тип цвета, фильтрация, чересстрочность', async () => {
  const r = await fixture('png_rgb.png');
  assert.match(detailOf(r, 'IHDR: тип цвета'), /^2 — RGB/);
  assert.match(detailOf(r, 'IHDR: метод фильтрации'), /^0 — адаптивный/);
  assert.match(detailOf(r, 'IHDR: чересстрочность'), /^0/);
  assert.equal(r.dpiSource, 'чанк pHYs');
});

test('PNG с палитрой: 16 цветов в PLTE', async () => {
  const r = await fixture('png_palette4.png');
  assert.equal(r.paletteCount, 16);
  assert.equal(r.palette.length, 16);
});

test('JPEG: таблицы квантования, субдискретизация и оценка качества', async () => {
  const base = await fixture('jpeg_baseline.jpg');
  assert.equal(base.quantTables.length, 2);
  assert.equal(base.quantTables[0].values.length, 64);
  assert.equal(detailOf(base, 'Субдискретизация цветности'), '4:2:0');
  assert.equal(detailOf(base, 'Оценка качества'), '≈ 75');
  const prog = await fixture('jpeg_progressive.jpg');
  assert.equal(detailOf(prog, 'Субдискретизация цветности'), '4:4:4');
  assert.equal(detailOf(prog, 'Оценка качества'), '≈ 90');
});

test('JPEG: разрешение и камера из EXIF, когда JFIF не задаёт единиц', async () => {
  const r = await fixture('jpeg_exif.jpg');
  assert.match(r.dpiSource, /EXIF/);
  assert.equal(detailOf(r, 'Камера'), 'TestCam Model X');
});

test('GIF: число кадров, повторы и глобальная палитра', async () => {
  const r = await fixture('gif_anim.gif');
  assert.equal(detailOf(r, 'Кадров'), '3');
  assert.equal(detailOf(r, 'Повторы'), 'бесконечно');
  assert.equal(r.paletteCount, 64);
  assert.equal(r.dpiX, null);
});

test('TIFF: страницы IFD, теги и палитра ColorMap', async () => {
  const r = await fixture('tiff_multipage.tif');
  assert.equal(detailOf(r, 'Страниц (IFD)'), '3');
  assert.equal(r.paletteCount, 256);
  const names = r.tiffTags.map(t => t.name);
  for (const n of ['ImageWidth', 'ImageLength', 'BitsPerSample', 'Compression', 'ColorMap', 'StripOffsets']) assert.ok(names.includes(n), n);
});

test('TIFF: разрешение в сантиметрах переводится в DPI', async () => {
  const r = await fixture('tiff_deflate_cm.tif');
  assert.match(detailOf(r, 'ResolutionUnit'), /сантиметр/);
  assert.equal(r.dpiX, 300);
});

test('TIFF big-endian (MM) разбирается вручную собранным файлом', async () => {
  // 2×2, 8 бит, оттенки серого, без сжатия, 72/1 dpi; порядок байт Motorola.
  const tags = [[256, 3, 1, 2], [257, 3, 1, 2], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 1],
    [273, 4, 1, 8], [277, 3, 1, 1], [279, 4, 1, 4], [282, 5, 1, 0], [283, 5, 1, 0], [296, 3, 1, 2]];
  const ifd = 12;
  const ratOffset = ifd + 2 + tags.length * 12 + 4;
  const buf = new DataView(new ArrayBuffer(ratOffset + 8));
  new Uint8Array(buf.buffer).set([0x4D, 0x4D, 0, 42]);
  buf.setUint32(4, ifd);
  new Uint8Array(buf.buffer).set([10, 20, 30, 40], 8);
  buf.setUint16(ifd, tags.length);
  tags.forEach(([tag, type, count, value], i) => {
    const o = ifd + 2 + i * 12;
    buf.setUint16(o, tag); buf.setUint16(o + 2, type); buf.setUint32(o + 4, count);
    if (type === 5) buf.setUint32(o + 8, ratOffset);
    else if (type === 3) buf.setUint16(o + 8, value);
    else buf.setUint32(o + 8, value);
  });
  buf.setUint32(ratOffset, 72); buf.setUint32(ratOffset + 4, 1);
  const r = await analyzeBytes(new Uint8Array(buf.buffer), 'mm.tif');
  assert.equal(r.status, 'ok', r.problems.join());
  assert.equal(r.width, 2);
  assert.equal(r.dpiX, 72);
  assert.match(detailOf(r, 'Порядок байт'), /big-endian/);
});

test('BMP: заголовок, порядок строк и палитра RGBQUAD', async () => {
  const r = await fixture('bmp_rle8.bmp');
  assert.match(detailOf(r, 'Информационный заголовок'), /BITMAPINFOHEADER/);
  assert.match(detailOf(r, 'Порядок строк'), /снизу вверх/);
  assert.equal(r.paletteCount, 4);
  assert.deepEqual(r.palette[1], [195, 60, 60]);
});
