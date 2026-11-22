import {analyze,reclassify} from './engine.mjs';

let cache=null;
self.addEventListener('message',({data:message})=>{
  const {type,id}=message;
  const onProgress=progress=>self.postMessage({type:'progress',id,progress});
  try {
    let analysis;
    if(type==='analyze') analysis=analyze(message.data,{onProgress});
    else if(type==='reclassify') analysis=reclassify(cache,message.p,message.delta,{onProgress});
    else throw new Error('未知的计算请求。');
    cache=analysis.cache;
    self.postMessage({type:'result',id,result:analysis.result});
  } catch(error) {
    self.postMessage({type:'error',id,error:error instanceof Error?error.message:String(error)});
  }
});
