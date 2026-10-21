import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {sleep} from '../src/util.mjs';
import {liveTestContext} from '../src/integration-guard.mjs';
import {pathToFileURL} from 'node:url';
const context=liveTestContext();if(!context){console.log('SKIP restart-test：需明确 --live 和独立目标配置');process.exit(0);}
const dir=pathToFileURL(context.dataDir+'/'),key=(await readFile(new URL('control.key',dir),'utf8')).trim(),instance={url:context.url},live=JSON.parse(await readFile(new URL('live-test-report.json',dir),'utf8'));
let s;for(let i=0;i<15;i++){s=await (await fetch(instance.url+'/api/state',{headers:{authorization:'Bearer '+key}})).json();if(s.health.codex?.ok&&s.health.deepseek?.ok)break;await sleep(1000);}
assert.equal(s.settings.paused,true);assert.equal(s.settings.codexId,live.channels.codexId);assert.equal(s.settings.deepseekId,live.channels.deepseekId);assert.equal(s.messages.length,live.messageCount);assert.equal(s.deliveries.length,live.deliveryCount);assert(s.deliveries.every(d=>d.status==='completed'));assert(s.health.codex.ok&&s.health.deepseek.ok);
await sleep(2200);const again=await (await fetch(instance.url+'/api/state',{headers:{authorization:'Bearer '+key}})).json();assert.equal(again.messages.length,s.messages.length);assert.equal(again.deliveries.length,s.deliveries.length);
const report={ok:true,checkedAt:new Date().toISOString(),messageCount:s.messages.length,deliveryCount:s.deliveries.length,paused:s.settings.paused,bothConnected:true,noReplay:true};await writeFile(new URL('restart-test-report.json',dir),JSON.stringify(report,null,2));console.log(report);
