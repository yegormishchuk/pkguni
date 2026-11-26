// Общая обёртка над памятью. Никаких DOM/Canvas-зависимостей.
export function borderIndex(i, size, mode = 'reflect') {
  if (mode === 'clamp') return Math.max(0, Math.min(size - 1, i));
  if (mode !== 'reflect') throw new RangeError('Неизвестный режим границ');
  if (size === 1) return 0;
  const period = 2 * (size - 1);
  const j = ((i % period) + period) % period;
  return j < size ? j : period - j;
}
export class GrayBuffer {
  constructor(width, height, data) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height) {
      throw new RangeError('Некорректный пиксельный буфер');
    }
    Object.assign(this, { width, height, data });
  }
  at(x, y, border = 'reflect') {
    return this.data[borderIndex(y, this.height, border) * this.width + borderIndex(x, this.width, border)];
  }
  padded(radius, border) {
    const width = this.width + 2 * radius, height = this.height + 2 * radius;
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = this.at(x-radius, y-radius, border);
    return new GrayBuffer(width, height, data);
  }
}
export function fromRGBA(rgba, width, height) {
  if (rgba.length !== width * height * 4) throw new RangeError('Некорректный RGBA-буфер');
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    const j = 4 * i, a = rgba[j+3] / 255;
    data[i] = Math.round((.299 * rgba[j] + .587 * rgba[j+1] + .114 * rgba[j+2]) * a + 255 * (1-a));
  }
  return new GrayBuffer(width, height, data);
}
