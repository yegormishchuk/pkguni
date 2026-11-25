// TIFF: заголовок "II*\0" или "MM\0*" + смещение первого IFD. Каждый IFD — таблица тегов
// по 12 байт (тег, тип, количество, значение/смещение) и смещение следующего IFD (страницы).
import { FormatError, ByteSource } from '../byteSource.js';
import { detail, setDpi, PER_INCH_FROM_CM } from '../info.js';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
export const TYPE_NAMES = {
  1: 'BYTE', 2: 'ASCII', 3: 'SHORT', 4: 'LONG', 5: 'RATIONAL', 6: 'SBYTE', 7: 'UNDEFINED',
  8: 'SSHORT', 9: 'SLONG', 10: 'SRATIONAL', 11: 'FLOAT', 12: 'DOUBLE', 13: 'IFD',
};

export const TAG_NAMES = {
  254: 'NewSubfileType', 255: 'SubfileType', 256: 'ImageWidth', 257: 'ImageLength', 258: 'BitsPerSample',
  259: 'Compression', 262: 'PhotometricInterpretation', 263: 'Threshholding', 266: 'FillOrder',
  269: 'DocumentName', 270: 'ImageDescription', 271: 'Make', 272: 'Model', 273: 'StripOffsets',
  274: 'Orientation', 277: 'SamplesPerPixel', 278: 'RowsPerStrip', 279: 'StripByteCounts',
  280: 'MinSampleValue', 281: 'MaxSampleValue', 282: 'XResolution', 283: 'YResolution',
  284: 'PlanarConfiguration', 285: 'PageName', 286: 'XPosition', 287: 'YPosition', 290: 'GrayResponseUnit',
  291: 'GrayResponseCurve', 292: 'T4Options', 293: 'T6Options', 296: 'ResolutionUnit', 297: 'PageNumber',
  301: 'TransferFunction', 305: 'Software', 306: 'DateTime', 315: 'Artist', 316: 'HostComputer',
  317: 'Predictor', 318: 'WhitePoint', 319: 'PrimaryChromaticities', 320: 'ColorMap', 321: 'HalftoneHints',
  322: 'TileWidth', 323: 'TileLength', 324: 'TileOffsets', 325: 'TileByteCounts', 330: 'SubIFDs',
  332: 'InkSet', 338: 'ExtraSamples', 339: 'SampleFormat', 340: 'SMinSampleValue', 341: 'SMaxSampleValue',
  347: 'JPEGTables', 512: 'JPEGProc', 513: 'JPEGInterchangeFormat', 514: 'JPEGInterchangeFormatLength',
  529: 'YCbCrCoefficients', 530: 'YCbCrSubSampling', 531: 'YCbCrPositioning', 532: 'ReferenceBlackWhite',
  700: 'XMP', 18246: 'Rating', 33432: 'Copyright', 33434: 'ExposureTime', 33437: 'FNumber',
  33723: 'IPTC-NAA', 34377: 'Photoshop', 34665: 'ExifIFD', 34675: 'ICCProfile', 34850: 'ExposureProgram',
  34853: 'GPSInfo', 34855: 'ISOSpeedRatings', 36864: 'ExifVersion', 36867: 'DateTimeOriginal',
  36868: 'DateTimeDigitized', 37377: 'ShutterSpeedValue', 37378: 'ApertureValue', 37380: 'ExposureBiasValue',
  37383: 'MeteringMode', 37385: 'Flash', 37386: 'FocalLength', 37500: 'MakerNote', 37510: 'UserComment',
  40960: 'FlashpixVersion', 40961: 'ColorSpace', 40962: 'PixelXDimension', 40963: 'PixelYDimension',
  40965: 'InteropIFD', 41986: 'ExposureMode', 41987: 'WhiteBalance', 42035: 'LensMake', 42036: 'LensModel',
};

export const TIFF_COMPRESSION = {
  1: 'Без сжатия', 2: 'CCITT RLE (Modified Huffman)', 3: 'CCITT Group 3 (T.4)', 4: 'CCITT Group 4 (T.6)',
  5: 'LZW', 6: 'JPEG (старый, OJPEG)', 7: 'JPEG', 8: 'Deflate (Adobe)', 9: 'JBIG', 32773: 'PackBits (RLE)',
  32809: 'ThunderScan', 32946: 'Deflate (PKZIP)', 34676: 'SGILog', 34712: 'JPEG 2000', 34887: 'LERC',
  34925: 'LZMA', 50000: 'Zstandard', 50001: 'WebP',
};

export const PHOTOMETRIC = {
  0: 'Оттенки серого (0 — белый)', 1: 'Оттенки серого (0 — чёрный)', 2: 'RGB', 3: 'Индексированный (палитра)',
  4: 'Маска прозрачности', 5: 'CMYK', 6: 'YCbCr', 8: 'CIE L*a*b*', 9: 'ICC L*a*b*', 10: 'ITU L*a*b*',
  32844: 'LogL', 32845: 'LogLuv',
};

const RES_UNIT = { 1: 'не задана', 2: 'дюйм', 3: 'сантиметр' };
const ORIENTATION = {
  1: 'нормальная', 2: 'отражение по горизонтали', 3: 'поворот на 180°', 4: 'отражение по вертикали',
  5: 'транспонирование', 6: 'поворот на 90° по часовой', 7: 'транспонирование с поворотом', 8: 'поворот на 90° против часовой',
};

const MAX_PAGES = 100000;

/** Читает заголовок TIFF и возвращает порядок байт и смещение первого IFD. */
export async function readTiffHeader(src) {
  const h = await src.bytes(0, 8);
  const order = h.str(0, 2);
  if (order !== 'II' && order !== 'MM') throw new FormatError('Неверный порядок байт TIFF');
  const le = order === 'II';
  const magic = h.u16(2, le);
  if (magic === 43) throw new FormatError('BigTIFF (64-битные смещения) не поддерживается');
  if (magic !== 42) throw new FormatError(`Неверное магическое число TIFF: ${magic}`);
  return { le, ifdOffset: h.u32(4, le) };
}

/** Читает таблицу тегов IFD: Map(tag → запись) и смещение следующего IFD. */
export async function readIfd(src, offset, le) {
  if (offset < 8 || offset + 2 > src.size) throw new FormatError(`Смещение IFD (${offset}) выходит за пределы файла`);
  const count = (await src.bytes(offset, 2)).u16(0, le);
  const table = await src.bytes(offset + 2, count * 12 + 4);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const o = i * 12;
    const tag = table.u16(o, le);
    const type = table.u16(o + 2, le);
    const n = table.u32(o + 4, le);
    entries.set(tag, { tag, type, count: n, inline: table.sub(o + 8, 4), offset: table.u32(o + 8, le) });
  }
  return { entries, next: table.u32(count * 12, le) };
}

/** Значения тега (не более limit штук). RATIONAL возвращаются как числа. */
export async function readValues(src, entry, le, limit = 1024) {
  if (!entry) return null;
  const size = TYPE_SIZE[entry.type];
  if (!size) return null;
  const n = entry.type === 2 ? Math.min(entry.count, 1024) : Math.min(entry.count, limit);
  const fits = size * entry.count <= 4;
  const b = fits ? entry.inline : await src.bytes(entry.offset, size * n);
  if (entry.type === 2) return [b.cstr(0, n).trim()];
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * size;
    switch (entry.type) {
      case 1: case 7: out[i] = b.u8(o); break;
      case 6: out[i] = (b.u8(o) << 24) >> 24; break;
      case 3: out[i] = b.u16(o, le); break;
      case 8: out[i] = b.i16(o, le); break;
      case 4: case 13: out[i] = b.u32(o, le); break;
      case 9: out[i] = b.i32(o, le); break;
      case 5: { const d = b.u32(o + 4, le); out[i] = d ? b.u32(o, le) / d : 0; break; }
      case 10: { const d = b.i32(o + 4, le); out[i] = d ? b.i32(o, le) / d : 0; break; }
      case 11: out[i] = b.f32(o, le); break;
      case 12: out[i] = b.f64(o, le); break;
    }
  }
  return out;
}

export async function readValue(src, entries, tag, le, fallback = null) {
  const v = await readValues(src, entries.get(tag), le, 1);
  return v && v.length ? v[0] : fallback;
}

export async function parseTiff(src, info) {
  const { le, ifdOffset } = await readTiffHeader(src);
  const { entries, next } = await readIfd(src, ifdOffset, le);
  const get = (tag, fallback) => readValue(src, entries, tag, le, fallback);

  const width = await get(256);
  const height = await get(257);
  const samples = await get(277, 1);
  const bits = (await readValues(src, entries.get(258), le, 16)) ?? [1];
  const compression = await get(259, 1);
  const photometric = await get(262);
  const planar = await get(284, 1);
  const predictor = await get(317, 1);
  const xRes = await get(282);
  const yRes = await get(283);
  const resUnit = await get(296, 2);

  if (width === null || height === null) info.problems.push('Нет обязательных тегов ImageWidth/ImageLength');
  info.width = width;
  info.height = height;
  const bitsList = bits.length >= samples ? bits.slice(0, samples) : Array(samples).fill(bits[0]);
  info.depth = bitsList.reduce((a, b) => a + b, 0);
  info.colorModel = PHOTOMETRIC[photometric] ?? (photometric === null ? 'не задана' : `код ${photometric}`);
  if (entries.has(338)) info.colorModel += ' + альфа/доп. канал';
  info.compression = `${compression} — ${TIFF_COMPRESSION[compression] ?? 'неизвестный'}`;
  if (compression === 1) info.compression = 'Нет';
  if (xRes && yRes && resUnit !== 1) {
    const k = resUnit === 3 ? PER_INCH_FROM_CM : 1;
    setDpi(info, xRes * k, yRes * k, 'теги XResolution / YResolution');
  }

  // Палитра: ColorMap хранит 3·2^bits значений SHORT — сначала все R, затем все G, затем все B.
  if (photometric === 3 && entries.has(320)) {
    const n = 1 << bitsList[0];
    const map = await readValues(src, entries.get(320), le, 3 * n);
    if (map && map.length >= 3 * n) {
      info.palette = Array.from({ length: Math.min(n, 256) }, (_, i) => [map[i] >> 8, map[n + i] >> 8, map[2 * n + i] >> 8]);
      info.paletteCount = n;
    }
  }

  // Целостность: все полосы (strips) или плитки (tiles) должны лежать внутри файла.
  const tiled = entries.has(324);
  const { offsets, end } = await dataExtent(src, entries, le);
  if (!offsets) info.problems.push('Нет тегов расположения данных (StripOffsets / TileOffsets)');
  else if (end > src.size) info.problems.push(`Данные изображения заканчиваются на байте ${end}, а размер файла ${src.size} — файл обрезан`);

  // Остальные страницы: проход по цепочке IFD с проверкой, что их данные тоже лежат внутри файла.
  let pages = 1;
  const seen = new Set([ifdOffset]);
  let nextIfd = next;
  try {
    while (nextIfd && pages < MAX_PAGES) {
      if (seen.has(nextIfd)) { info.problems.push('Цепочка IFD зациклена'); break; }
      seen.add(nextIfd);
      const page = await readIfd(src, nextIfd, le);
      pages++;
      const extent = await dataExtent(src, page.entries, le);
      if (extent.end > src.size) { info.problems.push(`Данные страницы ${pages} выходят за конец файла — файл обрезан`); break; }
      nextIfd = page.next;
    }
  } catch (e) {
    if (!(e instanceof FormatError)) throw e;
    info.problems.push(`IFD страницы ${pages + 1} выходит за пределы файла — файл обрезан`);
  }

  info.tiffTags = await describeTags(src, entries, le);

  detail(info, 'Порядок байт', le ? 'II — little-endian (Intel)' : 'MM — big-endian (Motorola)', 'Байты 0–1 заголовка. Определяют, как читать все многобайтовые числа файла.');
  detail(info, 'Магическое число', '42', 'Байты 2–3 заголовка — признак TIFF.');
  detail(info, 'Смещение первого IFD', ifdOffset, 'Байты 4–7 заголовка: где лежит первая таблица тегов (Image File Directory).');
  detail(info, 'Тегов в IFD0', entries.size, 'Каждый тег — 12 байт: номер, тип, количество, значение или смещение до значения (если не помещается в 4 байта).');
  detail(info, 'Страниц (IFD)', pages, 'Число каталогов в цепочке: последние 4 байта каждого IFD — смещение следующего (0 — конец).');
  detail(info, 'BitsPerSample', bitsList.join(', '), 'Тег 258: бит на каждый канал. Глубина цвета = сумма по SamplesPerPixel каналам.');
  detail(info, 'SamplesPerPixel', samples, 'Тег 277: число каналов в пикселе.');
  detail(info, 'Compression', `${compression} — ${TIFF_COMPRESSION[compression] ?? 'неизвестный'}`, 'Тег 259: способ сжатия данных полос/плиток.');
  if (photometric !== null) detail(info, 'PhotometricInterpretation', `${photometric} — ${PHOTOMETRIC[photometric] ?? '?'}`, 'Тег 262: цветовая модель пикселей.');
  detail(info, 'PlanarConfiguration', planar === 2 ? '2 — каналы хранятся отдельными плоскостями' : '1 — каналы чередуются (chunky)', 'Тег 284.');
  if (predictor !== 1) detail(info, 'Predictor', predictor === 2 ? '2 — горизонтальная разность' : predictor === 3 ? '3 — для чисел с плавающей точкой' : predictor, 'Тег 317: предсказание перед LZW/Deflate для улучшения сжатия.');
  detail(info, 'ResolutionUnit', `${resUnit} — ${RES_UNIT[resUnit] ?? '?'}`, 'Тег 296: единица для XResolution/YResolution (RATIONAL — дробь из двух LONG). При сантиметрах DPI = значение · 2,54.');
  detail(info, tiled ? 'Плиток' : 'Полос (strips)', offsets?.length, tiled ? 'Изображение разбито на прямоугольные плитки (TileOffsets / TileByteCounts).' : 'Изображение разбито на горизонтальные полосы (StripOffsets / StripByteCounts).');
  if (tiled) detail(info, 'Размер плитки', `${await get(322)} × ${await get(323)}`, 'Теги 322/323.');
  else detail(info, 'RowsPerStrip', await get(278, height), 'Тег 278: строк изображения в одной полосе.');
  const orientation = await get(274);
  if (orientation) detail(info, 'Orientation', `${orientation} — ${ORIENTATION[orientation] ?? '?'}`, 'Тег 274: как развернуть изображение при показе.');
  for (const [tag, label] of [[305, 'Software'], [306, 'DateTime'], [271, 'Make'], [272, 'Model'], [315, 'Artist']]) {
    const v = await get(tag);
    if (v) detail(info, label, v, `Тег ${tag}.`);
  }
}

async function dataExtent(src, entries, le) {
  const tiled = entries.has(324);
  const offsets = await readValues(src, entries.get(tiled ? 324 : 273), le, 1e6);
  const counts = await readValues(src, entries.get(tiled ? 325 : 279), le, 1e6);
  let end = 0;
  if (offsets) for (let i = 0; i < offsets.length; i++) end = Math.max(end, offsets[i] + (counts?.[i] ?? 0));
  // Значения тегов, не поместившиеся в 4 байта записи, тоже должны лежать внутри файла (ColorMap, строки, RATIONAL…).
  for (const e of entries.values()) {
    const size = (TYPE_SIZE[e.type] ?? 0) * e.count;
    if (size > 4) end = Math.max(end, e.offset + size);
  }
  return { offsets, end };
}

async function describeTags(src, entries, le) {
  const rows = [];
  for (const e of entries.values()) {
    let preview;
    try {
      const v = await readValues(src, e, le, 8);
      if (v === null) preview = '—';
      else if (e.type === 2) preview = `"${v[0].slice(0, 60)}"`;
      else preview = v.map(x => Number.isInteger(x) ? x : +x.toFixed(4)).join(', ') + (e.count > 8 ? ' …' : '');
    } catch {
      preview = 'значение за пределами файла';
    }
    rows.push({ tag: e.tag, name: TAG_NAMES[e.tag] ?? 'неизвестный', type: TYPE_NAMES[e.type] ?? e.type, count: e.count, value: preview });
  }
  return rows;
}

/** Разбор EXIF (TIFF-структура внутри сегмента APP1 JPEG). */
export async function parseExif(bytes) {
  const src = ByteSource.fromBytes(bytes.data);
  const { le, ifdOffset } = await readTiffHeader(src);
  const { entries } = await readIfd(src, ifdOffset, le);
  const get = tag => readValue(src, entries, tag, le);
  const exif = {
    xRes: await get(282), yRes: await get(283), resUnit: await get(296),
    make: await get(271), model: await get(272), software: await get(305), dateTime: await get(306),
    orientation: await get(274), tags: entries.size,
  };
  const ptr = await get(34665);
  if (ptr) {
    try {
      const sub = (await readIfd(src, ptr, le)).entries;
      const s = tag => readValue(src, sub, tag, le);
      Object.assign(exif, {
        dateOriginal: await s(36867), exposure: await s(33434), fNumber: await s(33437), iso: await s(34855),
        focal: await s(37386), lens: await s(42036), pixelX: await s(40962), pixelY: await s(40963), colorSpace: await s(40961),
      });
    } catch (e) {
      if (!(e instanceof FormatError)) throw e;
    }
  }
  return exif;
}

export { ORIENTATION, RES_UNIT };
