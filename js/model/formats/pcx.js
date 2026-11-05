// PCX: фиксированный заголовок 128 байт (ZSoft), далее данные строк, сжатые RLE,
// и для 256-цветных изображений — палитра VGA в конце файла (байт 0x0C + 768 байт RGB).
import { FormatError } from '../byteSource.js';
import { detail } from '../info.js';

export const PCX_VERSIONS = {
  0: 'PC Paintbrush 2.5',
  2: 'PC Paintbrush 2.8 с палитрой',
  3: 'PC Paintbrush 2.8 без палитры',
  4: 'PC Paintbrush для Windows',
  5: 'PC Paintbrush 3.0+ (256 цветов / 24 бит)',
};

export async function parsePcx(src, info) {
  if (src.size < 128) throw new FormatError(`Файл (${src.size} байт) меньше заголовка PCX (128 байт)`);
  const h = await src.bytes(0, 128);
  const version = h.u8(1);
  const encoding = h.u8(2);
  const bpp = h.u8(3);
  const xMin = h.u16(4, true), yMin = h.u16(6, true), xMax = h.u16(8, true), yMax = h.u16(10, true);
  const hDpi = h.u16(12, true), vDpi = h.u16(14, true);
  const planes = h.u8(65);
  const bytesPerLine = h.u16(66, true);
  const paletteInfo = h.u16(68, true);

  const width = xMax - xMin + 1;
  const height = yMax - yMin + 1;
  info.width = width;
  info.height = height;
  info.depth = bpp * planes;
  info.compression = encoding === 1 ? 'RLE (PCX)' : 'Нет';
  if (hDpi > 0 && vDpi > 0) {
    info.dpiX = hDpi;
    info.dpiY = vDpi;
    info.dpiSource = 'поля HDpi / VDpi заголовка';
  }

  if (xMax < xMin || yMax < yMin) info.problems.push(`Неверное окно изображения: (${xMin}, ${yMin}) – (${xMax}, ${yMax})`);
  if (encoding > 1) info.problems.push(`Неизвестный способ кодирования: ${encoding}`);
  if (![1, 2, 4, 8].includes(bpp)) info.problems.push(`Недопустимое число бит на пиксель в плоскости: ${bpp}`);
  if (planes < 1 || planes > 4) info.problems.push(`Недопустимое число плоскостей: ${planes}`);
  if (width > 0 && bytesPerLine < Math.ceil((width * bpp) / 8)) info.problems.push(`BytesPerLine (${bytesPerLine}) меньше, чем нужно для ширины ${width}`);
  if (encoding === 0 && 128 + bytesPerLine * planes * height > src.size) info.problems.push('Несжатые данные изображения выходят за конец файла');
  if (src.size === 128) info.problems.push('После заголовка нет данных изображения');

  // Палитра: 16 цветов EGA в заголовке (байты 16–63) или 256 цветов VGA в последних 769 байтах.
  let paletteText = null;
  if (bpp === 8 && planes === 1) {
    const vgaOffset = src.size - 769;
    const vga = vgaOffset >= 128 ? await src.bytes(vgaOffset, 769) : null;
    if (vga && vga.u8(0) === 0x0C) {
      info.palette = Array.from({ length: 256 }, (_, i) => [vga.u8(1 + i * 3), vga.u8(2 + i * 3), vga.u8(3 + i * 3)]);
      info.paletteCount = 256;
      paletteText = `256 цветов VGA (смещение ${vgaOffset})`;
    } else if (paletteInfo === 2) {
      paletteText = 'не нужна (оттенки серого)';
    } else {
      info.problems.push('Нет 256-цветной палитры в конце файла (маркер 0x0C) — файл обрезан или повреждён');
    }
  } else if (planes * bpp <= 4) {
    const n = 1 << (planes * bpp);
    info.palette = Array.from({ length: n }, (_, i) => [h.u8(16 + i * 3), h.u8(17 + i * 3), h.u8(18 + i * 3)]);
    info.paletteCount = n;
    paletteText = `${n} цветов EGA в заголовке`;
  }

  const isGray = paletteInfo === 2 || (info.palette && info.palette.every(([r, g, b]) => r === g && g === b));
  if (planes === 3 && bpp === 8) info.colorModel = 'RGB (3 плоскости по 8 бит)';
  else if (planes === 4 && bpp === 8) info.colorModel = 'RGBA / RGBI (4 плоскости)';
  else if (planes * bpp === 1) info.colorModel = 'Монохромный';
  else if (isGray && bpp === 8) info.colorModel = 'Оттенки серого';
  else info.colorModel = `Индексированный, палитра ${1 << (planes * bpp)} цв.`;

  detail(info, 'Производитель', '0x0A (ZSoft)', 'Байт 0: всегда 10 — признак формата PCX.');
  detail(info, 'Версия', `${version} — ${PCX_VERSIONS[version] ?? 'неизвестная'}`, 'Байт 1: версия PC Paintbrush, определяет наличие палитры.');
  detail(info, 'Кодирование', encoding === 1 ? '1 — RLE' : `${encoding}`, 'Байт 2. RLE PCX: байт с двумя старшими битами 11 задаёт счётчик повторов (младшие 6 бит), следующий байт — значение.');
  detail(info, 'Бит на пиксель в плоскости', bpp, 'Байт 3. Глубина цвета = бит на плоскость × число плоскостей.');
  detail(info, 'Плоскостей', planes, 'Байт 65: число цветовых плоскостей (каждая строка хранится по плоскостям).');
  detail(info, 'Окно изображения', `(${xMin}, ${yMin}) – (${xMax}, ${yMax})`, 'Байты 4–11: Xmin, Ymin, Xmax, Ymax. Размер = Xmax − Xmin + 1 на Ymax − Ymin + 1.');
  detail(info, 'Байт на строку плоскости', bytesPerLine, 'Байты 66–67: длина распакованной строки одной плоскости (всегда чётная).');
  detail(info, 'Разрешение (HDpi × VDpi)', `${hDpi} × ${vDpi}`, 'Байты 12–15: разрешение в точках на дюйм.');
  detail(info, 'Тип палитры', paletteInfo === 2 ? '2 — оттенки серого' : paletteInfo === 1 ? '1 — цвет/ч-б' : paletteInfo, 'Байты 68–69: как интерпретировать палитру.');
  if (paletteText) detail(info, 'Палитра', paletteText, '16-цветная палитра EGA хранится в байтах 16–63 заголовка; 256-цветная палитра VGA — в конце файла после байта 0x0C.');
}
