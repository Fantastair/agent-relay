import {readFile} from 'node:fs/promises';
const base=new URL('../data/',import.meta.url),key=(await readFile(new URL('control.key',base),'utf8')).trim(),instance=JSON.parse(await readFile(new URL('instance.json',base),'utf8'));
const r=await fetch(instance.url+'/api/state',{headers:{authorization:'Bearer '+key}}),s=await r.json();
console.log(JSON.stringify({settings:s.settings,health:s.health,messages:s.messages.map(m=>({id:m.id,from:m.sender,text:m.text,meta:m.meta})),deliveries:s.deliveries.map(d=>({id:d.id,side:d.side,status:d.status,error:d.error,receipt:d.receipt})),logs:s.logs.slice(0,4)},null,2));
