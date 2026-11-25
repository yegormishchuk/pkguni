// GIF: заголовок "GIF87a"/"GIF89a", логический экран, глобальная палитра, затем блоки
// (расширения 0x21, изображения 0x2C) и терминатор 0x3B.
import { FormatError } from '../byteSource.js';
import { detail, hex } from '../info.js';

export async function parseGif(src, info) {
  const h = await src.bytes(0, 13);
  const version = h.str(3, 3);
  const width = h.u16(6, true);
  const height = h.u16(8, true);
  const packed = h.u8(10);
  const hasGct = (packed & 0x80) !== 0;
  const colorResolution = ((packed >> 4) & 7) + 1;
  const gctBits = (packed & 7) + 1;
  const bgIndex = h.u8(11);
  const aspect = h.u8(12);

  info.width = width;
  info.height = height;
  info.compression = 'LZW';
  info.dpiSource = 'не хранится в GIF';

  let pos = 13;
  let paletteBits = null;
  if (hasGct) {
    paletteBits = gctBits;
    const count = 1 << gctBits;
    const p = await src.bytes(pos, count * 3);
    info.palette = Array.from({ length: count }, (_, i) => [p.u8(i * 3), p.u8(i * 3 + 1), p.u8(i * 3 + 2)]);
    info.paletteCount = count;
    pos += count * 3;
  }

  let frames = 0;
  let delay = 0;
  let loops = null;
  let transparent = false;
  let interlaced = false;
  let lzwMin = null;
  let firstFrame = null;
  const comments = [];
  let localPalettes = 0;

  // Пропуск цепочки подблоков данных: [длина][данные]…[0].
  const skipSubBlocks = async () => {
    while (true) {
      const n = (await src.bytes(pos, 1)).u8(0);
      pos += 1 + n;
      if (n === 0) return;
    }
  };

  let terminated = false;
  try {
    while (pos < src.size) {
      const introducer = (await src.bytes(pos, 1)).u8(0);
      if (introducer === 0x3B) { terminated = true; break; }
      if (introducer === 0x21) {
        const label = (await src.bytes(pos + 1, 1)).u8(0);
        pos += 2;
        if (label === 0xF9) {
          const g = await src.bytes(pos, 6);
          if ((g.u8(1) & 1) !== 0) transparent = true;
          delay += g.u16(2, true);
        } else if (label === 0xFF) {
          const a = await src.bytes(pos, 12);
          const app = a.str(1, 11);
          if ((app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') && pos + 16 <= src.size) {
            const l = await src.bytes(pos + 12, 4);
            if (l.u8(0) >= 3 && l.u8(1) === 1) loops = l.u16(2, true);
          }
        } else if (label === 0xFE) {
          const n = (await src.bytes(pos, 1)).u8(0);
          if (n) comments.push((await src.bytes(pos + 1, n)).str(0, Math.min(n, 120)));
        }
        await skipSubBlocks();
      } else if (introducer === 0x2C) {
        const d = await src.bytes(pos, 10);
        const fp = d.u8(9);
        const lct = (fp & 0x80) !== 0;
        const lctBits = (fp & 7) + 1;
        if (frames === 0) {
          firstFrame = { left: d.u16(1, true), top: d.u16(3, true), w: d.u16(5, true), h: d.u16(7, true) };
          interlaced = (fp & 0x40) !== 0;
          if (paletteBits === null && lct) {
            paletteBits = lctBits;
            const count = 1 << lctBits;
            const p = await src.bytes(pos + 10, count * 3);
            info.palette = Array.from({ length: count }, (_, i) => [p.u8(i * 3), p.u8(i * 3 + 1), p.u8(i * 3 + 2)]);
            info.paletteCount = count;
          }
        }
        if (lct) localPalettes++;
        pos += 10 + (lct ? 3 * (1 << lctBits) : 0);
        const min = (await src.bytes(pos, 1)).u8(0);
        if (lzwMin === null) lzwMin = min;
        if (min < 2 || min > 8) throw new FormatError(`Недопустимый минимальный размер кода LZW: ${min}`);
        pos += 1;
        await skipSubBlocks();
        frames++;
      } else {
        throw new FormatError(`Неизвестный блок ${hex(introducer)} на смещении ${pos}`);
      }
    }
  } catch (e) {
    if (!(e instanceof FormatError)) throw e;
    info.problems.push(e.message);
  }

  if (!terminated && !info.problems.length) info.problems.push('Нет терминатора 0x3B: поток блоков обрывается — файл обрезан');
  else if (terminated && pos + 1 < src.size) info.warnings.push(`После терминатора 0x3B есть ${src.size - pos - 1} лишних байт`);
  if (frames === 0 && !info.problems.length) info.problems.push('В файле нет ни одного изображения (блока 0x2C)');

  info.depth = paletteBits;
  info.colorModel = paletteBits ? `Индексированный, палитра ${1 << paletteBits} цв.` : 'Индексированный (без палитры)';
  if (lzwMin !== null) info.compression = `LZW (нач. размер кода ${lzwMin + 1} бит)`;

  detail(info, 'Версия', `GIF${version}`, 'Байты 0–5: «GIF87a» или «GIF89a» (89a добавила расширения: прозрачность, анимацию, комментарии).');
  detail(info, 'Логический экран', `${width} × ${height}`, 'Logical Screen Descriptor, байты 6–9 (little-endian): область, на которой отображаются все кадры.');
  detail(info, 'Глобальная палитра', hasGct ? `${1 << gctBits} цветов (${gctBits} бит на индекс)` : 'отсутствует',
    'Бит 7 упакованного байта 10 — флаг наличия, биты 0–2 — размер N: в палитре 2^(N+1) троек RGB. Глубина цвета GIF = число бит индекса палитры.');
  detail(info, 'Разрешение цвета', `${colorResolution} бит на канал`, 'Биты 4–6 байта 10: сколько бит на основной цвет было в исходном изображении.');
  if (hasGct) detail(info, 'Индекс цвета фона', bgIndex, 'Байт 11: номер цвета глобальной палитры для незакрашенных областей экрана.');
  detail(info, 'Соотношение сторон пикселя', aspect ? ((aspect + 15) / 64).toFixed(3) : 'не задано (квадратный)', 'Байт 12: (N + 15) / 64. Физического разрешения (DPI) GIF не хранит.');
  detail(info, 'Кадров', frames, 'Число дескрипторов изображения (блоков 0x2C) до терминатора 0x3B.');
  if (frames > 1) {
    detail(info, 'Длительность анимации', `${(delay / 100).toFixed(2)} с`, 'Сумма задержек из Graphic Control Extension (0x21 0xF9), единица — 1/100 с.');
    detail(info, 'Повторы', loops === null ? 'не заданы (1 раз)' : loops === 0 ? 'бесконечно' : loops, 'Расширение приложения NETSCAPE2.0: счётчик повторов анимации.');
  }
  if (firstFrame) detail(info, 'Первый кадр', `${firstFrame.w} × ${firstFrame.h} в позиции (${firstFrame.left}, ${firstFrame.top})`, 'Image Descriptor: положение и размер кадра на логическом экране.');
  if (localPalettes) detail(info, 'Локальных палитр', localPalettes, 'Кадры с собственной палитрой (флаг в байте 9 дескриптора изображения).');
  detail(info, 'Чересстрочность', interlaced ? 'да (4 прохода)' : 'нет', 'Бит 6 упакованного байта дескриптора изображения.');
  detail(info, 'Прозрачность', transparent ? 'есть' : 'нет', 'Флаг прозрачного цвета в Graphic Control Extension.');
  if (comments.length) detail(info, 'Комментарий', comments[0], 'Comment Extension (0x21 0xFE).');
}
