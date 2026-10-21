// Read-only native discovery benchmark. Never creates sessions or sends messages.
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {CodexAdapter} from '../src/adapters/codex.mjs';
import {DshAdapter} from '../src/adapters/dsh.mjs';
import {CatalogCache,catalogLoaders} from '../src/catalog.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),codex=new CodexAdapter(),deepseek=new DshAdapter();
const loaders=catalogLoaders(codex,deepseek),timings={};
for(const key of Object.keys(loaders)){const load=loaders[key];loaders[key]=async()=>{const start=performance.now();try{return await load();}finally{timings[key]=Math.round(performance.now()-start);}};}
const cache=new CatalogCache(loaders);
try{
  let start=performance.now();const cold=await cache.get();const coldMs=performance.now()-start;
  start=performance.now();await cache.get();const hotMs=performance.now()-start;
  const report={checkedAt:new Date().toISOString(),readOnly:true,coldMs:Math.round(coldMs),hotMs:Number(hotMs.toFixed(2)),sourceMs:timings,counts:Object.fromEntries(Object.keys(loaders).map(key=>[key,cold[key].length])),errors:cold.errors};
  await mkdir(path.join(root,'data-dev'),{recursive:true});await writeFile(path.join(root,'data-dev','catalog-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{cache.close();codex.close();}
