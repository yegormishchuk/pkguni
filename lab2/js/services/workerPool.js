// Пул Web Worker'ов: раздаёт файлы пачками свободным потокам (динамическая балансировка),
// поэтому медленный файл в одном потоке не задерживает остальные.

export const defaultPoolSize = () => Math.max(2, Math.min(8, (globalThis.navigator?.hardwareConcurrency ?? 4)));

export class WorkerPool {
  constructor({ workerUrl, size = defaultPoolSize(), batchSize = 32 } = {}) {
    this.workerUrl = workerUrl;
    this.size = size;
    this.batchSize = batchSize;
    this.workers = [];
    this.active = null;
  }

  /**
   * @param {{id: number, file: File, path: string}[]} items
   * @param {(results: object[]) => void} onResults
   * @returns {Promise<boolean>} true — обход завершён, false — отменён
   */
  scan(items, onResults) {
    this.cancel();
    return new Promise(resolve => {
      const job = { items, cursor: 0, pending: 0, resolve, onResults, cancelled: false };
      this.active = job;
      const count = Math.min(this.size, Math.max(1, Math.ceil(items.length / this.batchSize)));
      while (this.workers.length < count) this.workers.push(new Worker(this.workerUrl, { type: 'module' }));
      if (!items.length) { this.finish(job, true); return; }
      for (const w of this.workers.slice(0, count)) {
        w.onmessage = ({ data }) => this.onMessage(job, w, data);
        w.onerror = e => { e.preventDefault?.(); this.onMessage(job, w, { results: [] }); };
        this.dispatch(job, w);
      }
    });
  }

  dispatch(job, worker) {
    if (job.cursor >= job.items.length) return false;
    // Первые пачки маленькие — чтобы таблица заполнялась сразу, дальше — крупнее.
    const size = job.cursor < this.size * 8 ? 8 : this.batchSize;
    const batch = job.items.slice(job.cursor, job.cursor + size);
    job.cursor += batch.length;
    job.pending++;
    worker.postMessage({ batchId: job.cursor, items: batch });
    return true;
  }

  onMessage(job, worker, data) {
    if (job.cancelled) return;
    job.pending--;
    job.onResults(data.results);
    if (!this.dispatch(job, worker) && job.pending === 0) this.finish(job, true);
  }

  finish(job, completed) {
    if (this.active === job) this.active = null;
    job.resolve(completed);
  }

  /** Отмена: потоки уничтожаются (это мгновенно прерывает чтение), при следующем обходе создаются заново. */
  cancel() {
    const job = this.active;
    if (!job) return;
    job.cancelled = true;
    this.workers.forEach(w => w.terminate());
    this.workers = [];
    this.finish(job, false);
  }
}
