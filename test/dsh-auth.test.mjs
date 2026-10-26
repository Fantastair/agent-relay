import test from 'node:test';
import assert from 'node:assert/strict';
import {DshAdapter} from '../src/adapters/dsh.mjs';
import {RelayError} from '../src/util.mjs';
import http from 'node:http';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {cookieFor} from '../src/adapters/dsh.mjs';

test('DSH credentials remain valid when the host clock is one second behind',async t=>{
  const now=1700000000000,secret=randomBytes(32);t.mock.method(Date,'now',()=>now);
  const server=http.createServer((req,res)=>{
    const authority=req.headers.host,name='dsh-auth-'+createHash('sha256').update(authority).digest('base64url');
    const parts=(req.headers.cookie||'').slice(name.length+1).split('.');let valid=false;
    try{
      const payload=JSON.parse(Buffer.from(parts[1],'base64url')),hostNow=now-1000;
      valid=parts[0]==='v1'&&createHmac('sha256',secret).update(parts[1]).digest('base64url')===parts[2]&&payload.authority===authority&&payload.issuedAt<=hostNow&&payload.expiresAt>hostNow&&payload.expiresAt-payload.issuedAt===3600000;
    }catch{}
    req.resume();res.writeHead(valid?200:401,{'content-type':'application/json'});res.end(JSON.stringify(valid?{result:{ok:true,value:{items:[]}}}:{error:'invalid credential'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  try{
    const control=await fetch(base+'/api/session/list',{method:'POST',headers:{cookie:cookieFor(new URL(base).host,secret)}});assert.equal(control.status,401);await control.arrayBuffer();
    const adapter=new DshAdapter();adapter.secret=async()=>secret;
    for(let index=0;index<3;index++)assert.deepEqual(await adapter.raw(base,'session/list',{_request:{}}),{items:[]});
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('DSH retries an explicitly rejected prompt once after refreshing the host',async()=>{
  const adapter=new DshAdapter(),calls=[],discoveries=[];adapter.base='http://127.0.0.1:1';
  adapter.discover=async force=>{discoveries.push({force:!!force,base:adapter.base});return force?'http://127.0.0.1:2':'http://127.0.0.1:1';};
  adapter.raw=async(base,method,args,rpcId)=>{calls.push({base,method,args,rpcId});if(calls.length===1)throw new RelayError('HTTP 401','auth');return {accepted:true};};
  const args={request:{requestId:'unique-request',sessionId:'dedicated'}};
  assert.deepEqual(await adapter.api('session/prompt',args,'unique-request'),{accepted:true});
  assert.equal(calls.length,2);assert.deepEqual(calls.map(call=>call.rpcId),['unique-request','unique-request']);
  assert.equal(calls[1].base,'http://127.0.0.1:2');assert.strictEqual(calls[1].args,args);
  assert.deepEqual(discoveries,[{force:false,base:'http://127.0.0.1:1'},{force:true,base:null}]);
});

test('DSH authentication refresh has a one-retry bound',async()=>{
  const adapter=new DshAdapter();let attempts=0;
  adapter.discover=async()=> 'http://127.0.0.1:1';adapter.raw=async()=>{attempts++;throw new RelayError('HTTP 403','auth');};
  await assert.rejects(adapter.api('session/prompt',{},'request'),error=>error.code==='auth');assert.equal(attempts,2);
});

test('DSH does not resend a prompt whose transport outcome is uncertain',async()=>{
  const adapter=new DshAdapter();let attempts=0,discoveries=0;
  adapter.discover=async()=>{discoveries++;return 'http://127.0.0.1:1';};adapter.raw=async()=>{attempts++;throw new RelayError('timeout','offline',true);};
  await assert.rejects(adapter.api('session/prompt',{},'request'),error=>error.uncertain===true);assert.equal(attempts,1);assert.equal(discoveries,1);
});
