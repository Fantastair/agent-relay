import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {QuotaCache,normalizeLiveQuota} from '../src/quota.mjs';
import {makeService} from '../src/server.mjs';
const now=1800000000000;
function codex(usedPercent=30){return {accountId:'private-account',ordinaryUsageAllowed:true,rateLimitsByLimitId:{codex:{primary:{usedPercent,windowDurationMins:300,resetsAt:(now+3600000)/1000}}}};}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function settled(cache){await Promise.all(Object.values(cache.entries).map(entry=>entry.pending));}

test('live providers normalize real zero allowance and balance, without exposing unrelated account or wallet fields',()=>{
  const cx=normalizeLiveQuota('codex',codex(100),{now}),ds=normalizeLiveQuota('deepseek',{balance:'0.00',currency:'CNY',secret:'private-key'},{now});
  assert.equal(cx.status,'ok');assert.equal(cx.remainingPercent,0);assert.equal(cx.resetAt,now+3600000);assert.equal(ds.status,'ok');assert.equal(ds.balance,0);
  assert(!JSON.stringify([cx,ds]).includes('private-'));assert.throws(()=>normalizeLiveQuota('deepseek',{balance:'',currency:'CNY'},{now}),/格式/);
  assert.throws(()=>normalizeLiveQuota('codex',{rateLimits:{primary:{windowDurationMins:240}}},{now}),/五小时/);
});

test('quota requests coalesce per provider and reuse the sixty second cache before refreshing in the background',async()=>{
  let time=now,cxCalls=0,dsCalls=0,used=30;const gate=deferred();
  const cache=new QuotaCache({now:()=>time,codex:{async quota(){cxCalls++;await gate.promise;return codex(used);}},deepseek:{async quota(){dsCalls++;return {balance:8,currency:'CNY'};}}});
  try{
    const first=cache.get();await cache.get();await cache.get();gate.resolve();const initial=await first;assert.equal(initial.codex.remainingPercent,70);assert.equal(cxCalls,1);assert.equal(dsCalls,1);
    await cache.get();assert.equal(cxCalls,1);time+=60001;used=50;const previous=await cache.get();assert.equal(previous.codex.remainingPercent,70);await settled(cache);
    assert.equal(cache.snapshot().codex.remainingPercent,50);assert.equal(cxCalls,2);assert.equal(dsCalls,2);
  }finally{cache.close();}
});

test('one failed provider retains its last result as stale while the other remains current',async()=>{
  let time=now,fail=false;const cache=new QuotaCache({now:()=>time,codex:{async quota(){return codex(fail?80:30);}},deepseek:{async quota(){if(fail)throw new Error('service unavailable');return {balance:7.92,currency:'CNY'};}}});
  try{
    await cache.get();time+=60001;fail=true;await cache.get();await settled(cache);const reply=cache.snapshot();
    assert.equal(reply.codex.status,'ok');assert.equal(reply.codex.remainingPercent,20);assert.equal(reply.deepseek.status,'stale');assert.equal(reply.deepseek.balance,7.92);assert.equal(reply.deepseek.checkedAt,now);assert.match(reply.deepseek.note,/查询失败/);
    time+=600001;assert.equal(cache.snapshot().codex.status,'stale');
  }finally{cache.close();}
});

test('an unavailable provider with no previous value is unknown rather than exhausted',async()=>{
  const cache=new QuotaCache({now:()=>now,codex:{async quota(){throw new Error('not supported');}},deepseek:{async quota(){return {balance:'not a number',currency:'CNY'};}}});
  try{const reply=await cache.get();assert.equal(reply.codex.status,'unknown');assert.equal(reply.deepseek.status,'unknown');assert(!('remainingPercent' in reply.codex));assert(!('balance' in reply.deepseek));}finally{cache.close();}
});

test('first response is bounded when one provider stalls and later callers do not launch duplicate queries',async()=>{
  const gate=deferred();let calls=0;const cache=new QuotaCache({initialWait:5,now:()=>now,codex:{async quota(){calls++;return gate.promise;}},deepseek:{async quota(){return {balance:5,currency:'CNY'};}}});
  try{
    const first=await cache.get();assert.equal(first.codex.status,'unknown');assert.equal(first.deepseek.balance,5);assert.equal(first.sources.codex.loading,true);assert(first.refreshing);
    await cache.get();await cache.get();assert.equal(calls,1);gate.resolve(codex());await settled(cache);assert.equal(cache.snapshot().codex.remainingPercent,70);
  }finally{gate.resolve(codex());cache.close();}
});

test('successful Codex reads persist a sanitized snapshot and failed reads explicitly label that fallback stale',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-quota-live-'));let cache;
  try{
    cache=new QuotaCache({dataDir:dir,now:()=>now,codex:{async quota(){return codex();}}});await cache.get();cache.close();
    const file=JSON.parse(await readFile(path.join(dir,'quota','codex.json'),'utf8'));assert.equal(file.remainingPercent,70);assert(!JSON.stringify(file).includes('private-account'));
    cache=new QuotaCache({dataDir:dir,now:()=>now});const fallback=await cache.get();assert.equal(fallback.codex.status,'stale');assert.equal(fallback.codex.remainingPercent,70);assert.equal(fallback.codex.live,false);assert.match(fallback.codex.note,/快照/);
  }finally{cache?.close();await rm(dir,{recursive:true,force:true});}
});

test('closing the quota cache prevents late provider completion from changing its response',async()=>{
  const gate=deferred(),cache=new QuotaCache({initialWait:1,now:()=>now,codex:{quota:()=>gate.promise}});await cache.get();cache.close();gate.resolve(codex());await settled(cache);assert.equal(cache.snapshot().codex.status,'unknown');
});

test('HTTP quota includes both providers and page reloads share the same read instead of querying each time',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-quota-http-'));let calls=0;
  const baseAdapter={async list(){return [];},async workspaces(){return [];},async projects(){return {projects:[]};},close(){}};
  const service=await makeService({dataDir:dir,adapters:{codex:{...baseAdapter,async quota(){calls++;return {rateLimits:{primary:{usedPercent:12,windowDurationMins:300,resetsAt:Date.now()+3600000}}};}},deepseek:{...baseAdapter,async quota(){return {balance:'1.50',currency:'CNY'};}}}});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port;
  try{
    assert.equal((await fetch(base+'/api/quota')).status,401);const cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
    for(let i=0;i<3;i++){const result=await (await fetch(base+'/api/quota',{headers:{cookie}})).json();assert.equal(result.codex.remainingPercent,88);assert.equal(result.deepseek.balance,1.5);assert.equal(result.deepseek.status,'ok');}
    assert.equal(calls,1);
  }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});
