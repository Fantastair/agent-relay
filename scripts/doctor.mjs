import {CodexAdapter} from '../src/adapters/codex.mjs';
import {DshAdapter} from '../src/adapters/dsh.mjs';
import {readFile} from 'node:fs/promises';
import {safeError} from '../src/util.mjs';
let config={};try{config=JSON.parse(await readFile(new URL('../config.local.json',import.meta.url),'utf8'));}catch{}
const c=new CodexAdapter(config.codex),d=new DshAdapter(config.deepseek);
for(const [name,fn] of [['Codex 桌面管道',()=>c.projects()],['DSH Host',()=>d.list()],['DSH 工作区',()=>d.workspaces()]]){try{const r=await fn();console.log(name+'：正常'+(Array.isArray(r)?'（'+r.length+' 项）':''));}catch(e){console.log(name+'：'+safeError(e));process.exitCode=1;}}
c.close();
