import { GrayBuffer } from '../model/buffer.js';
import { process } from '../model/processing.js';
self.onmessage=({data:{width,height,pixels,options}})=>{
  try {
    const result=process(new GrayBuffer(width,height,pixels),options,value=>self.postMessage({type:'progress',value}));
    self.postMessage({type:'result',pixels:result.data},[result.data.buffer]);
  } catch(error) { self.postMessage({type:'error',message:error.message}); }
};
