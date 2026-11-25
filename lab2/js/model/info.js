// Общая структура результата разбора одного файла.

export const STATUS = {
  ok: 'Исправен',
  damaged: 'Файл повреждён',
  unknown: 'Не изображение',
};

export function createInfo({ name = '', path = name, size = 0 } = {}) {
  return {
    name,
    path,
    ext: extensionOf(name),
    size,
    format: null,
    width: null,
    height: null,
    dpiX: null,
    dpiY: null,
    dpiSource: null,
    depth: null,
    colorModel: null,
    compression: null,
    status: 'ok',
    problems: [],
    warnings: [],
    details: [],
    palette: null,
    quantTables: null,
    tiffTags: null,
    bytesRead: 0,
  };
}

export function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Дополнительная характеристика: подпись, значение и пояснение, откуда она берётся. */
export function detail(info, label, value, hint = '') {
  if (value === undefined || value === null || value === '') return;
  info.details.push({ label, value: String(value), hint });
}

export const PER_INCH_FROM_METER = 0.0254;
export const PER_INCH_FROM_CM = 2.54;

// Пиксели на метр (BMP, PNG) — целое число, поэтому 96 dpi хранится как 3780 и даёт 96,012.
// Значения, отличающиеся от целого меньше чем на 0,05, округляются до целого.
export const roundDpi = v => (Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : Math.round(v * 100) / 100);

export function setDpi(info, x, y, source) {
  if (!(x > 0) || !(y > 0)) return;
  info.dpiX = roundDpi(x);
  info.dpiY = roundDpi(y);
  info.dpiSource = source;
}

export const hex = (n, width = 2) => '0x' + n.toString(16).toUpperCase().padStart(width, '0');
