import test from 'node:test';
import assert from 'node:assert/strict';
import { GrayBuffer, borderIndex, fromRGBA } from '../js/model/buffer.js';
import { process, integral, rectangle, histogram } from '../js/model/processing.js';
import { makeTiles, joinTiles } from '../js/model/tiles.js';

test('Reflect и Clamp корректны для дальних координат и одного пикселя', () => {
  assert.deepEqual([-2,-1,0,1,2,3,4].map(i => borderIndex(i,3,'reflect')), [2,1,0,1,2,1,0]);
  assert.deepEqual([-2,-1,0,1,2,3,4].map(i => borderIndex(i,3,'clamp')), [0,0,0,1,2,2,2]);
  assert.equal(borderIndex(-50,1,'reflect'),0);
});
test('RGBA преобразуется в яркость с композицией прозрачности на белый фон', () => {
  assert.deepEqual([...fromRGBA(new Uint8ClampedArray([255,0,0,255,0,0,0,0]),2,1).data], [76,255]);
});
test('SAT хранит суммы и квадраты без переполнения 32 бит', () => {
  const b = new GrayBuffer(300,300,new Uint8Array(90000).fill(255));
  const sat=integral(b);
  assert.equal(rectangle(sat.sum,sat.stride,0,0,300,300),90000*255);
  assert.equal(rectangle(sat.square,sat.stride,0,0,300,300),90000*255*255);
});

// Независимый медленный эталон: собираем каждое окно и сортируем.
function reference(b, o) {
  const out=[];
  for(let y=0;y<b.height;y++) for(let x=0;x<b.width;x++) {
    const values=[];
    for(let dy=-o.radius;dy<=o.radius;dy++) for(let dx=-o.radius;dx<=o.radius;dx++) values.push(b.at(x+dx,y+dy,o.border));
    values.sort((a,b)=>a-b);
    const mean=values.reduce((s,v)=>s+v,0)/values.length;
    const sd=Math.sqrt(Math.max(0,values.reduce((s,v)=>s+v*v,0)/values.length-mean*mean));
    const lo=values[0], hi=values.at(-1), p=b.at(x,y);
    if(o.method==='median') out.push(values[values.length>>1]);
    else if(o.method==='minimum') out.push(lo);
    else if(o.method==='maximum') out.push(hi);
    else if(o.method==='niblack') out.push(p>mean+o.k*sd?255:0);
    else if(o.method==='sauvola') out.push(p>mean*(1+o.k*(sd/o.r-1))?255:0);
    else if(o.method==='bernsen') out.push(hi-lo<o.contrast?((lo+hi)/2>=128?255:0):(p>(lo+hi)/2?255:0));
    else if(o.method==='bradley') out.push(p>mean*(1-o.t/100)?255:0);
  }
  return out;
}
for(const method of ['niblack','bernsen','sauvola','bradley','median','minimum','maximum']) {
  for(const border of ['reflect','clamp']) test(`${method}/${border}: совпадение с эталоном, включая края`, () => {
    const b=new GrayBuffer(7,5,Uint8Array.from({length:35},(_,i)=>(i*73+29)%256));
    for(const radius of [1,2,5]) {
      const o={method,border,radius,k:method==='niblack'?-.2:.34,r:128,contrast:15,t:15};
      assert.deepEqual([...process(b,o).data],reference(b,o));
    }
  });
  test(`${method}: полосы с перекрытием дают тот же результат, что один поток`, () => {
    const b=new GrayBuffer(13,11,Uint8Array.from({length:143},(_,i)=>(i*137)%256));
    for (const border of ['reflect','clamp']) {
      const o={method,border,radius:3,k:.2,r:128,contrast:15,t:15};
      const tiles=makeTiles(b,4,o.radius,border);
      const joined=joinTiles(13,11,tiles.map(tile=>({...tile,result:process(tile.buffer,o).data})));
      assert.deepEqual([...joined.data],[...process(b,o).data]);
    }
  });
}
test('Медиана устраняет одиночный импульс, минимум/максимум выбирают ранг', () => {
  const b=new GrayBuffer(3,3,Uint8Array.from([50,50,50,50,255,50,50,50,50]));
  assert.equal(process(b,{method:'median',radius:1}).data[4],50);
  assert.equal(process(b,{method:'minimum',radius:1}).data[4],50);
  assert.equal(process(b,{method:'maximum',radius:1}).data[4],255);
});
test('Пустые, некорректные буферы и параметры отклоняются', () => {
  assert.throws(()=>new GrayBuffer(0,1,new Uint8Array()));
  assert.throws(()=>new GrayBuffer(2,2,new Uint8Array(3)));
  const b=new GrayBuffer(1,1,Uint8Array.of(0));
  for(const o of [{radius:0},{radius:1.5},{method:'bad'},{r:0},{k:NaN},{border:'bad'}]) assert.throws(()=>process(b,o));
});
test('Один пиксель и гистограмма', () => {
  const b=new GrayBuffer(1,1,Uint8Array.of(127));
  assert.equal(process(b,{method:'median',radius:5}).data[0],127);
  const h=histogram(Uint8Array.of(0,0,127,255));
  assert.equal(h[0],2); assert.equal(h[127],1); assert.equal(h[255],1);
  assert.equal(h.reduce((a,b)=>a+b,0),4);
});
