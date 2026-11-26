import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { Processor } from '../js/services/processor.js';
import { GrayBuffer } from '../js/model/buffer.js';

// Адаптер браузерного API к настоящим потокам Node. Запускается тот же
// processWorker.js; математические вычисления не подменяются.
class ModuleWorker extends NodeWorker {
  constructor(url) {
    const bootstrap=`
      import { parentPort } from 'node:worker_threads';
      globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};
      await import(${JSON.stringify(url.href)});
      parentPort.on('message',data=>self.onmessage({data}));
    `;
    super(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),{type:'module'});
  }
  set onmessage(handler) { this.on('message',data=>handler({data})); }
  set onerror(handler) { this.on('error',handler); }
}

test('Отмена первого запуска не останавливает потоки следующего', async () => {
  const previous=globalThis.Worker;
  globalThis.Worker=ModuleWorker;
  const processor=new Processor();
  let timer;
  try {
    const buffer=new GrayBuffer(120,80,new Uint8Array(9600).fill(100));
    const first=processor.run(buffer,{method:'median',radius:5},2,()=>{}).catch(error=>error.name);
    const next=processor.run(buffer,{method:'median',radius:1},2,()=>{});
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Повторный запуск завис')),3000);});
    const result=await Promise.race([next,timeout]);
    assert.equal(await first,'AbortError');
    assert.deepEqual(result.data,buffer.data);
  } finally {
    clearTimeout(timer); processor.cancel(); globalThis.Worker=previous;
  }
});
