import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CatalogCache} from '../src/catalog.mjs';
import {makeService} from '../src/server.mjs';
import {CodexAdapter} from '../src/adapters/codex.mjs';
import {DshAdapter} from '../src/adapters/dsh.mjs';

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

test('concurrent catalog and worker startup share one native connection discovery',async()=>{
  for(const [adapter,method,loader] of [[new CodexAdapter(),'appConnection','openAppConnection'],[new DshAdapter(),'discover','discoverBase']]){
    const pending=deferred();let calls=0;adapter[loader]=()=>{calls++;return pending.promise;};
    const first=adapter[method](),second=adapter[method]();assert.equal(calls,1);
    pending.resolve('connection');assert.equal(await first,'connection');assert.equal(await second,'connection');
  }
});

test('a failed shared connection discovery can be retried',async()=>{
  for(const [adapter,method,loader] of [[new CodexAdapter(),'appConnection','openAppConnection'],[new DshAdapter(),'discover','discoverBase']]){
    let calls=0;adapter[loader]=async()=>{if(++calls===1)throw new Error('offline');return 'reconnected';};
    await assert.rejects(adapter[method](),/offline/);assert.equal(await adapter[method](),'reconnected');assert.equal(calls,2);
  }
});

test('cold requests share one discovery and the default response waits for the complete catalog',async()=>{
  let calls=0;const slow=deferred(),cache=new CatalogCache({codex:async()=>{calls++;return slow.promise;},deepseek:async()=>[]});
  const first=cache.get(),second=cache.get();await Promise.resolve();assert.equal(calls,1);
  const partial=await cache.get({partial:true});assert(partial.refreshing);assert.deepEqual(partial.codex,[]);assert.equal(calls,1);
  slow.resolve([{id:'c'}]);assert.deepEqual((await first).codex,[{id:'c'}]);assert.deepEqual((await second).codex,[{id:'c'}]);
  assert.equal((await cache.get()).refreshing,false);assert.equal(calls,1);cache.close();
});

test('expired data returns immediately while a single background refresh replaces it',async()=>{
  let now=100,calls=0;const refresh=deferred();
  const cache=new CatalogCache({codex:async()=>++calls===1?[{id:'old'}]:refresh.promise},{ttl:30,now:()=>now});
  await cache.get();now=150;
  const stale=await cache.get();assert.deepEqual(stale.codex,[{id:'old'}]);assert(stale.sources.codex.stale);assert(stale.refreshing);
  await cache.get();assert.equal(calls,2);
  refresh.resolve([{id:'new'}]);await cache.refresh();assert.deepEqual((await cache.get()).codex,[{id:'new'}]);assert.equal(calls,2);cache.close();
});

test('failed refresh retains previous rows, reports the source and retries after backoff',async()=>{
  let now=100,calls=0;
  const cache=new CatalogCache({codex:async()=>{if(++calls===2)throw new Error('offline');return [{id:'c'+calls}];}},{ttl:30,retryAfter:5,now:()=>now});
  await cache.get();now=150;await cache.refresh();
  const failed=await cache.get();assert.deepEqual(failed.codex,[{id:'c1'}]);assert.match(failed.errors[0],/offline/);assert(failed.sources.codex.stale);assert.equal(calls,2);
  now=156;await cache.refresh();assert.deepEqual((await cache.get()).codex,[{id:'c3'}]);assert.equal(cache.snapshot().errors.length,0);cache.close();
});

test('a slow source does not hide fast source data in partial mode, and explicit refresh is coalesced',async()=>{
  let calls=0;const slow=deferred(),cache=new CatalogCache({codex:async()=>{calls++;return slow.promise;},workspaces:async()=>[{workspaceId:'w'}]});
  const full=cache.get();await cache.load('workspaces');
  const partial=await cache.get({partial:true});assert.deepEqual(partial.workspaces,[{workspaceId:'w'}]);assert(partial.sources.codex.loading);
  await cache.get({partial:true,refresh:true});assert.equal(calls,1);
  slow.resolve([]);await full;cache.close();
});

test('closed cache does not start new discovery or update its snapshot after shutdown',async()=>{
  let calls=0;const slow=deferred(),cache=new CatalogCache({codex:()=>{calls++;return slow.promise;}});
  const pending=cache.get();await Promise.resolve();cache.close();slow.resolve([{id:'late'}]);await pending;await cache.refresh({force:true});
  assert.equal(calls,1);assert.deepEqual(cache.snapshot().codex,[]);
});

test('HTTP catalog partial response returns while the native list is still unresolved, then reuses warmed data',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-catalog-')),slow=deferred();let calls=0;
  const adapters={codex:{list:async()=>{calls++;return slow.promise;},projects:async()=>({projects:[]})},deepseek:{list:async()=>[],workspaces:async()=>[{workspaceId:'w'}]}};
  const service=await makeService({dataDir:dir,adapters});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.server.address().port;
  try{
    const home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0],headers={cookie};
    const partial=await (await fetch(base+'/api/catalog?partial=1',{headers})).json();assert(partial.refreshing);assert.equal(partial.workspaces[0].workspaceId,'w');assert.equal(calls,1);
    assert.equal((await fetch(base+'/api/catalog?partial=1')).status,401);
    slow.resolve([{id:'c',title:'native title',kind:'codex',hostId:'local'}]);await service.catalog.refresh();
    const results=await Promise.all([fetch(base+'/api/catalog',{headers}),fetch(base+'/api/catalog',{headers})]);
    for(const result of results){const j=await result.json();assert.equal(j.codex[0].title,'native title');assert.equal(j.refreshing,false);}
    assert.equal(calls,1);
  }finally{slow.resolve([]);await service.close();await rm(dir,{recursive:true,force:true});}
});
