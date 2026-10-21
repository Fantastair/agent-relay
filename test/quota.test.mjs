import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {normalizeQuotaSnapshot,readQuotaSnapshot} from '../src/quota.mjs';
const now=1800000000000;
const fresh={usedPercent:27,remainingPercent:999,window:'5h',checkedAt:now-1000,resetAt:now+3600000,source:'codex-app-tools/get_usage_limits'};
test('quota recomputes remaining percent and normalizes Unix seconds and milliseconds',()=>{
  const milliseconds=normalizeQuotaSnapshot(fresh,{now}),seconds=normalizeQuotaSnapshot({...fresh,resetAt:fresh.resetAt/1000},{now});
  assert.equal(milliseconds.status,'ok');assert.equal(milliseconds.remainingPercent,73);assert.equal(seconds.resetAt,milliseconds.resetAt);
  assert.equal(normalizeQuotaSnapshot({...fresh,usedPercent:0},{now}).remainingPercent,100);
  assert.equal(normalizeQuotaSnapshot({...fresh,usedPercent:100},{now}).remainingPercent,0);
});
test('expired or reset quota is stale and malformed or unavailable quota is unknown',()=>{
  for(const snapshot of [{...fresh,checkedAt:now-600001},{...fresh,resetAt:now-1}])assert.equal(normalizeQuotaSnapshot(snapshot,{now}).status,'stale');
  for(const snapshot of [null,{...fresh,usedPercent:101},{...fresh,usedPercent:'27'},{...fresh,checkedAt:now+120000},{...fresh,resetAt:null},{...fresh,window:'week'}])assert.equal(normalizeQuotaSnapshot(snapshot,{now}).status,'unknown');
});
test('quota API reader never returns arbitrary private fields from disk',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-quota-'));try{
    assert.equal((await readQuotaSnapshot(dir,{now})).codex.status,'unknown');await mkdir(path.join(dir,'quota'));
    await writeFile(path.join(dir,'quota','codex.json'),JSON.stringify({...fresh,privateKey:'must-not-leak'}));
    const reply=await readQuotaSnapshot(dir,{now});assert.equal(reply.codex.status,'ok');assert(!JSON.stringify(reply).includes('must-not-leak'));
    await writeFile(path.join(dir,'quota','codex.json'),'invalid json');assert.equal((await readQuotaSnapshot(dir,{now})).codex.status,'unknown');
  }finally{await rm(dir,{recursive:true,force:true});}
});
