import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIXTURES } from './helpers.js';
import { analyze } from '../js/model/analyze.js';
import { ByteSource, TruncatedError } from '../js/model/byteSource.js';

/** Источник, который считает обращения и прочитанные байты. */
function countingSource(bytes) {
  return new ByteSource(bytes.length, async (o, l) => bytes.subarray(o, o + l));
}

// «Большой» JPEG: настоящий заголовок, 20 МБ энтропийных данных (без байтов FF) и маркер EOI.
function bigJpeg() {
  const small = new Uint8Array(readFileSync(FIXTURES + 'jpeg_exif.jpg'));
  const sos = small.findIndex((b, i) => b === 0xFF && small[i + 1] === 0xDA);
  const len = (small[sos + 2] << 8) | small[sos + 3];
  const head = small.subarray(0, sos + 2 + len);
  const out = new Uint8Array(head.length + 20 * 1024 * 1024 + 2);
  out.set(head);
  out.fill(0x55, head.length);
  out.set([0xFF, 0xD9], out.length - 2);
  return out;
}

test('Из 20-мегабайтного JPEG читается только заголовок и хвост', async () => {
  const data = bigJpeg();
  const src = countingSource(data);
  const r = await analyze(src, { name: 'big.jpg' });
  assert.equal(r.status, 'ok', r.problems.join());
  assert.equal(r.width, 48);
  assert.ok(r.bytesRead < 70 * 1024, `прочитано ${r.bytesRead} байт`);
  assert.ok(src.reads <= 3, `обращений к файлу: ${src.reads}`);
});

test('Большой PNG: данные IDAT пропускаются, проверяется только IEND в конце', async () => {
  const png = new Uint8Array(readFileSync(FIXTURES + 'png_rgb.png'));
  // вставляем перед IEND 10 МБ пустых чанков-заглушек «zzZz» (неизвестный вспомогательный тип)
  const iend = png.length - 12;
  const filler = new Uint8Array(10 * 1024 * 1024);
  const dv = new DataView(filler.buffer);
  dv.setUint32(0, filler.length - 12);
  filler.set([0x7A, 0x7A, 0x5A, 0x7A], 4);
  const data = new Uint8Array(png.length + filler.length);
  data.set(png.subarray(0, iend));
  data.set(filler, iend);
  data.set(png.subarray(iend), iend + filler.length);
  const src = countingSource(data);
  const r = await analyze(src, { name: 'big.png' });
  assert.equal(r.status, 'ok', r.problems.join());
  assert.ok(r.bytesRead < 70 * 1024);
});

test('ByteSource кэширует блоки и бросает TruncatedError за пределами файла', async () => {
  const data = new Uint8Array(200000).map((_, i) => i & 255);
  const src = new ByteSource(data.length, async (o, l) => data.subarray(o, o + l), { blockSize: 1024 });
  const a = await src.bytes(10, 4);
  const b = await src.bytes(20, 4);
  assert.equal(src.reads, 1);
  assert.equal(a.u8(0), 10);
  assert.equal(b.u32(0), (20 << 24) | (21 << 16) | (22 << 8) | 23);
  const across = await src.bytes(1020, 8);
  assert.deepEqual(Array.from(across.data), [252, 253, 254, 255, 0, 1, 2, 3]);
  await assert.rejects(src.bytes(199999, 2), TruncatedError);
  assert.throws(() => a.u32(2), TruncatedError);
  const t = await src.tail(2);
  assert.deepEqual(Array.from(t.data), [(199998) & 255, (199999) & 255]);
});
