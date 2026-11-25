// Определение формата по сигнатуре (а не по расширению) и разбор заголовка.
import { ByteSource, FormatError } from './byteSource.js';
import { createInfo } from './info.js';
import { parseBmp, BMP_HEADERS } from './formats/bmp.js';
import { parsePng, PNG_SIGNATURE } from './formats/png.js';
import { parseGif } from './formats/gif.js';
import { parseJpeg } from './formats/jpeg.js';
import { parseTiff } from './formats/tiff.js';
import { parsePcx } from './formats/pcx.js';

export const FORMATS = {
  JPEG: { parse: parseJpeg, ext: ['jpg', 'jpeg', 'jpe', 'jfif'], signature: 'FF D8 FF' },
  PNG: { parse: parsePng, ext: ['png'], signature: '89 50 4E 47 0D 0A 1A 0A' },
  GIF: { parse: parseGif, ext: ['gif'], signature: '"GIF87a" / "GIF89a"' },
  TIFF: { parse: parseTiff, ext: ['tif', 'tiff'], signature: '"II*\\0" / "MM\\0*"' },
  BMP: { parse: parseBmp, ext: ['bmp', 'dib'], signature: '"BM" + размер заголовка' },
  PCX: { parse: parsePcx, ext: ['pcx'], signature: '0A + версия + кодирование' },
};

export const IMAGE_EXTENSIONS = new Set(Object.values(FORMATS).flatMap(f => f.ext));

const HEAD = 32;

/** Определяет формат по «магическим числам» в начале файла. */
export function detectFormat(b) {
  const at = i => (i < b.length ? b[i] : -1);
  const ascii = (i, s) => [...s].every((c, k) => at(i + k) === c.charCodeAt(0));
  if (at(0) === 0xFF && at(1) === 0xD8 && at(2) === 0xFF) return 'JPEG';
  if (PNG_SIGNATURE.every((v, i) => at(i) === v)) return 'PNG';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'GIF';
  if (ascii(0, 'II') && at(2) === 42 && at(3) === 0) return 'TIFF';
  if (ascii(0, 'MM') && at(2) === 0 && at(3) === 42) return 'TIFF';
  if ((ascii(0, 'II') && at(2) === 43 && at(3) === 0) || (ascii(0, 'MM') && at(2) === 0 && at(3) === 43)) return 'TIFF';
  if (ascii(0, 'BM') && b.length >= 18) {
    const hs = at(14) | (at(15) << 8) | (at(16) << 16) | (at(17) << 24);
    if (BMP_HEADERS[hs]) return 'BMP';
  }
  if (at(0) === 0x0A && [0, 2, 3, 4, 5].includes(at(1)) && (at(2) === 0 || at(2) === 1) && [1, 2, 4, 8].includes(at(3))) return 'PCX';
  return null;
}

/** Описание нераспознанного содержимого — чтобы отличить, например, текст, переименованный в .jpg. */
export function describeUnknown(b) {
  const ascii = (s, i = 0) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length === 0) return 'пустой файл';
  if (ascii('RIFF') && ascii('WEBP', 8)) return 'WebP (формат не входит в задание)';
  if (ascii('ftyp', 4)) return 'HEIF/AVIF/MP4 (формат не входит в задание)';
  if (ascii('%PDF')) return 'PDF-документ';
  if (ascii('PK\x03\x04')) return 'ZIP-архив (или документ Office)';
  if (ascii('8BPS')) return 'Photoshop PSD';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'значок ICO';
  if (ascii('BM')) return 'сигнатура "BM", но заголовок BMP неверен';
  if (ascii('II') || ascii('MM')) return 'похоже на TIFF, но магическое число неверно';
  if (ascii('MZ')) return 'исполняемый файл Windows';
  if (looksLikeText(b)) return 'текстовый файл';
  return 'неизвестная сигнатура ' + Array.from(b.subarray(0, 8), x => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function looksLikeText(b) {
  let start = b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF ? 3 : 0;
  for (let i = start; i < b.length; i++) {
    const c = b[i];
    if (c === 0 || (c < 0x20 && c !== 9 && c !== 10 && c !== 13 && c !== 12)) return false;
  }
  return true;
}

/**
 * Разбирает файл, представленный ByteSource. Никогда не бросает исключений:
 * любые ошибки разбора превращаются в статус «Файл повреждён».
 */
export async function analyze(src, { name = '', path = name } = {}) {
  const info = createInfo({ name, path, size: src.size });
  try {
    const head = src.size ? (await src.bytes(0, Math.min(HEAD, src.size))).data : new Uint8Array(0);
    info.format = detectFormat(head);
    if (info.format) {
      await FORMATS[info.format].parse(src, info);
    } else {
      info.problems.push(`Содержимое не является изображением поддерживаемого формата: ${describeUnknown(head)}`);
    }
  } catch (e) {
    info.problems.push(e instanceof FormatError ? e.message : `Ошибка разбора: ${e?.message ?? e}`);
  }

  const expected = Object.keys(FORMATS).find(f => FORMATS[f].ext.includes(info.ext)) ?? null;
  info.extMismatch = Boolean(info.format && expected && expected !== info.format) || Boolean(!info.format && expected);
  if (info.format && expected && expected !== info.format) {
    info.warnings.unshift(`Расширение .${info.ext} не соответствует содержимому: на самом деле это ${info.format}`);
  } else if (!info.format && expected) {
    info.warnings.unshift(`Подмена расширения: файл .${info.ext} не является ${expected}`);
  }

  info.status = !info.format ? 'unknown' : info.problems.length ? 'damaged' : 'ok';
  info.bytesRead = src.bytesRead;
  return info;
}

/** ByteSource поверх File/Blob браузера: читается только нужный диапазон через Blob.slice. */
export function sourceFromBlob(blob) {
  return new ByteSource(blob.size, async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()));
}

export function analyzeBlob(blob, { name = blob.name, path = name } = {}) {
  return analyze(sourceFromBlob(blob), { name, path });
}
