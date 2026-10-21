import test from 'node:test';
import {access} from 'node:fs/promises';

test('a source checkout includes the Windows discovery helper and all served frontend files',async()=>{
  for(const file of ['scripts/discover-dsh.ps1','public/index.html','public/app.js','public/style.css','LICENSE'])await access(new URL('../'+file,import.meta.url));
});
