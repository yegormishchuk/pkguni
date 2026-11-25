// BMP: BITMAPFILEHEADER (14 байт) + BITMAPINFOHEADER (или его версия) + палитра + пиксели.
import { FormatError } from '../byteSource.js';
import { detail, setDpi, PER_INCH_FROM_METER } from '../info.js';

export const BMP_COMPRESSION = {
  0: ['BI_RGB', 'без сжатия'],
  1: ['BI_RLE8', 'RLE, 8 бит на пиксель'],
  2: ['BI_RLE4', 'RLE, 4 бита на пиксель'],
  3: ['BI_BITFIELDS', 'без сжатия, каналы заданы битовыми масками'],
  4: ['BI_JPEG', 'внутри BMP хранится JPEG'],
  5: ['BI_PNG', 'внутри BMP хранится PNG'],
  6: ['BI_ALPHABITFIELDS', 'без сжатия, маски RGBA'],
  11: ['BI_CMYK', 'CMYK без сжатия'],
  12: ['BI_CMYKRLE8', 'CMYK, RLE8'],
  13: ['BI_CMYKRLE4', 'CMYK, RLE4'],
};

export const BMP_HEADERS = {
  12: 'BITMAPCOREHEADER (OS/2 1.x, Windows 2.x)',
  16: 'OS22XBITMAPHEADER (сокращённый, OS/2 2.x)',
  40: 'BITMAPINFOHEADER (Windows 3.x)',
  52: 'BITMAPV2INFOHEADER',
  56: 'BITMAPV3INFOHEADER',
  64: 'OS22XBITMAPHEADER (OS/2 2.x)',
  108: 'BITMAPV4HEADER (Windows 95)',
  124: 'BITMAPV5HEADER (Windows 98)',
};

const VALID_BPP = [1, 2, 4, 8, 16, 24, 32, 64];

export async function parseBmp(src, info) {
  const fh = await src.bytes(0, 18);
  const bfSize = fh.u32(2, true);
  const bfOffBits = fh.u32(10, true);
  const headerSize = fh.u32(14, true);
  if (!BMP_HEADERS[headerSize]) throw new FormatError(`Неизвестный размер информационного заголовка: ${headerSize} байт`);
  const h = await src.bytes(14, headerSize);

  let width, height, planes, bpp, compression = 0, sizeImage = 0, xppm = 0, yppm = 0, clrUsed = 0, clrImportant = 0;
  if (headerSize === 12) {
    width = h.u16(4, true);
    height = h.i16(6, true);
    planes = h.u16(8, true);
    bpp = h.u16(10, true);
  } else {
    width = h.i32(4, true);
    height = h.i32(8, true);
    planes = h.u16(12, true);
    bpp = h.u16(14, true);
    if (headerSize >= 20) compression = h.u32(16, true);
    if (headerSize >= 24) sizeImage = h.u32(20, true);
    if (headerSize >= 32) { xppm = h.i32(24, true); yppm = h.i32(28, true); }
    if (headerSize >= 40) { clrUsed = h.u32(32, true); clrImportant = h.u32(36, true); }
  }
  const topDown = height < 0;
  const absHeight = Math.abs(height);
  info.width = width;
  info.height = absHeight;
  info.depth = bpp;

  const [compName, compText] = BMP_COMPRESSION[compression] ?? [`неизвестный (${compression})`, ''];
  info.compression = compression === 0 ? 'Нет (BI_RGB)' : `${compName}${compText ? ' — ' + compText : ''}`;
  if (xppm > 0 && yppm > 0) setDpi(info, xppm * PER_INCH_FROM_METER, yppm * PER_INCH_FROM_METER, 'biXPelsPerMeter / biYPelsPerMeter');

  if (width <= 0 || absHeight === 0) info.problems.push(`Недопустимые размеры изображения: ${width}×${height}`);
  if (planes !== 1) info.problems.push(`biPlanes = ${planes}, по спецификации должно быть 1`);
  if (!VALID_BPP.includes(bpp)) info.problems.push(`Недопустимая глубина цвета: ${bpp} бит`);
  if (compression === 1 && bpp !== 8) info.problems.push('Сжатие RLE8 допускается только при 8 битах на пиксель');
  if (compression === 2 && bpp !== 4) info.problems.push('Сжатие RLE4 допускается только при 4 битах на пиксель');
  if (!BMP_COMPRESSION[compression]) info.problems.push(`Неизвестный код сжатия ${compression}`);

  // Битовые маски каналов (для 16/32 бит с BI_BITFIELDS).
  let masks = null;
  let afterHeader = 14 + headerSize;
  if (compression === 3 || compression === 6) {
    const count = compression === 6 ? 4 : 3;
    if (headerSize === 40) {
      const m = await src.bytes(afterHeader, count * 4);
      masks = Array.from({ length: count }, (_, i) => m.u32(i * 4, true));
      afterHeader += count * 4;
    } else if (headerSize >= 52) {
      masks = Array.from({ length: headerSize >= 56 ? 4 : 3 }, (_, i) => h.u32(40 + i * 4, true));
    }
  }

  // Палитра: таблица цветов сразу после заголовка (и масок), пиксели хранят индексы в ней.
  const entrySize = headerSize === 12 ? 3 : 4;
  let paletteCount = clrUsed || (bpp <= 8 ? 1 << bpp : 0);
  const room = Math.max(0, Math.floor((Math.min(bfOffBits, src.size) - afterHeader) / entrySize));
  if (paletteCount > room) {
    if (bpp <= 8) info.problems.push(`Палитра должна содержать ${paletteCount} цветов, но до начала пикселей помещается только ${room}`);
    paletteCount = room;
  }
  if (paletteCount > 0 && paletteCount <= 4096) {
    const p = await src.bytes(afterHeader, paletteCount * entrySize);
    info.palette = Array.from({ length: Math.min(paletteCount, 256) }, (_, i) => {
      const o = i * entrySize;
      return [p.u8(o + 2), p.u8(o + 1), p.u8(o)];
    });
    info.paletteCount = paletteCount;
  }

  const isGray = info.palette && info.palette.every(([r, g, b]) => r === g && g === b);
  if (bpp <= 8) info.colorModel = isGray ? `Палитра, оттенки серого (${paletteCount})` : `Индексированный, палитра ${paletteCount} цв.`;
  else if (bpp === 16) info.colorModel = masks ? `RGB ${maskBits(masks)}` : 'RGB 5-5-5';
  else if (bpp === 24) info.colorModel = 'RGB (B, G, R по 8 бит)';
  else if (bpp === 32) info.colorModel = masks?.[3] ? 'RGBA' : 'RGB + 8 неиспользуемых бит';
  else info.colorModel = `${bpp} бит/пиксель`;

  // Проверка целостности: размер файла должен покрывать заявленные данные.
  if (bfOffBits >= src.size) info.problems.push(`Смещение данных пикселей (${bfOffBits}) находится за концом файла`);
  if (bfSize > src.size) info.problems.push(`Размер файла (${src.size} байт) меньше указанного в заголовке bfSize (${bfSize} байт)`);
  else if (bfSize !== 0 && bfSize !== src.size) info.warnings.push(`bfSize = ${bfSize}, фактический размер ${src.size} байт`);
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  if (compression === 0 || compression === 3 || compression === 6) {
    const need = rowSize * absHeight;
    if (width > 0 && bfOffBits + need > src.size) {
      info.problems.push(`Растр ${width}×${absHeight}×${bpp} бит требует ${need} байт, а после смещения ${bfOffBits} есть только ${Math.max(0, src.size - bfOffBits)}`);
    }
  } else if (sizeImage && bfOffBits + sizeImage > src.size) {
    info.problems.push(`Сжатые данные (biSizeImage = ${sizeImage}) выходят за конец файла`);
  }

  detail(info, 'Сигнатура', '"BM" (42 4D)', 'Первые 2 байта BITMAPFILEHEADER — признак формата BMP.');
  detail(info, 'bfSize', `${bfSize} байт`, 'Размер всего файла по данным BITMAPFILEHEADER (смещение 2). Если файл меньше — он обрезан.');
  detail(info, 'bfOffBits', `${bfOffBits}`, 'Смещение от начала файла до массива пикселей (смещение 10).');
  detail(info, 'Информационный заголовок', `${BMP_HEADERS[headerSize]}, ${headerSize} байт`, 'Версия определяется по полю biSize (первые 4 байта после файлового заголовка).');
  detail(info, 'Порядок строк', topDown ? 'сверху вниз (biHeight < 0)' : 'снизу вверх (biHeight > 0)', 'Знак biHeight: положительная высота — первая строка в файле является нижней строкой изображения.');
  detail(info, 'biPlanes', planes, 'Число цветовых плоскостей, в BMP всегда 1.');
  detail(info, 'biCompression', `${compression} — ${compName}`, 'Способ хранения пикселей. BI_RGB — без сжатия; BI_RLE8/BI_RLE4 — кодирование длин серий; BI_BITFIELDS — несжатые пиксели с масками каналов.');
  if (headerSize >= 24) detail(info, 'biSizeImage', `${sizeImage} байт`, 'Размер массива пикселей; для BI_RGB может быть 0.');
  if (compression === 0 || compression === 3) detail(info, 'Размер строки', `${rowSize} байт`, 'Каждая строка выравнивается до кратного 4 байтам: ⌊(бит·ширина + 31) / 32⌋ · 4.');
  if (headerSize >= 32) detail(info, 'Пикселей на метр', `${xppm} × ${yppm}`, 'biXPelsPerMeter / biYPelsPerMeter. DPI = значение · 0,0254.');
  if (headerSize >= 40) {
    detail(info, 'biClrUsed', clrUsed, 'Число используемых цветов палитры; 0 означает «максимум для данной глубины» (2^бит).');
    detail(info, 'biClrImportant', clrImportant, 'Число «важных» цветов для отображения; 0 — все важны.');
  }
  if (masks) detail(info, 'Битовые маски', masks.map(m => '0x' + m.toString(16).toUpperCase().padStart(8, '0')).join(', '), 'Маски R, G, B (и A) показывают, какие биты пикселя относятся к каждому каналу.');
  if (paletteCount) {
    detail(info, 'Палитра', `${paletteCount} записей по ${entrySize} байта`,
      `Таблица цветов расположена сразу после заголовка (смещение ${afterHeader}). Каждая запись — ${entrySize === 4 ? 'RGBQUAD: Blue, Green, Red, Reserved' : 'RGBTRIPLE: Blue, Green, Red'}. Пиксель хранит не цвет, а номер записи в палитре.`);
  }
}

function maskBits(masks) {
  return masks.slice(0, 3).map(m => m.toString(2).replace(/0/g, '').length).join('-');
}
