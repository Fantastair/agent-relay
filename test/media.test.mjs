import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {ImageStore,imageDimensions,MAX_IMAGE_BYTES} from '../src/images.mjs';
import {Relay} from '../src/relay.mjs';
import {makeService} from '../src/server.mjs';
import {envelope,signals,RelayError} from '../src/util.mjs';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kR1sAAAAASUVORK5CYII=';
const dataUrl='data:image/png;base64,'+png;
function mocks(){return Object.fromEntries(['codex','deepseek'].map(side=>[side,{
  turns:[],sent:[],async list(){return [];},async projects(){return {projects:[]};},async workspaces(){return [];},
  async snapshot(){return {state:'idle',title:side,turns:this.turns};},
  async send(sessionId,text,requestId){this.sent.push({sessionId,text,requestId});return {nativeTurnId:side+this.sent.length,requestId};}
}]));}
async function harness(){const dir=await mkdtemp(path.join(tmpdir(),'relay-media-')),store=new Store(path.join(dir,'relay.sqlite'));store.set('codexId','c');store.set('deepseekId','d');store.set('paused',false);const adapters=mocks(),images=new ImageStore(store,dir),relay=new Relay(store,adapters,{images});return {dir,store,adapters,images,relay,async close(){store.close();await rm(dir,{recursive:true,force:true});}};}
function capable(h){for(const side of ['codex','deepseek'])h.relay.confirmImageCapability({side,sessionId:side==='codex'?'c':'d',supportsImages:true});}
function turn(text,output,id='codex1'){return {id,status:'completed',inputs:[{id:id+'-in',text,kind:'user'}],outputs:[{id:id+'-out',text:output}]};}

test('image upload preserves bytes and dimensions, survives reopen, and never accepts a caller file path',async()=>{
  const h=await harness();try{
    const image=await h.images.upload({dataUrl,path:'C:/must-not-be-used.txt'});assert.equal(image.w,1);assert.equal(image.h,1);assert.equal(image.mime,'image/png');assert.equal(image.bytes,Buffer.from(png,'base64').length);
    assert.equal(path.dirname(image.path),path.join(h.dir,'images'));assert.equal(image.url,'/api/image/'+image.id);assert((await h.images.read(image.id)).bytes.equals(Buffer.from(png,'base64')));
    const db=new Store(path.join(h.dir,'relay.sqlite'));try{const reopened=new ImageStore(db,h.dir);assert.equal(reopened.describe(image.id).path,image.path);}finally{db.close();}
    assert.throws(()=>h.images.describe('../../control.key'),/ID 无效/);assert.throws(()=>h.images.describe('00000000-0000-0000-0000-000000000000'),/不存在/);
  }finally{await h.close();}
});

test('upload rejects MIME spoofing, SVG, invalid base64, truncated images, excessive dimensions and excessive bytes',async()=>{
  const h=await harness();try{
    for(const value of ['data:image/jpeg;base64,'+png,'data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,not-valid!','data:image/png;base64,aA=='])await assert.rejects(h.images.upload({dataUrl:value}),/图片/);
    const oversized=Buffer.from(png,'base64');oversized.writeUInt32BE(16001,16);await assert.rejects(h.images.upload({dataUrl:'data:image/png;base64,'+oversized.toString('base64')}),/尺寸/);
    await assert.rejects(h.images.upload({dataUrl:'data:image/png;base64,'+Buffer.alloc(MAX_IMAGE_BYTES+1).toString('base64')}),/1 MiB/);
  }finally{await h.close();}
});

test('PNG, JPEG and WebP metadata is read from image headers, not client dimensions',async()=>{
  assert.deepEqual(imageDimensions(Buffer.from(png,'base64'),'image/png'),{w:1,h:1});
  const jpg=Buffer.from([255,216,255,192,0,11,8,0,20,0,30,1,1,17,0,255,217]);assert.deepEqual(imageDimensions(jpg,'image/jpeg'),{w:30,h:20});
  const webp=Buffer.alloc(30);webp.write('RIFF');webp.writeUInt32LE(22,4);webp.write('WEBP',8);webp.write('VP8X',12);webp.writeUInt32LE(10,16);webp.writeUIntLE(39,24,3);webp.writeUIntLE(49,27,3);assert.deepEqual(imageDimensions(webp,'image/webp'),{w:40,h:50});
});

test('capability defaults unknown, is bound to the actual session, and unknown never admits an image message',async()=>{
  const h=await harness();try{
    const image=await h.images.upload({dataUrl});assert.equal(h.relay.state().health.codex.supportsImages,'unknown');
    assert.throws(()=>h.relay.sendMessage({imageIds:[image.id]}),/尚未确认/);assert.equal(h.store.state().messages.length,0);
    capable(h);assert.equal(h.relay.state().health.codex.supportsImages,true);assert.equal(h.relay.state().health.codex.imageMode,'file-tools');
    h.store.set('codexId','different');assert.equal(h.relay.state().health.codex.supportsImages,'unknown');assert.throws(()=>h.relay.confirmImageCapability({side:'codex',sessionId:'c',supportsImages:true}),/当前绑定/);
  }finally{await h.close();}
});

test('image-only messages, exports and batched delivery retain ordered file references and explicit reading instructions',async()=>{
  const h=await harness();try{
    capable(h);const first=await h.images.upload({dataUrl}),second=await h.images.upload({dataUrl});
    const imageOnly=h.relay.sendMessage({imageIds:[first.id,second.id],targets:['codex']});assert.equal(imageOnly.text,'');assert.equal(imageOnly.meta.image.id,first.id);assert.deepEqual(imageOnly.meta.images.map(image=>image.id),[first.id,second.id]);
    for(let i=0;i<3;i++)h.relay.sendUser('another '+i,['codex']);await h.relay.tick('codex');
    assert.equal(h.adapters.codex.sent.length,1);assert.match(h.adapters.codex.sent[0].text,/relay-batch/);assert(h.adapters.codex.sent[0].text.includes('[图片 #'+first.id+'] '+first.path));assert(h.adapters.codex.sent[0].text.includes(second.path));assert.match(h.adapters.codex.sent[0].text,/实际查看/);
    assert.equal(h.store.exportHistory().messages[0].meta.images[0].sha256,first.sha256);
  }finally{await h.close();}
});

test('image request identity includes the ordered image IDs; invalid or too many images create no partial message',async()=>{
  const h=await harness();try{
    capable(h);const a=await h.images.upload({dataUrl}),b=await h.images.upload({dataUrl}),body={imageIds:[a.id],clientMessageId:'image-once'};
    const first=h.relay.sendMessage(body);assert.equal(h.relay.sendMessage(body).id,first.id);assert.throws(()=>h.relay.sendMessage({...body,imageIds:[b.id]}),/不同内容/);
    assert.throws(()=>h.relay.sendMessage({imageIds:Array(5).fill(a.id)}),/最多4张/);assert.throws(()=>h.relay.sendMessage({imageIds:['bad-id']}),/ID 无效/);assert.equal(h.store.state().messages.length,1);
  }finally{await h.close();}
});

test('modified attachment blocks delivery before sending and pauses the queue instead of silently omitting the picture',async()=>{
  const h=await harness();try{
    capable(h);const image=await h.images.upload({dataUrl}),message=h.relay.sendMessage({imageIds:[image.id],targets:['codex']});
    const original=await readFile(image.path);original[25]^=1;await writeFile(image.path,original);await h.relay.tick('codex');
    assert.equal(h.adapters.codex.sent.length,0);assert.equal(h.store.forMessage(message.id,'codex').status,'blocked');assert.equal(h.store.get('paused'),true);await assert.rejects(h.images.read(image.id),/已变化/);
  }finally{await h.close();}
});

test('a cancellation while attachment verification is pending prevents the send',async()=>{
  const h=await harness();try{
    capable(h);const image=await h.images.upload({dataUrl}),message=h.relay.sendMessage({imageIds:[image.id],targets:['codex']});
    const original=h.images.read.bind(h.images);let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
    h.images.read=async imageId=>{enter();await gate;return original(imageId);};
    const pending=h.relay.tick('codex');await entered;h.relay.cancel(h.store.forMessage(message.id,'codex').id);release();await pending;
    assert.equal(h.adapters.codex.sent.length,0);assert.equal(h.store.forMessage(message.id,'codex').status,'cancelled');
  }finally{await h.close();}
});

test('pure silent and legacy stop markers are persisted but never become visible chat, inbox entries or forwarded work',async()=>{
  for(const marker of ['[relay-silent]','[relay-no-reply]','[relay-stop]','[relay-silent]\n[relay-stop]','  [relay-silent]  ']){
    const h=await harness();try{
      const message=h.relay.sendUser('no need to answer',['codex']);await h.relay.tick('codex');h.adapters.codex.turns=[turn(envelope(message),marker)];await h.relay.tick('codex');await h.relay.tick('codex');
      assert.equal(h.store.forMessage(message.id,'codex').status,'completed');assert.equal(h.store.state().messages.length,1);assert.equal(h.store.state().room.messageCount,1);assert.equal(h.store.jobs('deepseek').length,0);
      const exported=h.store.exportHistory().messages,quiet=exported.find(m=>m.meta.silent);assert.equal(exported.length,2);assert(quiet);assert.equal(quiet.text,'');assert.equal(quiet.meta.control,'no-reply');assert.equal(h.store.inbox({side:'deepseek'}).messages.length,1);assert.throws(()=>h.relay.forward(quiet.id,'deepseek'),/静默/);
    }finally{await h.close();}
  }
});

test('silent markers with meaningful text preserve the text; markers inside quotes/code are not interpreted',async()=>{
  const h=await harness();try{
    const message=h.relay.sendUser('status',['codex']);await h.relay.tick('codex');h.adapters.codex.turns=[turn(envelope(message),'Completed the fix.\n[relay-silent]')];await h.relay.tick('codex');
    const reply=h.store.state().messages.at(-1);assert.equal(reply.text,'Completed the fix.');assert(!reply.meta.silent);assert.equal(h.store.jobs('deepseek').length,0);
    assert.equal(signals('inline [relay-silent]').stop,false);assert.equal(signals('```\n[relay-silent]\n```').stop,false);
    assert.equal(signals('The marker is useful.\n[relay-silent]').silent,undefined);
  }finally{await h.close();}
});

test('batched silent reply completes all members once and preserves the batch audit linkage',async()=>{
  const h=await harness();try{
    for(let i=0;i<4;i++)h.relay.sendUser('item '+i,['codex']);await h.relay.tick('codex');const sent=h.adapters.codex.sent[0];h.adapters.codex.turns=[turn(sent.text,'[relay-silent]')];await h.relay.tick('codex');
    assert.equal(h.store.batch(sent.requestId).status,'completed');assert(h.store.batchDeliveries(sent.requestId).every(d=>d.status==='completed'));assert.equal(h.store.state().messages.length,4);
    const quiet=h.store.exportHistory().messages.find(m=>m.meta.silent);assert.equal(quiet.meta.batchId,sent.requestId);assert.equal(quiet.meta.inReplyToMessageIds.length,4);assert.equal(h.store.jobs('deepseek').length,0);
  }finally{await h.close();}
});

test('HTTP image endpoints require authentication, cookie CSRF checks and a separate Bearer-only capability declaration',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-media-http-')),service=await makeService({dataDir:dir,adapters:mocks()});await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port;
  try{
    service.store.set('codexId','c');service.store.set('deepseekId','d');const home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];assert.match(home.headers.get('content-security-policy'),/blob:/);
    const headers={cookie,origin:base,'x-relay-ui':'1','content-type':'application/json'},post=(route,body,h=headers)=>fetch(base+'/api/'+route,{method:'POST',headers:h,body:JSON.stringify(body)});
    assert.equal((await post('image',{dataUrl},{'content-type':'application/json'})).status,401);assert.equal((await post('image',{dataUrl},{cookie,'content-type':'application/json'})).status,403);
    const uploaded=await post('image',{dataUrl});assert.equal(uploaded.status,200);const {image}=await uploaded.json();
    assert.equal((await fetch(base+image.url)).status,401);const binary=await fetch(base+image.url,{headers:{cookie}});assert.equal(binary.headers.get('content-type'),'image/png');assert.equal(binary.headers.get('x-content-type-options'),'nosniff');assert(Buffer.from(await binary.arrayBuffer()).equals(Buffer.from(png,'base64')));
    assert.equal((await post('capabilities/image',{side:'codex',sessionId:'c',supportsImages:true})).status,403);
    const toolHeaders={authorization:'Bearer '+service.key,'content-type':'application/json'};assert.equal((await post('capabilities/image',{side:'codex',sessionId:'c',supportsImages:true},toolHeaders)).status,200);
    assert.equal((await post('message',{imageIds:[image.id],targets:['codex']})).status,200);
    assert.equal((await fetch(base+'/api/image/..%2Fcontrol.key',{headers:{cookie}})).status,400);
  }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});
