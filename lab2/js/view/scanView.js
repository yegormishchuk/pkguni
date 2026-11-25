import { COLUMNS, FILTERS, statusText } from '../viewmodel/scanViewModel.js';
import { FORMATS } from '../model/analyze.js';

const ROW_HEIGHT = 34;
const OVERSCAN = 8;
const RENDER_INTERVAL_SCANNING = 150;
const PREVIEWABLE = new Set(['JPEG', 'PNG', 'GIF', 'BMP']);

const FIELD_HINTS = {
  format: 'Определяется по сигнатуре в первых байтах файла. Расширение имени не учитывается, поэтому переименованные файлы распознаются верно.',
  size: 'Ширина и высота изображения в пикселях, прочитанные из заголовка (IHDR, SOF, Logical Screen Descriptor, теги 256/257, BITMAPINFOHEADER, окно PCX).',
  dpi: 'Разрешение — сколько пикселей приходится на дюйм при печати. Влияет только на физический размер отпечатка, не на число пикселей.',
  depth: 'Сколько бит отводится на один пиксель. Определяет число возможных цветов: 2^глубина.',
  colorModel: 'Как интерпретируются биты пикселя: RGB, оттенки серого, индекс палитры, CMYK, YCbCr.',
  compression: 'Алгоритм, которым сжаты данные пикселей; от него зависит размер файла и наличие потерь качества.',
  fileSize: 'Размер файла на диске.',
  read: 'Сколько байт программа реально прочитала с диска: читаются только заголовки и несколько байт в конце файла.',
};

export class ScanView {
  constructor(root, viewModel) {
    this.vm = viewModel;
    this.root = root;
    const $ = sel => root.querySelector(sel);
    this.el = {
      dirInput: $('#dirInput'), fileInput: $('#fileInput'), cancel: $('#cancelBtn'), csv: $('#csvBtn'),
      drop: $('#dropZone'), bar: $('#bar'), progress: $('#progress'), progressText: $('#progressText'),
      filters: $('#filters'), search: $('#search'), thead: $('#thead'), viewport: $('#viewport'),
      spacer: $('#spacer'), rows: $('#rows'), empty: $('#empty'), details: $('#details'), formatStats: $('#formatStats'),
    };
    this.previewUrl = null;
    this.renderedSelection = undefined;
    this.pending = false;
    this.lastRender = 0;

    this.buildHeader();
    this.buildFilters();
    this.bindInputs();
    this.el.viewport.addEventListener('scroll', () => this.renderRows(this.vm.getState()));
    this.el.viewport.addEventListener('keydown', e => this.onKey(e));
    this.el.rows.addEventListener('click', e => {
      const row = e.target.closest('.tr');
      if (row) this.vm.select(Number(row.dataset.id));
    });
    window.addEventListener('resize', () => this.renderRows(this.vm.getState()));
    this.vm.subscribe(() => this.schedule());
  }

  // Перерисовка не чаще одного раза за кадр, а во время обхода — раз в 150 мс:
  // интерфейс остаётся отзывчивым, даже когда результаты приходят тысячами.
  schedule() {
    if (this.pending) return;
    this.pending = true;
    const wait = this.vm.scanning ? Math.max(0, RENDER_INTERVAL_SCANNING - (performance.now() - this.lastRender)) : 0;
    setTimeout(() => requestAnimationFrame(() => {
      this.pending = false;
      this.lastRender = performance.now();
      this.render(this.vm.getState());
    }), wait);
  }

  buildHeader() {
    this.el.thead.innerHTML = COLUMNS.map(c =>
      `<button type="button" class="th" data-key="${c.key}" title="${esc(c.hint)}">${c.title}<span class="arrow"></span></button>`).join('');
    this.el.thead.addEventListener('click', e => {
      const th = e.target.closest('.th');
      if (th) this.vm.setSort(th.dataset.key);
    });
  }

  buildFilters() {
    this.el.filters.innerHTML = Object.entries(FILTERS).map(([key, title]) =>
      `<button type="button" class="chip chip-${key}" data-filter="${key}">${title} <b>0</b></button>`).join('');
    this.el.filters.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (chip) this.vm.setFilter(chip.dataset.filter);
    });
    this.el.search.addEventListener('input', () => this.vm.setQuery(this.el.search.value));
  }

  bindInputs() {
    const fromInput = input => {
      const items = Array.from(input.files, file => ({ file, path: file.webkitRelativePath || file.name }));
      input.value = '';
      this.start(items);
    };
    this.el.dirInput.addEventListener('change', () => fromInput(this.el.dirInput));
    this.el.fileInput.addEventListener('change', () => fromInput(this.el.fileInput));
    this.el.cancel.addEventListener('click', () => this.vm.cancel());
    this.el.csv.addEventListener('click', () => this.downloadCsv());

    const drop = this.el.drop;
    const over = on => drop.classList.toggle('dragover', on);
    ['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); over(true); }));
    document.addEventListener('dragleave', e => { if (!e.relatedTarget) over(false); });
    document.addEventListener('drop', async e => {
      e.preventDefault();
      over(false);
      // webkitGetAsEntry нужно вызвать синхронно, пока DataTransfer ещё доступен.
      const entries = Array.from(e.dataTransfer.items ?? [], it => it.webkitGetAsEntry?.()).filter(Boolean);
      this.el.progressText.textContent = 'Чтение списка файлов…';
      const items = entries.length ? await collectEntries(entries) : Array.from(e.dataTransfer.files, file => ({ file, path: file.name }));
      this.start(items);
    });
  }

  start(items) {
    this.el.viewport.scrollTop = 0;
    this.vm.start(items);
  }

  downloadCsv() {
    const url = URL.createObjectURL(new Blob([this.vm.toCsv()], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'image-info.csv' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  onKey(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = this.vm.getState().rows;
    if (!rows.length) return;
    let i = rows.findIndex(r => r.id === this.vm.selectedId);
    i = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    this.vm.select(rows[i].id);
    const vp = this.el.viewport;
    const top = i * ROW_HEIGHT;
    if (top < vp.scrollTop) vp.scrollTop = top;
    else if (top + ROW_HEIGHT > vp.scrollTop + vp.clientHeight) vp.scrollTop = top + ROW_HEIGHT - vp.clientHeight;
  }

  render(state) {
    this.renderProgress(state);
    this.renderFilters(state);
    this.renderRows(state);
    if (state.selected !== this.renderedSelection) this.renderDetails(state.selected);
  }

  renderProgress(s) {
    const pct = Math.round(s.progress * 1000) / 10;
    this.el.bar.style.width = `${s.total ? pct : 0}%`;
    this.el.progress.setAttribute('aria-valuenow', String(pct));
    this.el.progress.classList.toggle('done', !s.scanning && s.total > 0);
    this.el.cancel.hidden = !s.scanning;
    this.el.csv.disabled = s.done === 0;
    if (!s.total) {
      this.el.progressText.textContent = 'Выберите папку или файлы — или перетащите их в окно';
      this.el.formatStats.textContent = '';
      return;
    }
    const head = s.scanning ? 'Обработка' : s.cancelled ? 'Остановлено' : 'Готово';
    const read = s.bytesTotal ? ` · прочитано с диска ${fmtBytes(s.bytesRead)} из ${fmtBytes(s.bytesTotal)} (${(100 * s.bytesRead / s.bytesTotal).toFixed(2)} %)` : '';
    this.el.progressText.textContent =
      `${head}: ${s.done.toLocaleString('ru')} из ${s.total.toLocaleString('ru')} (${pct} %) · ${fmtTime(s.elapsedMs)}` +
      ` · ${Math.round(s.filesPerSecond).toLocaleString('ru')} файл/с${read}`;
    this.el.formatStats.textContent = Object.entries(s.formats).sort((a, b) => b[1] - a[1])
      .map(([f, n]) => `${f === '—' ? 'не изображения' : f}: ${n.toLocaleString('ru')}`).join(' · ');
  }

  renderFilters(s) {
    for (const chip of this.el.filters.children) {
      const key = chip.dataset.filter;
      chip.classList.toggle('active', key === s.filter);
      chip.querySelector('b').textContent = s.counts[key].toLocaleString('ru');
    }
    for (const th of this.el.thead.children) {
      const dir = s.sort?.key === th.dataset.key ? s.sort.dir : 0;
      th.classList.toggle('sorted', dir !== 0);
      th.querySelector('.arrow').textContent = dir === 1 ? ' ▲' : dir === -1 ? ' ▼' : '';
    }
  }

  // Виртуальная прокрутка: в DOM находятся только видимые строки, поэтому таблица
  // на 100 000 файлов прокручивается так же быстро, как на 10.
  renderRows(s) {
    const rows = s.rows;
    const vp = this.el.viewport;
    this.el.spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
    this.el.empty.hidden = rows.length > 0;
    this.el.empty.textContent = s.total ? 'Нет файлов, подходящих под фильтр' : 'Здесь появится таблица с информацией о файлах';
    const first = Math.max(0, Math.floor(vp.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((vp.scrollTop + vp.clientHeight) / ROW_HEIGHT) + OVERSCAN);
    this.el.rows.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
    let html = '';
    for (let i = first; i < last; i++) html += rowHtml(rows[i], rows[i].id === this.vm.selectedId);
    this.el.rows.innerHTML = html;
  }

  renderDetails(r) {
    this.renderedSelection = r;
    if (this.previewUrl) { URL.revokeObjectURL(this.previewUrl); this.previewUrl = null; }
    const d = this.el.details;
    if (!r) {
      d.innerHTML = '<p class="placeholder">Выберите файл в таблице, чтобы увидеть все прочитанные характеристики с пояснениями.</p>';
      return;
    }
    let preview = '';
    const file = this.vm.getFile(r.id);
    if (file && r.status === 'ok' && PREVIEWABLE.has(r.format)) {
      this.previewUrl = URL.createObjectURL(file);
      preview = `<div class="preview"><img src="${this.previewUrl}" alt="Предпросмотр ${esc(r.name)}" loading="lazy"></div>`;
    } else if (r.format) {
      preview = `<div class="preview none">${r.status === 'ok' ? `Браузер не умеет показывать ${r.format} — предпросмотр недоступен` : 'Предпросмотр недоступен'}</div>`;
    }
    const dpi = r.dpiX ? `${r.dpiX} × ${r.dpiY}` : 'не задано';
    const main = [
      ['Формат', r.format ? `${r.format} (сигнатура ${FORMATS[r.format].signature})` : 'не распознан', FIELD_HINTS.format],
      ['Размер', r.width !== null ? `${r.width} × ${r.height} пикс.` : '—', FIELD_HINTS.size],
      ['Разрешение', r.dpiSource && r.dpiX ? `${dpi} dpi — ${r.dpiSource}` : r.dpiSource ? `— (${r.dpiSource})` : dpi, FIELD_HINTS.dpi],
      ['Глубина цвета', r.depth ? `${r.depth} бит/пиксель (${colorsCount(r.depth)})` : '—', FIELD_HINTS.depth],
      ['Цветовая модель', r.colorModel ?? '—', FIELD_HINTS.colorModel],
      ['Сжатие', r.compression ?? '—', FIELD_HINTS.compression],
      ['Размер файла', `${fmtBytes(r.size)} (${r.size.toLocaleString('ru')} байт)`, FIELD_HINTS.fileSize],
      ['Прочитано', `${r.bytesRead.toLocaleString('ru')} байт (${r.size ? (100 * r.bytesRead / r.size).toFixed(2) : 0} % файла)`, FIELD_HINTS.read],
    ];
    d.innerHTML = `
      <h2 title="${esc(r.path)}">${esc(r.name)}</h2>
      <p class="path">${esc(r.path)}</p>
      <p><span class="badge ${badgeClass(r)}">${statusText(r)}</span></p>
      ${list('problems', r.problems)}${list('warnings', r.warnings)}
      ${preview}
      <h3>Основные характеристики</h3>
      ${dl(main)}
      ${r.details.length ? `<h3>Данные заголовка</h3>${dl(r.details.map(x => [x.label, x.value, x.hint]))}` : ''}
      ${paletteHtml(r)}
      ${quantHtml(r)}
      ${tagsHtml(r)}`;
  }
}

function rowHtml(r, selected) {
  const fmt = r.format ? r.format + (r.extMismatch ? ` <span class="warn" title="Расширение .${esc(r.ext)} не соответствует содержимому">⚠ .${esc(r.ext)}</span>` : '') : '—';
  const cells = [
    `<span class="name" title="${esc(r.path)}">${esc(r.path)}</span>`,
    fmt,
    r.width !== null ? `${r.width} × ${r.height}` : '—',
    r.dpiX ? (r.dpiX === r.dpiY ? `${r.dpiX}` : `${r.dpiX} × ${r.dpiY}`) : '<span class="muted">—</span>',
    r.depth ? `${r.depth} бит` : '—',
    esc(r.compression ?? '—'),
    fmtBytes(r.size),
    `<span class="badge ${badgeClass(r)}" title="${esc([...r.problems, ...r.warnings].join('\n'))}">${statusText(r)}</span>`,
  ];
  return `<div class="tr${selected ? ' selected' : ''}" data-id="${r.id}">${cells.map(c => `<div class="td">${c}</div>`).join('')}</div>`;
}

const badgeClass = r => (r.status === 'ok' ? (r.extMismatch ? 'b-mismatch' : 'b-ok') : r.status === 'damaged' ? 'b-damaged' : 'b-unknown');

const list = (cls, items) => (items.length ? `<ul class="${cls}">${items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '');

const dl = rows => `<dl class="fields">${rows.map(([k, v, hint]) =>
  `<div><dt>${esc(k)}</dt><dd>${esc(v)}${hint ? `<small>${esc(hint)}</small>` : ''}</dd></div>`).join('')}</dl>`;

function paletteHtml(r) {
  if (!r.palette?.length) return '';
  const cells = r.palette.map(([R, G, B], i) =>
    `<i style="background:rgb(${R},${G},${B})" title="${i}: RGB(${R}, ${G}, ${B})"></i>`).join('');
  return `<h3>Палитра (${r.paletteCount ?? r.palette.length} цв.)</h3>
    <p class="note">Таблица цветов, на которую ссылаются индексы пикселей. Наведите на ячейку, чтобы увидеть номер и цвет.</p>
    <div class="palette">${cells}</div>`;
}

function quantHtml(r) {
  if (!r.quantTables?.length) return '';
  const tables = r.quantTables.map(t => `<figure><figcaption>Таблица №${t.id} (${t.id === 0 ? 'обычно яркость Y' : 'обычно цветность Cb/Cr'})</figcaption>
    <div class="qgrid">${t.values.map(v => `<span>${v}</span>`).join('')}</div></figure>`).join('');
  return `<h3>Матрицы квантования JPEG</h3>
    <p class="note">Коэффициенты ДКП каждого блока 8×8 делятся на эти числа и округляются — так JPEG теряет мелкие детали. Левый верхний элемент относится к средней яркости блока (DC), к правому нижнему углу растут частоты.</p>
    <div class="qtables">${tables}</div>`;
}

function tagsHtml(r) {
  if (!r.tiffTags?.length) return '';
  return `<h3>Теги IFD0 (${r.tiffTags.length})</h3>
    <div class="tags"><table><thead><tr><th>Тег</th><th>Имя</th><th>Тип</th><th>Кол-во</th><th>Значение</th></tr></thead><tbody>
    ${r.tiffTags.map(t => `<tr><td>${t.tag}</td><td>${esc(t.name)}</td><td>${esc(t.type)}</td><td>${t.count}</td><td>${esc(t.value)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function colorsCount(depth) {
  if (depth > 48) return 'много цветов';
  const n = 2 ** depth;
  return n >= 1e6 ? `${(n / 1e6).toLocaleString('ru', { maximumFractionDigits: 1 })} млн цветов` : `${n.toLocaleString('ru')} цветов`;
}

/** Рекурсивный обход перетащенных папок (FileSystemEntry API). */
async function collectEntries(entries) {
  const out = [];
  const walk = async entry => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: entry.fullPath.replace(/^\//, '') });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      while (true) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString('ru', { maximumFractionDigits: v < 10 ? 2 : 1 })} ${units[i]}`;
}

const fmtTime = ms => (ms < 1000 ? `${Math.round(ms)} мс` : `${(ms / 1000).toLocaleString('ru', { maximumFractionDigits: 2 })} с`);

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
