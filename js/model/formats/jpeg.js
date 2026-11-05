// JPEG: последовательность сегментов [FF маркер][длина 2 байта][данные]. Разбор идёт прыжками
// по длинам сегментов от SOI (FF D8) до SOS (FF DA); энтропийно-закодированные данные не читаются.
import { FormatError } from '../byteSource.js';
import { detail, setDpi, hex, PER_INCH_FROM_CM } from '../info.js';
import { parseExif, ORIENTATION } from './tiff.js';

export const SOF_TYPES = {
  0xC0: 'Baseline DCT, Хаффман', 0xC1: 'Extended sequential DCT, Хаффман', 0xC2: 'Progressive DCT, Хаффман',
  0xC3: 'Lossless, Хаффман', 0xC5: 'Differential sequential DCT', 0xC6: 'Differential progressive DCT',
  0xC7: 'Differential lossless', 0xC9: 'Extended sequential DCT, арифметическое', 0xCA: 'Progressive DCT, арифметическое',
  0xCB: 'Lossless, арифметическое', 0xCD: 'Differential sequential, арифметическое',
  0xCE: 'Differential progressive, арифметическое', 0xCF: 'Differential lossless, арифметическое',
};

const MARKER_NAMES = {
  0xC4: 'DHT', 0xCC: 'DAC', 0xDA: 'SOS', 0xDB: 'DQT', 0xDD: 'DRI', 0xDC: 'DNL', 0xFE: 'COM',
};

// Порядок обхода коэффициентов 8×8 «зигзагом»: ZIGZAG[k] — позиция k-го коэффициента в обычном порядке.
export const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
  28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61,
  54, 47, 55, 62, 63,
];

// Стандартные таблицы квантования из приложения K стандарта JPEG (качество 50 в IJG).
const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  ...Array(32).fill(99),
];

const SCAN_CHUNK = 64 * 1024;

/**
 * Ищет EOI, проходя от сегмента SOS по сжатым данным. Внутри них байт FF всегда идёт как FF 00
 * (байт-стаффинг), FF FF (заполнение) или FF D0…D7 (RSTn), поэтому первый «настоящий» FF D9 —
 * конец изображения. Сегменты между сканами (DHT, SOS, DQT в progressive JPEG) пропускаются по длине.
 * Возвращает смещение EOI или −1.
 */
async function findEoi(src, pos) {
  while (pos + 1 < src.size) {
    const d = (await src.bytes(pos, Math.min(SCAN_CHUNK, src.size - pos))).data;
    let next = pos + d.length - 1; // последний байт может быть FF — проверим его со следующим блоком
    for (let i = 0; i + 1 < d.length; i++) {
      if (d[i] !== 0xFF) continue;
      const m = d[i + 1];
      if (m === 0x00 || m === 0xFF || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) continue;
      if (m === 0xD9) return pos + i;
      if (i + 3 >= d.length) {
        if (pos + d.length >= src.size) return -1; // длина сегмента обрезана концом файла
        next = pos + i;
        break;
      }
      next = pos + i + 2 + ((d[i + 2] << 8) | d[i + 3]);
      break;
    }
    pos = next;
  }
  return -1;
}

export async function parseJpeg(src, info) {
  let pos = 2;
  let sof = null;
  let jfif = null;
  let exif = null;
  let adobe = null;
  let restart = 0;
  let sosOffset = null;
  const quant = [];
  const huffman = [];
  const apps = [];
  let comment = null;
  let icc = false;

  while (true) {
    let m = await src.bytes(pos, 2);
    if (m.u8(0) !== 0xFF) throw new FormatError(`Ожидался маркер FF на смещении ${pos}, найден ${hex(m.u8(0))}`);
    let marker = m.u8(1);
    while (marker === 0xFF) { pos++; marker = (await src.bytes(pos, 2)).u8(1); }
    pos += 2;
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
    if (marker === 0xD9) throw new FormatError('Маркер EOI встретился до начала данных изображения (SOS)');
    const length = (await src.bytes(pos, 2)).u16(0);
    if (length < 2) throw new FormatError(`Недопустимая длина сегмента ${hex(marker)}: ${length}`);
    if (pos + length > src.size) throw new FormatError(`Сегмент ${markerName(marker)} на смещении ${pos - 2} выходит за конец файла — файл обрезан`);
    const readSeg = () => src.bytes(pos + 2, length - 2);

    if (SOF_TYPES[marker]) {
      const s = await readSeg();
      const n = s.u8(5);
      sof = { marker, precision: s.u8(0), height: s.u16(1), width: s.u16(3), components: [] };
      for (let i = 0; i < n; i++) {
        const o = 6 + i * 3;
        sof.components.push({ id: s.u8(o), h: s.u8(o + 1) >> 4, v: s.u8(o + 1) & 15, tq: s.u8(o + 2) });
      }
    } else if (marker === 0xDB) {
      const s = await readSeg();
      for (let o = 0; o < s.length;) {
        const pq = s.u8(o) >> 4, tq = s.u8(o) & 15;
        const values = new Array(64);
        for (let k = 0; k < 64; k++) values[ZIGZAG[k]] = pq ? s.u16(o + 1 + k * 2) : s.u8(o + 1 + k);
        quant.push({ id: tq, precision: pq ? 16 : 8, values });
        o += 1 + 64 * (pq ? 2 : 1);
      }
    } else if (marker === 0xC4) {
      const s = await readSeg();
      for (let o = 0; o < s.length;) {
        const tc = s.u8(o) >> 4, th = s.u8(o) & 15;
        let total = 0;
        for (let i = 1; i <= 16; i++) total += s.u8(o + i);
        huffman.push(`${tc ? 'AC' : 'DC'}${th}`);
        o += 17 + total;
      }
    } else if (marker === 0xDD) {
      restart = (await readSeg()).u16(0);
    } else if (marker === 0xE0) {
      const s = await readSeg();
      if (s.length >= 12 && s.str(0, 5) === 'JFIF\0') {
        jfif = { major: s.u8(5), minor: s.u8(6), units: s.u8(7), x: s.u16(8), y: s.u16(10) };
      }
      apps.push(jfif ? 'APP0 (JFIF)' : 'APP0');
    } else if (marker === 0xE1) {
      const s = await readSeg();
      if (s.length > 14 && s.str(0, 6) === 'Exif\0\0') {
        try { exif = await parseExif(s.sub(6)); } catch (e) { info.warnings.push(`EXIF повреждён: ${e.message}`); }
        apps.push('APP1 (Exif)');
      } else if (s.cstr(0, 40).startsWith('http://ns.adobe.com/xap')) apps.push('APP1 (XMP)');
      else apps.push('APP1');
    } else if (marker === 0xE2) {
      icc = icc || (await src.bytes(pos + 2, Math.min(12, length - 2))).str(0, Math.min(11, length - 2)) === 'ICC_PROFILE';
      apps.push(icc ? 'APP2 (ICC)' : 'APP2');
    } else if (marker === 0xEE) {
      const s = await readSeg();
      if (s.length >= 12 && s.str(0, 5) === 'Adobe') adobe = { transform: s.u8(11) };
      apps.push('APP14 (Adobe)');
    } else if (marker >= 0xE0 && marker <= 0xEF) {
      apps.push(`APP${marker - 0xE0}`);
    } else if (marker === 0xFE) {
      comment = (await src.bytes(pos + 2, Math.min(length - 2, 200))).str(0, Math.min(length - 2, 200)).replace(/\0+$/, '');
    } else if (marker === 0xDA) {
      sosOffset = pos - 2;
      break;
    }
    pos += length;
  }

  if (!sof) throw new FormatError('Не найден маркер начала кадра SOF — размеры изображения неизвестны');

  // Ленивое чтение: сжатые данные пропускаются, а конец файла проверяется по маркеру EOI (FF D9).
  // Если файл кончается не на EOI (телефоны дописывают после него видео и служебные данные),
  // сжатые данные просматриваются от SOS до настоящего EOI — только в этом редком случае.
  const t = (await src.tail(Math.min(2, src.size))).data;
  if (!(t[0] === 0xFF && t[1] === 0xD9)) {
    const eoi = await findEoi(src, sosOffset);
    if (eoi >= 0) info.warnings.push(`После маркера EOI (смещение ${eoi}) есть ${src.size - eoi - 2} байт посторонних данных`);
    else info.problems.push('Нет маркера конца изображения EOI (FF D9) — файл обрезан или повреждён');
  }

  info.width = sof.width;
  info.height = sof.height;
  const nc = sof.components.length;
  info.depth = sof.precision * nc;
  info.colorModel = colorModelOf(sof, adobe, jfif);
  info.compression = `JPEG: ${SOF_TYPES[sof.marker]}`;
  if (sof.height === 0) info.warnings.push('Высота задана нулём в SOF и определяется маркером DNL после данных');
  if (sof.width === 0) info.problems.push('Ширина изображения в SOF равна нулю');

  if (jfif && jfif.units !== 0 && jfif.x > 0 && jfif.y > 0) {
    const k = jfif.units === 2 ? PER_INCH_FROM_CM : 1;
    setDpi(info, jfif.x * k, jfif.y * k, `JFIF (APP0), ${jfif.units === 1 ? 'точек на дюйм' : 'точек на см'}`);
  } else if (exif?.xRes && exif?.yRes && exif.resUnit !== 1) {
    const k = exif.resUnit === 3 ? PER_INCH_FROM_CM : 1;
    setDpi(info, exif.xRes * k, exif.yRes * k, 'EXIF (APP1), теги XResolution / YResolution');
  }

  detail(info, 'SOI', 'FF D8', 'Маркер начала изображения — первые 2 байта любого JPEG.');
  detail(info, 'Сегменты приложений', apps.join(', ') || 'нет', 'APPn (FF E0…FF EF): JFIF, Exif, XMP, ICC-профиль, Adobe и т. д.');
  if (jfif) {
    detail(info, 'JFIF', `версия ${jfif.major}.${String(jfif.minor).padStart(2, '0')}`, 'Сегмент APP0 с идентификатором «JFIF\\0».');
    detail(info, 'JFIF: плотность', `${jfif.x} × ${jfif.y} ${['(только соотношение сторон)', 'точек/дюйм', 'точек/см'][jfif.units] ?? ''}`,
      'Байт units (0 — без единиц, 1 — дюйм, 2 — сантиметр) и плотности Xdensity/Ydensity из APP0 — источник DPI.');
  }
  detail(info, 'Маркер SOF', `${hex(sof.marker)} — ${SOF_TYPES[sof.marker]}`, 'Start Of Frame: тип маркера задаёт способ сжатия (baseline, progressive, lossless) и вид энтропийного кодирования.');
  detail(info, 'Точность', `${sof.precision} бит на компонент`, 'Байт P сегмента SOF. Глубина цвета = точность × число компонентов.');
  detail(info, 'Компоненты', sof.components.map(c => `${componentName(c.id, nc)} ${c.h}×${c.v} (DQT ${c.tq})`).join(', '),
    'Для каждого компонента в SOF: идентификатор, коэффициенты дискретизации H×V и номер таблицы квантования.');
  if (nc === 3) detail(info, 'Субдискретизация цветности', subsampling(sof.components), 'Отношение коэффициентов дискретизации яркости и цветности: 4:4:4 — без прореживания, 4:2:0 — цветность в 2 раза реже по обеим осям.');
  if (quant.length) {
    info.quantTables = quant;
    const q = estimateQuality(quant);
    detail(info, 'Таблицы квантования', `${quant.length} (${quant.map(t => `№${t.id}, ${t.precision} бит`).join('; ')})`,
      'Сегменты DQT (FF DB): 64 делителя для коэффициентов ДКП блока 8×8, записаны зигзагом. Чем больше числа, тем сильнее сжатие и потери.');
    if (q) detail(info, 'Оценка качества', `≈ ${q}`, 'Оценка по шкале IJG (1–100): сравнение таблицы яркости со стандартной таблицей из приложения K стандарта JPEG.');
  }
  if (huffman.length) detail(info, 'Таблицы Хаффмана', huffman.join(', '), 'Сегменты DHT (FF C4): таблицы для DC- и AC-коэффициентов до первого SOS.');
  if (restart) detail(info, 'Интервал перезапуска', `${restart} MCU`, 'Сегмент DRI: через сколько блоков MCU вставляются маркеры RSTn.');
  detail(info, 'Начало данных (SOS)', `смещение ${sosOffset}`, 'Start Of Scan: после него идут сжатые данные — их программа не читает.');
  if (adobe) detail(info, 'Adobe: преобразование', ['нет (RGB/CMYK)', 'YCbCr', 'YCCK'][adobe.transform] ?? adobe.transform, 'Байт transform сегмента APP14 «Adobe»: в какой модели хранятся компоненты.');
  if (icc) detail(info, 'ICC-профиль', 'встроен', 'Сегмент APP2 «ICC_PROFILE».');
  if (comment) detail(info, 'Комментарий', comment, 'Сегмент COM (FF FE).');
  if (exif) {
    if (exif.xRes) detail(info, 'EXIF: разрешение', `${round(exif.xRes)} × ${round(exif.yRes)} на ${exif.resUnit === 3 ? 'см' : 'дюйм'}`, 'Теги XResolution/YResolution/ResolutionUnit из IFD0 EXIF (EXIF устроен как TIFF внутри APP1).');
    if (exif.make || exif.model) detail(info, 'Камера', [exif.make, exif.model].filter(Boolean).join(' '), 'Теги Make (271) и Model (272).');
    if (exif.lens) detail(info, 'Объектив', exif.lens, 'Тег LensModel (42036).');
    if (exif.dateOriginal || exif.dateTime) detail(info, 'Дата съёмки', exif.dateOriginal ?? exif.dateTime, 'Тег DateTimeOriginal (36867) или DateTime (306).');
    if (exif.exposure) detail(info, 'Выдержка', exif.exposure >= 1 ? `${round(exif.exposure)} с` : `1/${Math.round(1 / exif.exposure)} с`, 'Тег ExposureTime (33434).');
    if (exif.fNumber) detail(info, 'Диафрагма', `f/${round(exif.fNumber)}`, 'Тег FNumber (33437).');
    if (exif.iso) detail(info, 'ISO', exif.iso, 'Тег ISOSpeedRatings (34855).');
    if (exif.focal) detail(info, 'Фокусное расстояние', `${round(exif.focal)} мм`, 'Тег FocalLength (37386).');
    if (exif.orientation) detail(info, 'Ориентация', `${exif.orientation} — ${ORIENTATION[exif.orientation] ?? '?'}`, 'Тег Orientation (274): как повернуть снимок при показе.');
    if (exif.software) detail(info, 'Программа', exif.software, 'Тег Software (305).');
  }
}

function colorModelOf(sof, adobe, jfif) {
  const n = sof.components.length;
  if (n === 1) return 'Оттенки серого';
  if (n === 3) {
    if (adobe?.transform === 0 && !jfif) return 'RGB';
    const ids = sof.components.map(c => String.fromCharCode(c.id)).join('');
    if (ids === 'RGB') return 'RGB';
    return 'YCbCr';
  }
  if (n === 4) return adobe?.transform === 2 ? 'YCCK' : 'CMYK';
  return `${n} компонентов`;
}

function componentName(id, n) {
  if (n === 1) return 'Y';
  if (n === 3 && id >= 1 && id <= 3) return ['Y', 'Cb', 'Cr'][id - 1];
  if (id >= 0x41 && id <= 0x5A) return String.fromCharCode(id);
  return `#${id}`;
}

export function subsampling(comps) {
  const [y, cb] = comps;
  const h = y.h / cb.h, v = y.v / cb.v;
  const map = { '1x1': '4:4:4', '2x1': '4:2:2', '2x2': '4:2:0', '1x2': '4:4:0', '4x1': '4:1:1', '4x2': '4:1:0' };
  return map[`${h}x${v}`] ?? `${y.h}×${y.v} / ${cb.h}×${cb.v}`;
}

/** Обратная формула масштабирования таблиц библиотеки IJG: scale = 5000/Q (Q < 50) или 200 − 2Q. */
export function estimateQuality(tables) {
  const luma = tables.find(t => t.id === 0) ?? tables[0];
  if (!luma) return null;
  const std = luma.id === 0 ? STD_LUMA : STD_CHROMA;
  const sum = luma.values.reduce((a, b) => a + b, 0);
  const stdSum = std.reduce((a, b) => a + b, 0);
  const scale = (sum * 100) / stdSum;
  const q = scale <= 100 ? (200 - scale) / 2 : 5000 / scale;
  return Math.max(1, Math.min(100, Math.round(q)));
}

const markerName = m => SOF_TYPES[m] ? 'SOF' : MARKER_NAMES[m] ?? (m >= 0xE0 && m <= 0xEF ? `APP${m - 0xE0}` : hex(m));
const round = v => +(+v).toFixed(2);
