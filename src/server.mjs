import http from 'node:http';
import {mkdir,readFile,writeFile,open,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Store} from './store.mjs';
import {ParallelRelay as Relay} from './parallel-relay.mjs';
import {CodexAdapter} from './adapters/codex.mjs';
import {DshAdapter} from './adapters/dsh.mjs';
import {provisionNewPair} from './provision.mjs';
import {CatalogCache,catalogLoaders} from './catalog.mjs';
import {QuotaCache} from './quota.mjs';
import {ImageStore} from './images.mjs';
import {safeError,RelayError} from './util.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function makeService({dataDir=path.join(root,'data'),config={},adapters,quotaOptions}={}){
  await mkdir(dataDir,{recursive:true});let key;try{key=(await readFile(path.join(dataDir,'control.key'),'utf8')).trim();}catch{key=randomBytes(32).toString('hex');await writeFile(path.join(dataDir,'control.key'),key,{mode:0o600});}
  const store=new Store(path.join(dataDir,'relay.sqlite'));store.set('pausedAll',true);
  const c=adapters?.codex||new CodexAdapter(config.codex),d=adapters?.deepseek||new DshAdapter(config.deepseek),images=new ImageStore(store,dataDir);const relay=new Relay(store,{codex:c,deepseek:d},{images});
  const catalog=new CatalogCache(catalogLoaders(c,d));
  const quota=new QuotaCache({dataDir,codex:c,deepseek:d,...quotaOptions});
  const server=http.createServer(async(req,res)=>{const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};try{
    const port=server.address()?.port,host=req.headers.host||'',sessionCookie=`relay_session_${port}`;if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)||!req.url?.startsWith('/'))return send(403,{error:'只接受本机访问'});
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url=new URL(req.url,`http://${host}`),pathname=url.pathname;
    if(req.method==='GET'&&['/','/app.js','/style.css'].includes(pathname)){if(pathname==='/')res.setHeader('Set-Cookie',`${sessionCookie}=${key}; HttpOnly; SameSite=Strict; Path=/`);const name=pathname==='/'?'index.html':pathname.slice(1);const body=await readFile(path.join(root,'public',name));res.writeHead(200,{'content-type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','cache-control':'no-cache'});return res.end(body);}
    if(pathname==='/api/health'&&req.method==='GET')return send(200,{ok:true,version:'0.1.0',features:['rooms','room-delete-v1','topic-parallel-v1','topic-binding-v2','message-attribution-v1','inbox-cursor-v1','quota-snapshot-v1','quota-live-v1','protocol-ready-v1','batch-delivery-v1','image-attachments-v1','image-capabilities-v1','image-capability-registry-v1','image-file-tools-v2','silent-reply-v1','steer-delivery-v1','dsh-receipt-v2']});
    const bearer=(req.headers.authorization||'').replace(/^Bearer /,''),cookie=(req.headers.cookie||'').match(new RegExp(`(?:^|;\\s*)${sessionCookie}=([a-f0-9]+)`))?.[1];const equal=v=>typeof v==='string'&&v.length===key.length&&timingSafeEqual(Buffer.from(v),Buffer.from(key));const hasBearer=equal(bearer);if(!hasBearer&&!equal(cookie))return send(401,{error:'请从本机中转台首页访问'});
    if(req.method!=='GET'&&!hasBearer&&(req.headers.origin!==`http://${host}`||req.headers['x-relay-ui']!=='1'))return send(403,{error:'请求来源不匹配'});
    if(req.method==='GET'&&pathname.startsWith('/api/image/')){const {image,bytes}=await images.read(pathname.slice('/api/image/'.length));res.writeHead(200,{'content-type':image.mime,'content-length':bytes.length,'cache-control':'private, max-age=31536000, immutable'});return res.end(bytes);}
    // 本机头像：只读 data/avatars/<side>.png，不入库、不对外；文件缺失时前端回退到占位字母
    if(req.method==='GET'&&pathname.startsWith('/local-avatar/')){const side=pathname.slice('/local-avatar/'.length);if(!['user','codex','deepseek'].includes(side))return send(404,{error:'未知头像'});try{const bytes=await readFile(path.join(dataDir,'avatars',side+'.png'));res.writeHead(200,{'content-type':'image/png','content-length':bytes.length,'cache-control':'no-cache'});return res.end(bytes);}catch{return send(404,{error:'未配置本机头像'});}}
    if(pathname==='/api/state'&&req.method==='GET')return send(200,relay.state(url.searchParams.get('roomId')||undefined));
    if(pathname==='/api/inbox'&&req.method==='GET')return send(200,store.inbox({side:url.searchParams.get('as')||url.searchParams.get('side'),all:url.searchParams.get('all')==='1',roomId:url.searchParams.get('roomId')||undefined,after:url.searchParams.get('after')||url.searchParams.get('cursor')||url.searchParams.get('since')||'0',limit:Number(url.searchParams.get('limit')||100)}));
    if(pathname==='/api/quota'&&req.method==='GET')return send(200,await quota.get());
    if(pathname==='/api/export'&&req.method==='GET'){res.setHeader('Content-Disposition','attachment; filename="agent-relay-history.json"');return send(200,store.exportHistory(url.searchParams.get('roomId')||undefined));}
    if(pathname==='/api/catalog'&&req.method==='GET')return send(200,await catalog.get({partial:url.searchParams.get('partial')==='1',refresh:url.searchParams.get('refresh')==='1'}));
    if(req.method!=='POST')return send(404,{error:'接口不存在'});let size=0,parts=[];for await(const part of req){size+=part.length;if(size>(pathname==='/api/image'?2*1024*1024:256000))throw new RelayError('请求过大','input');parts.push(part);}let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');}catch{throw new RelayError('请求格式不正确','input');}
    if(!body||typeof body!=='object'||Array.isArray(body))throw new RelayError('请求必须是 JSON 对象','input');
    if(['/api/options','/api/message','/api/bind','/api/bind-pair','/api/provision','/api/capabilities/image','/api/protocol/ready','/api/rooms','/api/rooms/create'].includes(pathname)&&typeof body.roomId!=='string')throw new RelayError('操作必须明确指定话题 roomId','input');
    if(pathname==='/api/image')return send(200,{image:await images.upload(body)});
    if(pathname==='/api/capabilities/image'){if(!hasBearer)return send(403,{error:'仅本机 Agent 可声明经过核验的图像能力'});return send(200,relay.confirmImageCapability(body));}
    if(pathname==='/api/message'){
      if(hasBearer){if(!['codex','deepseek'].includes(body.sender)||!['agent','test'].includes(body.origin))return send(403,{error:'工具消息必须明确 sender=codex|deepseek 和 origin=agent|test，禁止写成用户消息'});}
      else if((body.sender!==undefined&&body.sender!=='user')||(body.origin!==undefined&&body.origin!=='console'))return send(403,{error:'网页消息只能使用用户身份和 console 来源'});
      return send(200,{message:relay.sendMessage({...body,sender:hasBearer?body.sender:'user',origin:hasBearer?body.origin:'console'})});
    }
    if(pathname==='/api/protocol/ready'){if(!hasBearer)return send(403,{error:'仅本机 Agent 可以确认技能加载状态'});return send(200,relay.confirmProtocol(body));}
    if(pathname==='/api/rooms'||pathname==='/api/rooms/create')return send(200,{room:await relay.createRoom(body)});
    if(pathname==='/api/rooms/select'){const room=relay.selectRoom(body.roomId);return send(200,{ok:true,room,warning:room.id!==store.activeRoomId()?'正在浏览历史话题。继续发送前，请点击「继续此话题」恢复它的会话绑定。':undefined});}
    if(pathname==='/api/rooms/activate')return send(200,{ok:true,room:await relay.activateRoom(body.roomId)});
    if(pathname==='/api/rooms/update')return send(200,{ok:true,room:relay.updateRoom(body)});
    if(pathname==='/api/rooms/delete')return send(200,relay.deleteRoom(body));
    if(pathname==='/api/options'){relay.setOptions(body);return send(200,{ok:true});}
    if(pathname==='/api/scheduler')return send(200,{ok:true,concurrency:relay.setScheduler(body)});
    if(pathname==='/api/resolve'){relay.resolve(body.deliveryId,body.decision,body.confirmed);return send(200,{ok:true});}
    if(pathname==='/api/bind')return send(200,await relay.bind(body.side,body.sessionId,body.roomId));
    if(pathname==='/api/bind-pair')return send(200,await relay.bindPair(body));
    if(pathname==='/api/forward')return send(200,relay.forward(body.messageId,body.side));
    if(pathname==='/api/retry'){relay.retry(body.deliveryId);return send(200,{ok:true});}
    if(pathname==='/api/cancel'){relay.cancel(body.deliveryId);return send(200,{ok:true});}
    if(pathname==='/api/shutdown'){send(200,{ok:true});setImmediate(()=>void service.close());return;}
    if(pathname==='/api/provision'){
      const room=relay.requireRoom(body.roomId);if(room.archived)throw new RelayError('请先恢复归档话题','input');let reserved=false;
      try{await relay.reserveSides(['codex','deepseek'],room.id);reserved=true;relay.assertQueueSettled(room.id);const pair=await provisionNewPair({store:relay.context(room.id),roomId:room.id,codex:c,deepseek:d,workspaceId:body.workspaceId||room.workspaceId,title:body.title,defaultWorkspacePath:path.resolve(root,'..')});relay.changedRoom();void catalog.refresh({force:true});return send(200,pair);
      }finally{if(reserved)relay.releaseSides(['codex','deepseek'],room.id);relay.notify();}}
    return send(404,{error:'接口不存在'});
  }catch(e){const code=['input','config','binding'].includes(e.code)?400:e.code==='not_found'?404:['busy','binding_conflict'].includes(e.code)?409:503;send(code,{error:safeError(e),code:e.code||'error',...(e.code==='binding_conflict'?{conflict:e.conflict}:{})});}});
  server.once('listening',()=>{void catalog.refresh();});
  let closing;const service={server,relay,store,catalog,quota,images,key,dataDir,close:()=>closing||=(async()=>{catalog.close();quota.close();await relay.stop();await new Promise(resolve=>server.close(resolve));store.close();})()};return service;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const dataDir=process.env.RELAY_DATA_DIR||path.join(root,'data');let config={};try{config=JSON.parse(await readFile(path.join(root,'config.local.json'),'utf8'));}catch{}
  await mkdir(dataDir,{recursive:true});const lockPath=path.join(dataDir,'service.lock');let lock;
  try{lock=await open(lockPath,'wx');}catch(e){if(e.code!=='EEXIST')throw e;let old;try{old=Number(await readFile(lockPath,'utf8'));}catch{}let alive=false;if(old>0)try{process.kill(old,0);alive=true;}catch{}if(alive)throw new Error('中转服务已运行，请使用启动脚本打开已有服务');await unlink(lockPath);lock=await open(lockPath,'wx');}
  await lock.writeFile(String(process.pid));await lock.close();
  const service=await makeService({dataDir,config}),close=service.close;service.close=async()=>{await close();try{await unlink(lockPath);}catch{}};
  const port=Number(process.env.RELAY_PORT||4319);service.server.listen(port,'127.0.0.1',async()=>{const url=`http://127.0.0.1:${service.server.address().port}`;await writeFile(path.join(dataDir,'instance.json'),JSON.stringify({pid:process.pid,url,startedAt:new Date().toISOString()},null,2));console.log(`本地中转台已启动：${url}`);service.relay.start();});service.server.on('error',e=>{console.error(safeError(e));void service.close();process.exitCode=1;});for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void service.close().then(()=>process.exit(0));});
}
