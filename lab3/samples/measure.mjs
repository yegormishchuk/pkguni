// Протокол для analyze.py: массивы яркости передаются в base64 через stdin.
import { readFileSync } from 'node:fs';
import { GrayBuffer } from '../js/model/buffer.js';
import { process, histogram } from '../js/model/processing.js';
const {width,height,mask,samples}=JSON.parse(readFileSync(0,'utf8'));
const truth=Buffer.from(mask,'base64'), rows=[];
for(const sample of samples) {
  const input=new GrayBuffer(width,height,Uint8Array.from(Buffer.from(sample.data,'base64')));
  for(const config of [
    {method:'niblack',k:-.2,label:'Niblack k=-0.2'},
    {method:'niblack',k:-.8,label:'Niblack k=-0.8'},
    {method:'bernsen',contrast:30,label:'Bernsen C=30'},
    {method:'bernsen',contrast:40,label:'Bernsen C=40'},
    {method:'sauvola',k:.34,label:'Sauvola k=0.34'},
    {method:'bradley',t:15,label:'Bradley t=15'},
    {method:'sauvola',k:.34,median:true,label:'Median 3x3 + Sauvola'}
  ]) {
    const start=performance.now();
    const b=config.median?process(input,{method:'median',radius:1}):input;
    const out=process(b,{...config,radius:7,border:'reflect'});
    const ms=performance.now()-start;
    let tp=0,fp=0,fn=0;
    for(let i=0;i<truth.length;i++) {const a=out.data[i]===0,t=truth[i]===0;if(a&&t)tp++;if(a&&!t)fp++;if(!a&&t)fn++;}
    rows.push({sample:sample.name,method:config.label,f1:+(2*tp/(2*tp+fp+fn)).toFixed(4),ms:+ms.toFixed(1),histogram:[...histogram(out.data)],pixels:Buffer.from(out.data).toString('base64')});
  }
}
console.log(JSON.stringify(rows));
