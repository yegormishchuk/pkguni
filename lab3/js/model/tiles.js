import { GrayBuffer, borderIndex } from './buffer.js';
export function makeTiles(buffer, count, radius, border) {
  const tiles=[];
  count=Math.min(count,buffer.height);
  for(let i=0;i<count;i++) {
    const start=Math.floor(i*buffer.height/count), end=Math.floor((i+1)*buffer.height/count);
    const data=new Uint8Array((end-start+2*radius)*buffer.width);
    for(let y=start-radius;y<end+radius;y++) {
      const row=borderIndex(y,buffer.height,border);
      data.set(buffer.data.subarray(row*buffer.width,(row+1)*buffer.width),(y-start+radius)*buffer.width);
    }
    tiles.push({start,end,radius,buffer:new GrayBuffer(buffer.width,end-start+2*radius,data)});
  }
  return tiles;
}
export function joinTiles(width,height,tiles) {
  const data=new Uint8Array(width*height);
  for(const tile of tiles) data.set(tile.result.subarray(tile.radius*width,(tile.radius+tile.end-tile.start)*width),tile.start*width);
  return new GrayBuffer(width,height,data);
}
