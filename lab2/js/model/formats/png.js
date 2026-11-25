// PNG: сигнатура 89 50 4E 47 0D 0A 1A 0A, затем цепочка чанков [длина][тип][данные][CRC].
import { FormatError } from '../byteSource.js';
import { detail, setDpi, PER_INCH_FROM_METER } from '../info.js';

export const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const IEND_TAIL = [0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82];

export const PNG_COLOR_TYPES = {
  0: { name: 'Оттенки серого', channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { name: 'RGB (Truecolor)', channels: 3, depths: [8, 16] },
  3: { name: 'Индексированный (палитра)', channels: 1, depths: [1, 2, 4, 8] },
  4: { name: 'Оттенки серого + альфа', channels: 2, depths: [8, 16] },
  6: { name: 'RGBA (Truecolor + альфа)', channels: 4, depths: [8, 16] },
};

const SRGB_INTENT = ['Perceptual', 'Relative colorimetric', 'Saturation', 'Absolute colorimetric'];
// Чанки, данные которых читаются целиком (они небольшие) и проверяются по CRC.
const SMALL_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'pHYs', 'gAMA', 'sRGB', 'cHRM', 'sBIT', 'bKGD', 'tIME', 'acTL']);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export async function parsePng(src, info) {
  let pos = 8;
  let ihdr = null;
  let colorType = 0;
  const chunks = [];
  let idatOffset = null;

  while (true) {
    if (pos + 12 > src.size) throw new FormatError(`Цепочка чанков обрывается на смещении ${pos}: чанк IDAT/IEND не найден — файл обрезан`);
    const head = await src.bytes(pos, 8);
    const length = head.u32(0);
    const type = head.str(4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new FormatError(`Повреждён заголовок чанка на смещении ${pos} (тип «${escape(type)}»)`);
    if (length > 0x7FFFFFFF) throw new FormatError(`Недопустимая длина чанка ${type}: ${length}`);
    if (pos + 12 + length > src.size) throw new FormatError(`Чанк ${type} (длина ${length}) выходит за конец файла — файл обрезан`);
    if (!ihdr && type !== 'IHDR') throw new FormatError(`Первым должен идти чанк IHDR, а найден ${type}`);
    chunks.push(type);
    if (type === 'IDAT') { idatOffset = pos; break; }
    if (type === 'IEND') throw new FormatError('Чанк IEND встретился раньше данных изображения IDAT');

    let data = null;
    if (SMALL_CHUNKS.has(type) && length <= 4096) {
      const all = await src.bytes(pos + 4, length + 8);
      data = all.sub(4, length);
      const crc = all.u32(4 + length);
      if (crc32(all.data.subarray(0, 4 + length)) !== crc) info.problems.push(`Контрольная сумма CRC чанка ${type} не совпадает`);
    } else if (['iCCP', 'tEXt', 'zTXt', 'iTXt'].includes(type)) {
      data = await src.bytes(pos + 8, Math.min(length, 200));
    }

    switch (type) {
      case 'IHDR': {
        if (length !== 13) throw new FormatError(`Чанк IHDR должен иметь длину 13, а имеет ${length}`);
        ihdr = {
          width: data.u32(0), height: data.u32(4), bitDepth: data.u8(8), colorType: data.u8(9),
          compression: data.u8(10), filter: data.u8(11), interlace: data.u8(12),
        };
        colorType = ihdr.colorType;
        applyIhdr(info, ihdr);
        break;
      }
      case 'PLTE': {
        const count = Math.floor(length / 3);
        info.paletteCount = count;
        if (data) info.palette = Array.from({ length: Math.min(count, 256) }, (_, i) => [data.u8(i * 3), data.u8(i * 3 + 1), data.u8(i * 3 + 2)]);
        if (length % 3 !== 0) info.problems.push('Длина PLTE не кратна 3');
        detail(info, 'PLTE', `${count} цветов`, 'Чанк палитры: последовательность троек R, G, B по 1 байту. Для типа цвета 3 каждый пиксель — индекс в этой таблице.');
        break;
      }
      case 'tRNS':
        detail(info, 'tRNS', colorType === 3 ? `прозрачность для ${length} цветов палитры` : 'задан прозрачный цвет',
          'Чанк прозрачности: альфа для записей палитры или один «прозрачный» цвет для RGB/серого изображения.');
        break;
      case 'pHYs': {
        const ppuX = data.u32(0), ppuY = data.u32(4), unit = data.u8(8);
        if (unit === 1) setDpi(info, ppuX * PER_INCH_FROM_METER, ppuY * PER_INCH_FROM_METER, 'чанк pHYs');
        detail(info, 'pHYs', `${ppuX} × ${ppuY} пикс. на ${unit === 1 ? 'метр' : 'ед. (единица не задана)'}`,
          'Физический размер пикселя. При единице «метр» DPI = значение · 0,0254; при единице 0 задано только соотношение сторон пикселя.');
        break;
      }
      case 'gAMA':
        detail(info, 'gAMA', (data.u32(0) / 100000).toFixed(5), 'Гамма исходного изображения ×100000: как кодированные значения связаны с яркостью.');
        break;
      case 'sRGB':
        detail(info, 'sRGB', SRGB_INTENT[data.u8(0)] ?? data.u8(0), 'Изображение в пространстве sRGB; значение — цель рендеринга ICC.');
        break;
      case 'cHRM':
        detail(info, 'cHRM', `белая точка (${(data.u32(0) / 1e5).toFixed(4)}; ${(data.u32(4) / 1e5).toFixed(4)})`, 'Цветности основных цветов и белой точки (CIE xy ×100000).');
        break;
      case 'iCCP':
        detail(info, 'iCCP', `профиль «${data.cstr(0, 80)}»`, 'Встроенный ICC-профиль (сжат Deflate), задающий цветовое пространство.');
        break;
      case 'sBIT':
        detail(info, 'sBIT', Array.from(data.data).join(', '), 'Число значащих бит в каждом канале исходного изображения.');
        break;
      case 'bKGD':
        detail(info, 'bKGD', 'задан', 'Рекомендуемый цвет фона для отображения.');
        break;
      case 'tIME': {
        const d = `${data.u16(0)}-${pad(data.u8(2))}-${pad(data.u8(3))} ${pad(data.u8(4))}:${pad(data.u8(5))}:${pad(data.u8(6))}`;
        detail(info, 'tIME', d + ' UTC', 'Время последнего изменения изображения.');
        break;
      }
      case 'acTL':
        detail(info, 'acTL (APNG)', `${data.u32(0)} кадров, повторов: ${data.u32(4) || '∞'}`, 'Анимированный PNG: число кадров и повторов.');
        break;
      case 'tEXt': case 'zTXt': case 'iTXt':
        detail(info, type, data.cstr(0, 79), 'Текстовый чанк: ключевое слово (Title, Author, Software …) и текст.');
        break;
    }
    pos += 12 + length;
  }

  // Ленивое чтение: IDAT-данные не читаются, а целостность проверяется по последним 12 байтам — чанку IEND.
  const tail = await src.tail(12);
  if (!tail.startsWith(IEND_TAIL)) info.problems.push('В конце файла нет чанка IEND — файл обрезан или повреждён');

  detail(info, 'Сигнатура', '89 50 4E 47 0D 0A 1A 0A', 'Первые 8 байт файла: «‰PNG» + CR LF + Ctrl-Z + LF — защищают от порчи при текстовой передаче.');
  detail(info, 'Чанки до данных', chunks.join(', '), 'Чанки, прочитанные по цепочке смещений до первого IDAT; сами сжатые данные IDAT не читаются.');
  detail(info, 'Первый IDAT', `смещение ${idatOffset}`, 'С этого места начинаются сжатые данные пикселей.');
}

function applyIhdr(info, h) {
  const ct = PNG_COLOR_TYPES[h.colorType];
  if (!ct) throw new FormatError(`Недопустимый тип цвета в IHDR: ${h.colorType}`);
  if (!ct.depths.includes(h.bitDepth)) info.problems.push(`Глубина ${h.bitDepth} бит недопустима для типа цвета ${h.colorType}`);
  if (h.width === 0 || h.height === 0) info.problems.push('Нулевые размеры в IHDR');
  if (h.compression !== 0) info.problems.push(`Неизвестный метод сжатия ${h.compression}`);
  if (h.filter !== 0) info.problems.push(`Неизвестный метод фильтрации ${h.filter}`);
  if (h.interlace > 1) info.problems.push(`Неизвестный метод чересстрочности ${h.interlace}`);

  info.width = h.width;
  info.height = h.height;
  info.depth = h.bitDepth * ct.channels;
  info.colorModel = ct.name;
  info.compression = `Deflate (zlib)${h.interlace === 1 ? ', Adam7' : ''}`;

  detail(info, 'IHDR: ширина × высота', `${h.width} × ${h.height}`, 'Первые 8 байт чанка IHDR — два 4-байтовых числа big-endian.');
  detail(info, 'IHDR: битовая глубина', `${h.bitDepth} бит на канал`, 'Байт 8 IHDR. Глубина цвета пикселя = битовая глубина × число каналов.');
  detail(info, 'IHDR: тип цвета', `${h.colorType} — ${ct.name}, каналов: ${ct.channels}`, 'Байт 9 IHDR: 0 — серый, 2 — RGB, 3 — палитра, 4 — серый+альфа, 6 — RGBA.');
  detail(info, 'IHDR: метод сжатия', h.compression === 0 ? '0 — Deflate (LZ77 + Хаффман)' : h.compression, 'Байт 10 IHDR. Стандарт определяет только метод 0.');
  detail(info, 'IHDR: метод фильтрации', h.filter === 0 ? '0 — адаптивный (None, Sub, Up, Average, Paeth)' : h.filter,
    'Байт 11 IHDR. Перед сжатием каждая строка обрабатывается одним из 5 фильтров (предсказание по соседним пикселям), что улучшает сжатие.');
  detail(info, 'IHDR: чересстрочность', h.interlace === 1 ? '1 — Adam7 (7 проходов)' : '0 — нет', 'Байт 12 IHDR. Adam7 позволяет показывать изображение постепенно при загрузке.');
}

const pad = n => String(n).padStart(2, '0');
const escape = s => s.replace(/[^\x20-\x7E]/g, '?');
