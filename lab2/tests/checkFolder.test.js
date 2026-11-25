import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { analyzePath, CHECK_DIR } from './helpers.js';

// Эталон для архива «Для проверки Lab2», полученный через Pillow (Image.open(f).size, mode).
// Все файлы — BMP, 8 бит, палитра из 256 оттенков серого, без сжатия, разрешение не задано.
const REFERENCE = {
  'Fig1.15(a).bmp': [512, 480], 'Fig1.15(b).BMP': [1184, 496], 'Fig10.15(a).BMP': [360, 414],
  'Fig10.29(a).bmp': [400, 480], 'Fig2.19(a).BMP': [1024, 1024], 'Fig2.22(a).BMP': [300, 300],
  'Fig3.15(a)1top.bmp': [500, 500], 'Fig3.15(a)2.bmp': [500, 500], 'Fig3.15(a)3.bmp': [500, 500],
  'Fig3.15(a)4.bmp': [500, 500], 'Fig3.27(a).BMP': [370, 457], 'Fig3.35(a).bmp': [500, 500],
  'Fig3.37(a).bmp': [455, 440], 'Fig3.45(a).bmp': [937, 932], 'Fig4.19(a).bmp': [508, 444],
  'Fig4.20(a).BMP': [732, 1028], 'Fig4.28(a).BMP': [464, 538], 'Fig5.04(i).bmp': [256, 256],
  'Fig5.08(a).bmp': [464, 448], 'Fig5.08(b).bmp': [464, 448], 'Fig5.10(a).bmp': [455, 440],
  'Fig9.11(a).bmp': [315, 238], 'Fig9.14(a).bmp': [221, 269], 'Fig9.16(a).bmp': [512, 512],
};

test('Архив «Для проверки Lab2»: размеры, глубина и сжатие совпадают с эталоном', { skip: !existsSync(CHECK_DIR) }, async () => {
  const files = readdirSync(CHECK_DIR);
  assert.equal(files.length, Object.keys(REFERENCE).length);
  for (const name of files) {
    const r = await analyzePath(join(CHECK_DIR, name));
    assert.equal(r.status, 'ok', `${name}: ${r.problems.join()}`);
    assert.equal(r.format, 'BMP');
    assert.deepEqual([r.width, r.height], REFERENCE[name], name);
    assert.equal(r.depth, 8);
    assert.equal(r.compression, 'Нет (BI_RGB)');
    assert.equal(r.paletteCount, 256);
    assert.equal(r.dpiX, null);
    assert.equal(r.colorModel, 'Палитра, оттенки серого (256)');
  }
});
