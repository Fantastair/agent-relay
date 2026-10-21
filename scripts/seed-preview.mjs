// Seed dev fixtures without opening a port, deleting history or loading native adapters.
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';
import {seedPreviewData} from './preview.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const dataDir=process.env.RELAY_DATA_DIR||path.join(root,'data-dev');
if(path.resolve(dataDir).toLowerCase()===path.join(root,'data').toLowerCase())throw new Error('预览数据禁止写入正式 data/');
await mkdir(dataDir,{recursive:true});const store=new Store(path.join(dataDir,'relay.sqlite'));
try{seedPreviewData(store);console.log(JSON.stringify({dataDir,rooms:store.rooms().map(r=>({id:r.id,title:r.title,archived:r.archived,messages:r.messageCount})),activeRoomId:store.activeRoomId()},null,2));}
finally{store.close();}
