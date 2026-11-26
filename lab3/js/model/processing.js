import { GrayBuffer } from './buffer.js';

export function histogram(data) {
  const bins = new Uint32Array(256);
  for (const p of data) bins[p]++;
  return bins;
}
export function integral(buffer) {
  const stride = buffer.width + 1, n = stride * (buffer.height + 1);
  // Float64 необходим: сумма квадратов переполняет Uint32 уже на небольшом изображении.
  const sum = new Float64Array(n), square = new Float64Array(n);
  for (let y=1; y<=buffer.height; y++) {
    let s=0, q=0;
    for (let x=1; x<=buffer.width; x++) {
      const v=buffer.data[(y-1)*buffer.width+x-1]; s+=v; q+=v*v;
      sum[y*stride+x]=sum[(y-1)*stride+x]+s;
      square[y*stride+x]=square[(y-1)*stride+x]+q;
    }
  }
  return {sum,square,stride};
}
export function rectangle(sat, stride, x0,y0,x1,y1) {
  return sat[y1*stride+x1]-sat[y0*stride+x1]-sat[y1*stride+x0]+sat[y0*stride+x0];
}
export function options(input={}) {
  const o={method:'sauvola',radius:7,border:'reflect',k:.34,r:128,contrast:15,t:15,...input};
  if (!['niblack','bernsen','sauvola','bradley','median','minimum','maximum'].includes(o.method) ||
      !['reflect','clamp'].includes(o.border) || !Number.isInteger(o.radius) || o.radius<1 || o.radius>50 ||
      ![o.k,o.r,o.contrast,o.t].every(Number.isFinite) || o.r<=0 || o.k < -1 || o.k > 1 ||
      o.contrast<0 || o.contrast>255 || o.t<0 || o.t>100) throw new RangeError('Некорректные параметры обработки');
  return o;
}
export function process(buffer, input={}, progress=()=>{}) {
  const o=options(input), {width,height}=buffer, r=o.radius, size=2*r+1, area=size*size;
  const padded=buffer.padded(r,o.border), pw=padded.width, src=padded.data;
  const data=new Uint8Array(width*height);
  const stats=['niblack','sauvola','bradley'].includes(o.method);
  const sat=stats?integral(padded):null;
  for(let y=0;y<height;y++) {
    // Скользящая гистограмма: при сдвиге окна меняем только два столбца.
    const bins=stats?null:new Int32Array(256);
    if(bins) for(let dy=0;dy<size;dy++) for(let dx=0;dx<size;dx++) bins[src[(y+dy)*pw+dx]]++;
    for(let x=0;x<width;x++) {
      const i=y*width+x, p=buffer.data[i];
      if(stats) {
        const mean=rectangle(sat.sum,sat.stride,x,y,x+size,y+size)/area;
        const sd=Math.sqrt(Math.max(0,rectangle(sat.square,sat.stride,x,y,x+size,y+size)/area-mean*mean));
        const threshold=o.method==='niblack'?mean+o.k*sd:o.method==='sauvola'?mean*(1+o.k*(sd/o.r-1)):mean*(1-o.t/100);
        data[i]=p>threshold?255:0;
      } else {
        let lo=0,hi=255;
        while(bins[lo]===0) lo++;
        while(bins[hi]===0) hi--;
        if(o.method==='minimum') data[i]=lo;
        else if(o.method==='maximum') data[i]=hi;
        else if(o.method==='bernsen') data[i]=hi-lo<o.contrast?((lo+hi)/2>=128?255:0):(p>(lo+hi)/2?255:0);
        else {
          let cumulative=0;
          for(let v=lo;v<=hi;v++) { cumulative+=bins[v]; if(cumulative>area/2) { data[i]=v; break; } }
        }
        if(x+1<width) for(let dy=0;dy<size;dy++) { bins[src[(y+dy)*pw+x]]--; bins[src[(y+dy)*pw+x+size]]++; }
      }
    }
    if(y%16===0 || y===height-1) progress((y+1)/height);
  }
  return new GrayBuffer(width,height,data);
}
