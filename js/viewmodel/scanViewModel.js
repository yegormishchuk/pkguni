// Состояние приложения: результаты обхода, прогресс, фильтры, сортировка и выбранный файл.
// Не обращается к DOM; источник результатов (пул потоков) передаётся снаружи.

export const FILTERS = {
  all: 'Все',
  ok: 'Исправные',
  damaged: 'Повреждённые',
  unknown: 'Не изображения',
  mismatch: 'Подмена расширения',
};

export const COLUMNS = [
  { key: 'name', title: 'Имя файла', hint: 'Имя и путь файла внутри выбранной папки.' },
  { key: 'format', title: 'Формат', hint: 'Определяется по сигнатуре (магическим байтам) в начале файла, а не по расширению.' },
  { key: 'pixels', title: 'Размер, px', hint: 'Ширина × высота в пикселях из заголовка формата.' },
  { key: 'dpi', title: 'DPI', hint: 'Точек на дюйм по горизонтали и вертикали. «—» — формат или файл его не хранит.' },
  { key: 'depth', title: 'Глубина', hint: 'Бит на пиксель: бит на канал × число каналов (или размер индекса палитры).' },
  { key: 'compression', title: 'Сжатие', hint: 'Алгоритм сжатия данных пикселей, записанный в заголовке.' },
  { key: 'size', title: 'Объём', hint: 'Размер файла на диске.' },
  { key: 'status', title: 'Статус', hint: 'Результат проверки целостности файла.' },
];

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
const STATUS_ORDER = { ok: 0, damaged: 1, unknown: 2 };

const SORTERS = {
  name: (a, b) => collator.compare(a.path, b.path),
  format: (a, b) => collator.compare(a.format ?? '~', b.format ?? '~'),
  pixels: (a, b) => (a.width ?? -1) * (a.height ?? -1) - (b.width ?? -1) * (b.height ?? -1),
  dpi: (a, b) => (a.dpiX ?? -1) - (b.dpiX ?? -1),
  depth: (a, b) => (a.depth ?? -1) - (b.depth ?? -1),
  compression: (a, b) => collator.compare(a.compression ?? '~', b.compression ?? '~'),
  size: (a, b) => a.size - b.size,
  status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || Number(b.extMismatch) - Number(a.extMismatch),
};

export function matchesFilter(row, filter) {
  switch (filter) {
    case 'all': return true;
    case 'mismatch': return row.extMismatch;
    default: return row.status === filter;
  }
}

export class ScanViewModel {
  /**
   * @param {{ scanner: { scan(items, onResults): Promise<boolean>, cancel(): void }, now?: () => number }} deps
   */
  constructor({ scanner, now = () => performance.now() }) {
    this.scanner = scanner;
    this.now = now;
    this.listeners = new Set();
    this.filter = 'all';
    this.query = '';
    this.sort = null;
    this.selectedId = null;
    this.reset([]);
  }

  reset(items) {
    this.items = items;
    this.results = new Array(items.length);
    this.done = 0;
    this.bytesRead = 0;
    this.bytesTotal = items.reduce((s, it) => s + it.file.size, 0);
    this.counts = { all: 0, ok: 0, damaged: 0, unknown: 0, mismatch: 0 };
    this.formats = {};
    this.scanning = false;
    this.cancelled = false;
    this.startedAt = null;
    this.finishedAt = null;
    this.selectedId = null;
    this.version = 0;
    this.visibleCache = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this);
    return () => this.listeners.delete(listener);
  }

  notify(dataChanged = true) {
    if (dataChanged) this.version++;
    this.listeners.forEach(fn => fn(this));
  }

  /** Запускает обход. items — массив { file, path }. */
  async start(items) {
    this.scanner.cancel();
    const token = (this.token = {});
    this.reset(items.map((it, id) => ({ id, file: it.file, path: it.path ?? it.file.name })));
    this.scanning = true;
    this.startedAt = this.now();
    this.notify();
    const completed = await this.scanner.scan(this.items, results => this.addResults(results));
    if (this.token !== token) return completed; // за это время запущен новый обход
    this.scanning = false;
    this.cancelled = !completed;
    this.finishedAt = this.now();
    this.notify();
    return completed;
  }

  cancel() {
    if (this.scanning) this.scanner.cancel();
  }

  addResults(results) {
    for (const r of results) {
      if (this.results[r.id]) continue;
      this.results[r.id] = r;
      this.done++;
      this.bytesRead += r.bytesRead;
      this.counts.all++;
      this.counts[r.status]++;
      if (r.extMismatch) this.counts.mismatch++;
      const f = r.format ?? '—';
      this.formats[f] = (this.formats[f] ?? 0) + 1;
    }
    this.notify();
  }

  setFilter(filter) {
    if (!FILTERS[filter]) throw new Error(`Неизвестный фильтр: ${filter}`);
    this.filter = filter;
    this.notify();
  }

  setQuery(query) {
    this.query = query.trim().toLowerCase();
    this.notify();
  }

  /** Повторный выбор той же колонки меняет направление, третий — сбрасывает сортировку. */
  setSort(key) {
    if (!SORTERS[key]) throw new Error(`Неизвестная колонка: ${key}`);
    if (this.sort?.key !== key) this.sort = { key, dir: 1 };
    else if (this.sort.dir === 1) this.sort = { key, dir: -1 };
    else this.sort = null;
    this.notify();
  }

  select(id) {
    this.selectedId = id;
    this.notify(false);
  }

  getFile(id) {
    return this.items[id]?.file ?? null;
  }

  visibleRows() {
    const key = this.version;
    if (this.visibleCache?.key === key) return this.visibleCache.rows;
    const { filter, query, sort } = this;
    const rows = [];
    for (const r of this.results) {
      if (!r || !matchesFilter(r, filter)) continue;
      if (query && !r.path.toLowerCase().includes(query)) continue;
      rows.push(r);
    }
    if (sort) {
      const cmp = SORTERS[sort.key];
      rows.sort((a, b) => sort.dir * cmp(a, b) || a.id - b.id);
    }
    this.visibleCache = { key, rows };
    return rows;
  }

  getState() {
    const elapsed = this.startedAt === null ? 0 : (this.finishedAt ?? this.now()) - this.startedAt;
    return {
      scanning: this.scanning,
      cancelled: this.cancelled,
      total: this.items.length,
      done: this.done,
      progress: this.items.length ? this.done / this.items.length : 0,
      elapsedMs: elapsed,
      filesPerSecond: elapsed > 0 ? (this.done * 1000) / elapsed : 0,
      bytesRead: this.bytesRead,
      bytesTotal: this.bytesTotal,
      counts: { ...this.counts },
      formats: { ...this.formats },
      filter: this.filter,
      query: this.query,
      sort: this.sort,
      rows: this.visibleRows(),
      selected: this.selectedId === null ? null : this.results[this.selectedId] ?? null,
    };
  }

  toCsv() {
    const head = ['Путь', 'Формат', 'Ширина', 'Высота', 'DPI X', 'DPI Y', 'Глубина цвета', 'Цветовая модель', 'Сжатие', 'Размер файла', 'Статус', 'Проблемы'];
    const esc = v => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = this.visibleRows().map(r => [
      r.path, r.format, r.width, r.height, r.dpiX, r.dpiY, r.depth, r.colorModel, r.compression, r.size,
      statusText(r), [...r.problems, ...r.warnings].join(' | '),
    ].map(esc).join(';'));
    return '﻿' + [head.join(';'), ...lines].join('\r\n');
  }
}

export function statusText(r) {
  if (r.status === 'unknown') return 'Не изображение';
  if (r.status === 'damaged') return 'Файл повреждён';
  return r.extMismatch ? 'Неверное расширение' : 'Исправен';
}
