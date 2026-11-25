// Рабочий поток: получает пачку файлов, разбирает их заголовки и возвращает результаты.
// Внутри потока одновременно обрабатывается несколько файлов, чтобы диск не простаивал
// в ожидании очередного запроса.
import { analyzeBlob } from '../model/analyze.js';

const IN_FLIGHT = 6;

self.onmessage = async ({ data }) => {
  const { batchId, items } = data;
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      const { id, file, path } = items[i];
      const info = await analyzeBlob(file, { name: file.name, path });
      info.id = id;
      info.lastModified = file.lastModified;
      results[i] = info;
    }
  };
  await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, items.length) }, run));
  self.postMessage({ batchId, results });
};
