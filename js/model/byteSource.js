// Побайтовый доступ к файлу без загрузки его целиком.
// Источник читает файл блоками по 64 КБ и кэширует несколько последних блоков,
// поэтому разбор заголовков обходится одним-двумя обращениями к диску.

export class FormatError extends Error {}

export class TruncatedError extends FormatError {
  constructor(offset, length, size) {
    super(`Файл обрывается: нужны байты ${offset}…${offset + length - 1}, а размер файла ${size} байт — файл обрезан`);
  }
}

export class Bytes {
  constructor(u8, base = 0) {
    this.data = u8;
    this.base = base;
    this.view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }

  get length() { return this.data.length; }

  check(i, n) {
    if (i < 0 || i + n > this.data.length) throw new TruncatedError(this.base + i, n, this.base + this.data.length);
  }

  u8(i) { this.check(i, 1); return this.data[i]; }
  u16(i, le = false) { this.check(i, 2); return this.view.getUint16(i, le); }
  i16(i, le = false) { this.check(i, 2); return this.view.getInt16(i, le); }
  u32(i, le = false) { this.check(i, 4); return this.view.getUint32(i, le); }
  i32(i, le = false) { this.check(i, 4); return this.view.getInt32(i, le); }
  f32(i, le = false) { this.check(i, 4); return this.view.getFloat32(i, le); }
  f64(i, le = false) { this.check(i, 8); return this.view.getFloat64(i, le); }

  str(i, n) {
    this.check(i, n);
    let s = '';
    for (let k = i; k < i + n; k++) s += String.fromCharCode(this.data[k]);
    return s;
  }

  // Строка, оканчивающаяся нулём (или концом блока).
  cstr(i, max = this.data.length - i) {
    let s = '';
    for (let k = i; k < Math.min(this.data.length, i + max) && this.data[k] !== 0; k++) s += String.fromCharCode(this.data[k]);
    return s;
  }

  sub(i, n = this.data.length - i) {
    this.check(i, n);
    return new Bytes(this.data.subarray(i, i + n), this.base + i);
  }

  startsWith(bytes, at = 0) {
    if (at + bytes.length > this.data.length) return false;
    return bytes.every((b, k) => this.data[at + k] === b);
  }
}

export class ByteSource {
  /**
   * @param {number} size — размер файла в байтах
   * @param {(offset: number, length: number) => Promise<Uint8Array>} readRange — чтение диапазона
   */
  constructor(size, readRange, { blockSize = 64 * 1024, maxBlocks = 4 } = {}) {
    this.size = size;
    this.readRange = readRange;
    this.blockSize = blockSize;
    this.maxBlocks = maxBlocks;
    this.blocks = new Map();
    this.bytesRead = 0;
    this.reads = 0;
  }

  static fromBytes(u8) {
    const src = new ByteSource(u8.length, async (o, l) => u8.subarray(o, o + l), { blockSize: Math.max(1, u8.length) });
    src.blocks.set(0, u8);
    return src;
  }

  async raw(offset, length) {
    const data = await this.readRange(offset, length);
    this.reads++;
    this.bytesRead += data.length;
    if (data.length < length) throw new TruncatedError(offset, length, this.size);
    return data;
  }

  async block(index) {
    let blk = this.blocks.get(index);
    if (!blk) {
      const start = index * this.blockSize;
      blk = await this.raw(start, Math.min(this.blockSize, this.size - start));
      if (this.blocks.size >= this.maxBlocks) this.blocks.delete(this.blocks.keys().next().value);
      this.blocks.set(index, blk);
    }
    return blk;
  }

  /** Возвращает Bytes для диапазона [offset, offset + length); за пределами файла — TruncatedError. */
  async bytes(offset, length) {
    if (offset < 0 || length < 0 || offset + length > this.size) throw new TruncatedError(offset, length, this.size);
    if (length === 0) return new Bytes(new Uint8Array(0), offset);
    const bs = this.blockSize;
    const first = Math.floor(offset / bs);
    if (first === Math.floor((offset + length - 1) / bs)) {
      const start = offset - first * bs;
      return new Bytes((await this.block(first)).subarray(start, start + length), offset);
    }
    if (length > bs) return new Bytes(await this.raw(offset, length), offset);
    const a = await this.block(first);
    const b = await this.block(first + 1);
    const out = new Uint8Array(length);
    const head = a.length - (offset - first * bs);
    out.set(a.subarray(a.length - head));
    out.set(b.subarray(0, length - head), head);
    return new Bytes(out, offset);
  }

  /** Последние n байт файла (читаются отдельным маленьким запросом, без блока). */
  async tail(n) {
    const len = Math.min(n, this.size);
    const offset = this.size - len;
    const bs = this.blockSize;
    const index = Math.floor(offset / bs);
    if (this.blocks.has(index) && index === Math.floor((this.size - 1) / bs)) return this.bytes(offset, len);
    return new Bytes(await this.raw(offset, len), offset);
  }
}
