import { ScanViewModel } from './viewmodel/scanViewModel.js';
import { ScanView } from './view/scanView.js';
import { WorkerPool, defaultPoolSize } from './services/workerPool.js';

// Число потоков можно задать параметром адреса ?threads=N (для сравнения быстродействия).
const threads = Number(new URLSearchParams(location.search).get('threads')) || defaultPoolSize();
const pool = new WorkerPool({ workerUrl: new URL('./worker/scanWorker.js', import.meta.url), size: threads });
new ScanView(document, new ScanViewModel({ scanner: pool }));
