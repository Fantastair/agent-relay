import {readFile,writeFile} from 'node:fs/promises';
const dir=new URL('../data/',import.meta.url),instance=JSON.parse(await readFile(new URL('instance.json',dir),'utf8')),key=(await readFile(new URL('control.key',dir),'utf8')).trim();
const r=await fetch(instance.url+'/api/provision',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(240000)}),j=await r.json();
await writeFile(new URL('provision-result.json',dir),JSON.stringify({ok:r.ok,...j},null,2));console.log({ok:r.ok,...j});if(!r.ok)process.exitCode=1;
