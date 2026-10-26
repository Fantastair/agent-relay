import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {ParallelRelay} from '../src/parallel-relay.mjs';
const adapters=Object.fromEntries(['codex','deepseek'].map(side=>[side,{async snapshot(id){return {id,state:'idle',turns:[]};}}]));

test('migration recovers session declarations from global and misplaced room caches without copying them to different sessions',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-image-registry-')),file=path.join(dir,'relay.sqlite');let store=new Store(file);
  try{
    const a=store.activeRoomId();store.bindRoom(a,{codexId:'c',deepseekId:'d'});store.patchRoomOptions(a,{imageCapabilities:{}});
    const b=store.createRoom({title:'misplaced cache',codexId:'other-c',deepseekId:'other-d'});
    store.patchRoomOptions(b.id,{imageCapabilities:{codex:{sessionId:'c',supportsImages:false,checkedAt:200}}});
    store.set('imageCapabilities',{codex:{sessionId:'c',supportsImages:true,checkedAt:100},deepseek:{sessionId:'d',supportsImages:true,checkedAt:100}});
    store.db.prepare('DELETE FROM settings WHERE key=?').run('imageCapabilityRegistryMigrated');
    const original=store.db.prepare('SELECT * FROM room_options ORDER BY room_id').all();store.close();store=new Store(file);
    const relay=new ParallelRelay(store,adapters);
    assert.equal(relay.imageCapability('codex',a).supportsImages,false);assert.equal(relay.imageCapability('deepseek',a).supportsImages,true);
    assert.equal(relay.imageCapability('codex',b.id).supportsImages,'unknown');assert.equal(relay.imageCapability('deepseek',b.id).supportsImages,'unknown');
    assert.deepEqual(store.db.prepare('SELECT * FROM room_options ORDER BY room_id').all(),original);
    relay.confirmImageCapability({roomId:a,side:'deepseek',sessionId:'d',supportsImages:false});
    store.close();store=new Store(file);assert.equal(new ParallelRelay(store,adapters).imageCapability('deepseek',a).supportsImages,false);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('verified declarations follow the same native sessions between topics but never follow new bindings',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-image-binding-')),file=path.join(dir,'relay.sqlite');let store=new Store(file);
  try{
    const relay=new ParallelRelay(store,adapters),a=store.activeRoomId();await relay.bindPair({roomId:a,codexId:'c',deepseekId:'d'});
    for(const side of ['codex','deepseek'])relay.confirmImageCapability({roomId:a,side,sessionId:side==='codex'?'c':'d',supportsImages:true});
    await relay.bindPair({roomId:a,codexId:'c',deepseekId:'d'});assert.equal(relay.imageCapability('codex',a).supportsImages,true);
    await relay.bindPair({roomId:a,codexId:'new-c',deepseekId:'new-d'});assert.equal(relay.imageCapability('codex',a).supportsImages,'unknown');
    const b=await relay.createRoom({roomId:a,title:'new owner'});await relay.bindPair({roomId:b.id,codexId:'c',deepseekId:'d'});
    assert.equal(relay.imageCapability('codex',b.id).supportsImages,true);assert.equal(relay.imageCapability('deepseek',b.id).supportsImages,true);
    store.close();store=new Store(file);const reopened=new ParallelRelay(store,adapters);
    assert.equal(reopened.imageCapability('codex',a).supportsImages,'unknown');assert.equal(reopened.imageCapability('codex',b.id).supportsImages,true);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('provider identity and matching bound session are both required to declare support',()=>{
  const store=new Store(':memory:');try{
    const relay=new ParallelRelay(store,adapters),roomId=store.activeRoomId();store.bindRoom(roomId,{codexId:'same-id',deepseekId:'same-id'});
    relay.confirmImageCapability({roomId,side:'codex',sessionId:'same-id',supportsImages:true});
    assert.equal(relay.imageCapability('deepseek',roomId).supportsImages,'unknown');
    relay.confirmImageCapability({roomId,side:'deepseek',sessionId:'same-id',supportsImages:false});assert.equal(relay.imageCapability('codex',roomId).supportsImages,true);
    assert.throws(()=>relay.confirmImageCapability({roomId,side:'codex',sessionId:'unbound',supportsImages:true}),/当前绑定/);
    assert.equal(store.imageCapability('codex','unbound'),null);
  }finally{store.close();}
});
