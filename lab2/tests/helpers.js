import { openAsBlob } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';
import { analyzeBlob, analyze } from '../js/model/analyze.js';
import { ByteSource } from '../js/model/byteSource.js';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const CHECK_DIR = fileURLToPath(new URL('../Для проверки Lab2/', import.meta.url));

/** Разбор файла с диска тем же кодом, что и в браузере (Blob с ленивым чтением). */
export async function analyzePath(path) {
  return analyzeBlob(await openAsBlob(path), { name: basename(path) });
}

export const fixture = name => analyzePath(join(FIXTURES, name));

export const analyzeBytes = (bytes, name) => analyze(ByteSource.fromBytes(bytes), { name });
