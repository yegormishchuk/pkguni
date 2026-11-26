import { makeTiles, joinTiles } from '../model/tiles.js';
import { options as validate } from '../model/processing.js';
export class Processor {
  current=null;
  cancel() {
    const job=this.current;
    if(!job) return;
    job.reject?.(new DOMException('Обработка отменена','AbortError'));
    job.workers.forEach(worker=>worker.terminate());
    this.current=null;
  }
  async run(buffer,input,count,onProgress) {
    this.cancel();
    const options=validate(input), tiles=makeTiles(buffer,count,options.radius,options.border);
    const job={workers:[],reject:null}; this.current=job;
    const progress=tiles.map(()=>0);
    const results=tiles.map((tile,i)=>new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('../worker/processWorker.js',import.meta.url),{type:'module'});
      job.workers.push(worker);
      worker.onerror=()=>reject(new Error('Не удалось запустить обработку. Откройте приложение через HTTP-сервер.'));
      worker.onmessage=({data})=>{
        if(data.type==='progress') { progress[i]=data.value; onProgress(progress.reduce((s,v)=>s+v,0)/tiles.length); }
        else if(data.type==='error') reject(new Error(data.message));
        else if(data.type==='result') { worker.terminate(); resolve({...tile,result:data.pixels}); }
      };
      worker.postMessage({width:tile.buffer.width,height:tile.buffer.height,pixels:tile.buffer.data,options},[tile.buffer.data.buffer]);
    }));
    try {
      const all=await Promise.race([Promise.all(results),new Promise((_,reject)=>{job.reject=reject;})]);
      return joinTiles(buffer.width,buffer.height,all);
    } finally {
      job.reject=null;
      job.workers.forEach(worker=>worker.terminate());
      if(this.current===job) this.current=null;
    }
  }
}
