import {id,envelope,parseEnvelope,batchEnvelope,parseBatchEnvelope,signals,safeError,RelayError,sleep} from './util.mjs';
export const SIDES=['codex','deepseek'];
const terminal=s=>['completed','failed','interrupted','blocked'].includes(s);
export const isControl=t=>t.inputs.some(i=>i.text.startsWith('[relay-control id='));
export class Relay{
  constructor(store,adapters,{images}={}){this.store=store;this.adapters=adapters;this.images=images;this.health={};this.busy={};this.epoch={codex:0,deepseek:0};this.closed=false;this.connLogAt={};}
  notify() {this.onChange?.();}
  start(){this.timer=setInterval(()=>{for(const side of SIDES)void this.tick(side);},1800);for(const side of SIDES)void this.tick(side);}
  async stop(){this.closed=true;clearInterval(this.timer);this.adapters.codex.close?.();while(Object.values(this.busy).some(Boolean))await new Promise(r=>setTimeout(r,20));}
  sessionId(side){return this.store.get(side==='codex'?'codexId':'deepseekId',null);}
  async reserveSides(sides){const start=Date.now();while(sides.some(s=>this.busy[s])){if(Date.now()-start>5000)throw new RelayError('原生会话仍在同步，请稍后重试','busy');await sleep(50);}if(this.closed)throw new RelayError('服务正在关闭','busy');for(const s of sides)this.busy[s]=true;if(sides.length===2)this.changingRoom=true;}
  releaseSides(sides){for(const s of sides)this.busy[s]=false;if(sides.length===2)this.changingRoom=false;}
  assertActiveRoom(roomId=this.store.activeRoomId()){if(this.changingRoom)throw new RelayError('正在切换话题，请稍后再发送','busy');if(roomId!==this.store.activeRoomId())throw new RelayError('当前显示的是历史话题，请先继续该话题再操作','input');}
  roomTitle(title,fallback='新话题'){if(title===undefined)return fallback;if(typeof title!=='string'||!title.trim()||title.trim().length>80)throw new RelayError('话题名称需要 1 到 80 个字符','input');return title.trim();}
  assertQueueSettled(){if(SIDES.some(side=>this.store.jobs(side,['queued','sending','running','unknown','blocked','failed']).length))throw new RelayError('请先完成、取消或处理未完成投递，再切换话题或绑定','busy');}
  async checkRoomBindings(room){const snapshots={};for(const side of SIDES){const sessionId=room[side==='codex'?'codexId':'deepseekId'];if(!sessionId)continue;const s=await this.adapters[side].snapshot(sessionId);if(s.state==='running')throw new RelayError('原生会话正在工作，请空闲后再切换话题','busy');snapshots[side]=s;}return snapshots;}
  async checkOutgoing(room){const current=this.store.requireRoom(this.store.activeRoomId());for(const side of SIDES){const key=side==='codex'?'codexId':'deepseekId',sessionId=current[key];if(!sessionId||sessionId===room[key])continue;try{const s=await this.adapters[side].snapshot(sessionId);if(s.state==='running')throw new RelayError('当前原生会话仍在工作，请完成后再切换','busy');this.ingest(side,sessionId,s,current.id);}catch(e){if(e.code!=='missing_session')throw e;}}}
  baseline(room,snapshots){for(const side of SIDES){const sessionId=room[side==='codex'?'codexId':'deepseekId'];for(const turn of snapshots[side]?.turns||[])if(terminal(turn.status))this.store.markSeen(side,sessionId,'turn:'+turn.id);}}
  changedRoom(snapshots={}){this.health={};for(const side of SIDES){this.epoch[side]++;const s=snapshots[side];if(s)this.health[side]={ok:true,state:s.state,title:s.title,cwd:s.cwd,checkedAt:Date.now()};}this.notify();}
  async createRoom({title,reuseBindings=true}={}){title=this.roomTitle(title);if(typeof reuseBindings!=='boolean')throw new RelayError('话题绑定选项不正确','input');await this.reserveSides(SIDES);try{this.assertQueueSettled();const previous=this.store.requireRoom(this.store.activeRoomId());if(reuseBindings&&!previous.codexId&&!previous.deepseekId)throw new RelayError('请先连接原生会话，再新建话题','binding');const snapshots=await this.checkRoomBindings(previous);for(const side of SIDES)if(snapshots[side])this.ingest(side,previous[side==='codex'?'codexId':'deepseekId'],snapshots[side],previous.id);const room=this.store.transaction(()=>{const created=this.store.createRoom({title,kind:'topic',parentId:previous.id,...(reuseBindings?{codexId:previous.codexId,deepseekId:previous.deepseekId,workspaceId:previous.workspaceId}:{})});this.store.activateRoom(created.id);this.baseline(previous,snapshots);this.store.log('room',reuseBindings?'已新建话题；原生会话上下文继续保留，投递已暂停。':'已新建空白话题，请连接原生会话。');return this.store.room(created.id);});this.changedRoom(reuseBindings?snapshots:{});return room;}finally{this.releaseSides(SIDES);}}
  selectRoom(roomId){const room=this.store.requireRoom(roomId);this.store.set('selectedRoomId',roomId);this.notify();return room;}
  async activateRoom(roomId){const room=this.store.requireRoom(roomId);if(roomId===this.store.activeRoomId()){this.selectRoom(roomId);return room;}await this.reserveSides(SIDES);try{this.assertQueueSettled();await this.checkOutgoing(room);const snapshots=await this.checkRoomBindings(room);for(const side of SIDES)if(snapshots[side])this.ingest(side,room[side==='codex'?'codexId':'deepseekId'],snapshots[side],roomId);this.store.transaction(()=>{this.store.activateRoom(roomId);this.baseline(room,snapshots);this.store.log('room','已继续该话题，投递保持暂停。');});this.changedRoom(snapshots);return this.store.room(roomId);}finally{this.releaseSides(SIDES);}}
  renameRoom(roomId,title){const room=this.store.renameRoom(roomId,this.roomTitle(title));this.notify();return room;}
  updateRoom({roomId,title,archived}){this.store.requireRoom(roomId);if(title!==undefined)title=this.roomTitle(title);if(archived!==undefined&&typeof archived!=='boolean')throw new RelayError('归档选项不正确','input');if(archived&&roomId===this.store.activeRoomId())throw new RelayError('请先新建或继续其他话题，再归档当前投递话题','busy');const room=this.store.transaction(()=>{if(title!==undefined)this.store.renameRoom(roomId,title);if(archived!==undefined)this.store.archiveRoom(roomId,archived);return this.store.room(roomId);});this.notify();return room;}
  deleteRoom({roomId}={}){if(this.changingRoom)throw new RelayError('正在切换话题，请稍后再删除','busy');const result=this.store.deleteRoom(roomId);this.notify();return result;}
  async bind(side,sessionId){
    if(!SIDES.includes(side)||typeof sessionId!=='string'||!sessionId.trim())throw new RelayError('请选择有效的原生会话','input');
    await this.reserveSides(SIDES);
    try{
      this.assertQueueSettled();sessionId=sessionId.trim();const key=side==='codex'?'codexId':'deepseekId',previous=this.store.requireRoom(this.store.activeRoomId()),binding={...previous,[key]:sessionId};await this.checkOutgoing(binding);const snapshots=await this.checkRoomBindings(binding),snapshot=snapshots[side];
      if(snapshot.state==='running')throw new RelayError('请选择空闲会话后绑定，避免转发正在进行的其他任务','busy');
      this.store.transaction(()=>{if(previous[key]!==sessionId){const room=this.store.createRoom({title:'本地协作',codexId:binding.codexId,deepseekId:binding.deepseekId,workspaceId:binding.workspaceId});this.store.activateRoom(room.id);}else this.store.set('paused',true);this.baseline(binding,snapshots);this.store.log('binding',`${side==='codex'?'Codex':'DeepSeek'} 已绑定：${snapshot.title}`);});
      this.changedRoom(snapshots);return snapshot;
    }finally{this.releaseSides(SIDES);}
  }
  async bindPair({codexId,deepseekId,title}){
    if([codexId,deepseekId].some(v=>typeof v!=='string'||!v.trim()||v.length>256))throw new RelayError('请分别选择会话，或填写两边的会话 ID','input');
    title=this.roomTitle(title,'本地协作');await this.reserveSides(SIDES);
    try{
      this.assertQueueSettled();
      codexId=codexId.trim();deepseekId=deepseekId.trim();
      await this.checkOutgoing({codexId,deepseekId});const snapshots=await Promise.all([this.adapters.codex.snapshot(codexId),this.adapters.deepseek.snapshot(deepseekId)]);
      if(snapshots.some(s=>s.state==='running'))throw new RelayError('指定的会话正在工作，请空闲后再绑定','busy');
      this.store.transaction(()=>{
        const previous=this.store.requireRoom(this.store.activeRoomId());if(previous.codexId!==codexId||previous.deepseekId!==deepseekId){const room=this.store.createRoom({title,codexId,deepseekId,workspaceId:previous.workspaceId});this.store.activateRoom(room.id);}else this.store.set('paused',true);
        for(let i=0;i<SIDES.length;i++){const side=SIDES[i],sessionId=i===0?codexId:deepseekId;for(const t of snapshots[i].turns)if(terminal(t.status))this.store.markSeen(side,sessionId,'turn:'+t.id);}
        this.store.log('binding',`已绑定指定会话：Codex ${codexId}；DeepSeek ${deepseekId}。旧历史不会重新转发，投递保持暂停。`);
      });
      for(let i=0;i<SIDES.length;i++){const side=SIDES[i],s=snapshots[i];this.epoch[side]++;this.health[side]={ok:true,state:s.state,title:s.title,cwd:s.cwd,checkedAt:Date.now()};}
      this.notify();return {codexId,deepseekId,roomId:this.store.activeRoomId(),room:this.store.room(this.store.activeRoomId())};
    }finally{this.releaseSides(SIDES);}
  }
  sendUser(text,targets=SIDES,roomId){return this.sendMessage({text,targets,roomId,sender:'user',origin:'console'});}
  sendMessage({text,targets,sender='user',origin,roomId=this.store.get('selectedRoomId',this.store.activeRoomId()),clientMessageId,imageIds=[]}={}){
    this.assertActiveRoom(roomId);
    if(!['user',...SIDES].includes(sender))throw new RelayError('消息作者不受支持','input');
    origin=origin||(sender==='user'?'console':'agent');
    if(!['console','agent','test'].includes(origin)||(sender==='user'&&origin!=='console')||(sender!=='user'&&origin==='console'))throw new RelayError('消息作者与来源不匹配','input');
    if(!Array.isArray(imageIds)||imageIds.length>4||imageIds.some(value=>typeof value!=='string')||new Set(imageIds).size!==imageIds.length)throw new RelayError('每条消息最多4张不同图片','input');
    if(imageIds.length&&!this.images)throw new RelayError('图片存储尚未启用','input');
    const images=imageIds.map(imageId=>this.images.describe(imageId));
    text=typeof text==='string'?text.trim():'';if((!text&&!images.length)||Buffer.byteLength(text,'utf8')>128000)throw new RelayError('请输入消息或选择图片，文字不超过128 KB','input');
    targets=targets||(sender==='user'?SIDES:SIDES.filter(side=>side!==sender));
    if(!Array.isArray(targets)||!targets.length||targets.some(side=>!SIDES.includes(side)||side===sender))throw new RelayError('请选择其他接收方','input');
    targets=[...new Set(targets)];for(const side of targets)if(!this.sessionId(side))throw new RelayError('请先绑定 '+side+' 会话','binding');
    if(images.length)for(const side of targets)if(this.imageCapability(side).supportsImages!==true)throw new RelayError(`${side} 尚未确认图像读取能力，请先验证后再发送图片`,'input');
    if(clientMessageId!==undefined&&(typeof clientMessageId!=='string'||!clientMessageId.trim()||clientMessageId.length>128))throw new RelayError('客户端消息 ID 无效','input');
    const nativeKey=clientMessageId?`client:${sender}:${roomId}:${clientMessageId}`:null;
    const msg=this.store.transaction(()=>{
      const existing=nativeKey?this.store.nativeMessage(nativeKey):null;
      if(existing){if(existing.text!==text||existing.meta.origin!==origin||JSON.stringify([...(existing.meta.targets||[])].sort())!==JSON.stringify([...targets].sort())||JSON.stringify((existing.meta.images||[]).map(image=>image.id))!==JSON.stringify(imageIds))throw new RelayError('同一个客户端消息 ID 不能用于不同内容','input');return existing;}
      const messageId=id();this.store.root(messageId,this.store.get('maxTurns',6));
      const m=this.store.addMessage({id:messageId,sender,text,roomId,nativeKey,meta:{targets,origin,...(images.length?{images,image:images[0]}:{}),...(clientMessageId?{clientMessageId}:{})}});
      for(const side of targets)this.store.enqueue(m,side,{force:true});return m;
    });this.notify();return msg;
  }
  protocolState(){const ready=this.store.get('protocolReady',{}),valid={};for(const side of SIDES){const entry=ready[side];valid[side]=entry?.sessionId===this.sessionId(side)&&this.sessionId(side)?entry:null;}return {mode:valid.codex&&valid.deepseek&&valid.codex.version===valid.deepseek.version?'compact':'reminder',ready:valid};}
  imageCapability(side){const entry=this.store.get('imageCapabilities',{})[side];return entry?.sessionId===this.sessionId(side)&&this.sessionId(side)?entry:{supportsImages:'unknown',imageMode:'file-tools',sessionId:this.sessionId(side)};}
  confirmImageCapability({side,sessionId,supportsImages}){if(!SIDES.includes(side)||!sessionId||sessionId!==this.sessionId(side)||typeof supportsImages!=='boolean')throw new RelayError('请指定当前绑定侧、会话及已核验的图像能力','input');const capabilities=this.store.get('imageCapabilities',{});capabilities[side]={sessionId,supportsImages,imageMode:'file-tools',checkedAt:Date.now()};this.store.set('imageCapabilities',capabilities);this.notify();return this.imageCapability(side);}
  confirmProtocol({side,sessionId,version}){if(!SIDES.includes(side)||sessionId!==this.sessionId(side)||!sessionId||typeof version!=='string'||!/^\d+\.\d+(?:\.\d+)?$/.test(version)||version.length>30)throw new RelayError('请确认当前侧、绑定会话及已加载的技能版本','input');const ready=this.store.get('protocolReady',{});ready[side]={sessionId,version,checkedAt:Date.now()};this.store.set('protocolReady',ready);this.notify();return this.protocolState();}
  setOptions(options){if(!options||typeof options!=='object'||Array.isArray(options))throw new RelayError('选项格式不正确','input');if('mode'in options&&!['auto','manual'].includes(options.mode))throw new RelayError('转发模式不受支持','input');if('maxTurns'in options&&(!Number.isInteger(options.maxTurns)||options.maxTurns<2||options.maxTurns>20))throw new RelayError('轮次预算必须在 2 到 20 之间','input');this.store.transaction(()=>{if('paused'in options)this.store.set('paused',!!options.paused);if('mode'in options)this.store.set('mode',options.mode);if('maxTurns'in options)this.store.set('maxTurns',options.maxTurns);});this.notify();}
  forward(messageId,side){if(!SIDES.includes(side)||!this.sessionId(side))throw new RelayError('接收方未连接','input');const m=this.store.message(messageId);if(!m)throw new RelayError('消息不存在','input');this.assertActiveRoom(m.roomId);if(m.meta.silent)throw new RelayError('静默控制记录不能转发','input');if(m.meta.images?.length&&this.imageCapability(side).supportsImages!==true)throw new RelayError('接收方尚未确认图像读取能力','input');if(m.sender===side)throw new RelayError('不向原发送方重复投递','input');const r=this.store.enqueue(m,side,{force:true});if(r.delivery?.status==='cancelled'){if(r.delivery.batchId)throw new RelayError('该消息属于已取消批次，请按整批处理，不能单条重发','input');this.store.updateDelivery(r.delivery.id,'queued',{error:null});}this.notify();return r;}
  deliveryUnit(d){return d.batchId?this.store.batchDeliveries(d.batchId):[this.store.delivery(d.id)];}
  updateUnit(d,status,options){if(d.batchId)this.store.updateBatch(d.batchId,status,options);else this.store.updateDelivery(d.id,status,options);}
  retry(deliveryId){const d=this.store.delivery(deliveryId);if(!d||this.deliveryUnit(d).some(item=>!['failed','blocked'].includes(item.status)||item.receipt))throw new RelayError('这条消息或其批次可能已送达，不能盲目重发；请回查原生会话','uncertain');this.assertActiveRoom(d.roomId);if(d.sessionId!==this.sessionId(d.side))throw new RelayError('投递绑定已变化，请先回查原生记录','binding');this.updateUnit(d,'queued',{error:null});this.notify();}
  cancel(deliveryId){const d=this.store.delivery(deliveryId);if(!d||this.deliveryUnit(d).some(item=>item.status!=='queued'))throw new RelayError('只能取消尚未发出的消息或整批','input');this.updateUnit(d,'cancelled',{error:null});this.notify();}
  resolve(deliveryId,decision,confirmed){const d=this.store.delivery(deliveryId);if(!d||this.deliveryUnit(d).some(item=>!['unknown','blocked','failed','running'].includes(item.status))||confirmed!==true||!['not-delivered','handled'].includes(decision))throw new RelayError('请先人工回查原生记录，再明确选择处理方式（批次将整批处理）','input');if(this.busy[d.side])throw new RelayError('正在同步该侧，请稍后重试','busy');if(decision==='not-delivered'){this.assertActiveRoom(d.roomId);if(d.sessionId!==this.sessionId(d.side))throw new RelayError('投递绑定已变化，请先继续原话题','binding');}this.store.set('paused',true);this.updateUnit(d,decision==='not-delivered'?'queued':'cancelled',{receipt:decision==='not-delivered'?null:undefined,error:decision==='handled'?'用户已在原应用处理，解除队列等待':null});this.store.log('resolution',`${d.side}：用户确认已回查原生记录，${decision==='not-delivered'?'未送达项重新排队':'解除在途等待'}；投递保持暂停。`,d.roomId);this.notify();}
  ingest(side,sessionId,snapshot,originRoomId){const bindingKey=side==='codex'?'codexId':'deepseekId';originRoomId=originRoomId||(this.store.room(this.store.activeRoomId())?.[bindingKey]===sessionId?this.store.activeRoomId():this.store.rooms().find(r=>r[bindingKey]===sessionId)?.id);if(!originRoomId)return;const ordered=[...snapshot.turns].sort((a,b)=>{const ai=snapshot.turns.indexOf(a),bi=snapshot.turns.indexOf(b);return side==='codex'?bi-ai:ai-bi;});for(const turn of ordered){
      const deleted=this.store.deletedRef('turn',turn.id,side,sessionId)||turn.inputs.some(input=>{
        const single=parseEnvelope(input.text),batch=parseBatchEnvelope(input.text);
        return (single&&this.store.deletedRef('message',single.id))||(batch&&this.store.deletedRef('batch',batch.id))||this.store.deletedRef('request',input.requestId,side,sessionId);
      });
      if(deleted){if(terminal(turn.status))this.store.markSeen(side,sessionId,'turn:'+turn.id);continue;}
      const matches=d=>d&&d.sessionId===sessionId;
      // Never split untrusted message bodies on inner headers. Recover the exact
      // persisted batch, including its immutable membership and destination.
      let batch=null;
      for(const input of turn.inputs){const header=parseBatchEnvelope(input.text);if(!header||header.side!==side)continue;const saved=this.store.batch(header.id);if(saved?.side===side&&saved.sessionId===sessionId&&saved.deliveryIds.length===header.count&&saved.payload.replace(/\r\n/g,'\n')===input.text.replace(/\r\n/g,'\n')){batch=saved;break;}}
      const linked=turn.inputs.map(i=>({input:i,env:parseEnvelope(i.text)})).find(x=>x.env&&matches(this.store.forMessage(x.env.id,side))&&!this.store.forMessage(x.env.id,side).batchId);
      let delivery=linked?this.store.forMessage(linked.env.id,side):this.store.jobs(side,['running','unknown']).find(d=>matches(d)&&(d.receipt?.nativeTurnId===turn.id||turn.inputs.some(i=>i.requestId===(d.batchId||d.id))));
      if(!batch&&delivery?.batchId)batch=this.store.batch(delivery.batchId);
      if(batch)delivery=this.store.batchDeliveries(batch.id).at(-1);
      if(delivery?.status==='cancelled'&&!delivery.receipt?.nativeTurnId)this.updateUnit(delivery,'cancelled',{receipt:{...delivery.receipt,nativeTurnId:turn.id,requestId:batch?.id||delivery.id,...(batch?{batchId:batch.id}:{})}});
      if(!batch&&(!delivery&&turn.inputs.some(input=>parseEnvelope(input.text))||turn.inputs.some(input=>parseBatchEnvelope(input.text)))){if(terminal(turn.status)&&!this.store.seen(side,sessionId,'turn:'+turn.id)){this.store.log('attention','无法核对信封原文与投递成员，已跳过该轮自动转发，请回查原生记录',originRoomId);this.store.markSeen(side,sessionId,'turn:'+turn.id);}continue;}
      if(delivery&&!['completed','cancelled'].includes(delivery.status)){
        const receipt={...delivery.receipt,nativeTurnId:turn.id,requestId:batch?.id||delivery.id,...(batch?{batchId:batch.id}:{})};
        if(terminal(turn.status)&&turn.status!=='completed')this.updateUnit(delivery,turn.status==='blocked'?'blocked':'failed',{receipt,error:`原生轮次 ${turn.status}${turn.reason?'：'+turn.reason:''}`});
        else this.updateUnit(delivery,terminal(turn.status)?'completed':'running',{receipt,error:null});
      }
      if(!terminal(turn.status)||this.store.seen(side,sessionId,'turn:'+turn.id))continue;
      this.store.transaction(()=>{if(isControl(turn)){this.store.markSeen(side,sessionId,'turn:'+turn.id);return;}let parent=delivery?this.store.message(delivery.messageId):null;
        if(!parent){const user=turn.inputs.find(i=>i.kind==='user'&&!parseEnvelope(i.text)&&!parseBatchEnvelope(i.text));if(user){const key=`${side}:${sessionId}:user:${user.id}`;parent=this.store.nativeMessage(key);if(!parent){const rootId=id();this.store.root(rootId,this.store.get('maxTurns',6));parent=this.store.addMessage({id:rootId,sender:'user',text:user.text,rootId,nativeKey:key,roomId:originRoomId,meta:{native:true,side,nativeTurnId:turn.id}});}}}
        const rawText=turn.outputs.map(o=>o.text).join('\n\n');if(rawText.trim()&&turn.status==='completed'){const flags=signals(rawText),messageId=id();const rootId=parent?.rootId||messageId;this.store.root(rootId,this.store.get('maxTurns',6));const m=this.store.addMessage({id:messageId,sender:side,text:flags.text,replyTo:parent?.id||null,rootId,hop:(parent?.hop||0)+1,roomId:parent?.roomId||originRoomId,nativeKey:`${side}:${sessionId}:final:${turn.id}`,meta:{nativeTurnId:turn.id,stop:flags.stop,wait:flags.wait,...(flags.silent?{silent:true,control:'no-reply'}:{}),outputIds:turn.outputs.map(o=>o.id),...(batch?{batchId:batch.id,inReplyToMessageIds:this.store.batchDeliveries(batch.id).map(d=>d.messageId)}:{})}});if(!this.changingRoom&&m.roomId===this.store.activeRoomId()&&!flags.silent&&!flags.stop&&!flags.wait&&delivery?.status!=='cancelled'&&this.store.get('mode','auto')==='auto'){const other=side==='codex'?'deepseek':'codex';if(this.sessionId(other)){if(Buffer.byteLength(m.text,'utf8')>128000)this.store.log('attention','回复超过自动投递大小限制，请手动整理后发送',m.roomId);else{const r=this.store.enqueue(m,other);if(r.limited)this.store.log('budget','本次消息已达到自动协作轮次上限，等待用户继续。',m.roomId);}}}if(flags.wait)this.store.log('attention',`${side==='codex'?'Codex':'DeepSeek'} 正在等待用户回答或确认。`,m.roomId);}
        this.store.markSeen(side,sessionId,'turn:'+turn.id);});}}
  prepareBatch(side,queue,roomId,sessionId){
    const first=queue[0];if(first.batchId)return this.store.batch(first.batchId);
    const candidates=[];
    for(const d of queue){if(d.batchId||d.roomId!==roomId||d.sessionId!==sessionId)break;candidates.push(d);}
    if(candidates.length<2||(candidates.length<4&&Date.now()-first.createdAt<30000))return null;
    const batch={id:id(),side},members=[],compact=this.protocolState().mode==='compact';let payload;
    for(const d of candidates.slice(0,6)){
      const proposed=[...members,d],text=batchEnvelope(batch,proposed.map(item=>this.store.message(item.messageId)),{compact});
      if(Buffer.byteLength(text,'utf8')>100*1024)break;
      members.push(d);payload=text;
    }
    if(members.length<2)return null;
    return this.store.createBatch({...batch,deliveryIds:members.map(d=>d.id),payload});
  }
  async tick(side){
    if(this.closed||this.busy[side])return;
    const sessionId=this.sessionId(side),roomId=this.store.activeRoomId();
    if(!sessionId){this.health[side]={ok:false,state:'unbound',error:'尚未绑定会话'};return;}
    this.busy[side]=true;const epoch=this.epoch[side];
    try{
      const snapshot=await this.adapters[side].snapshot(sessionId,{knownTurn:tid=>this.store.seen(side,sessionId,'turn:'+tid)});
      if(this.closed||epoch!==this.epoch[side])return;
      this.ingest(side,sessionId,snapshot);
      this.health[side]={ok:true,state:snapshot.state,title:snapshot.title,cwd:snapshot.cwd,checkedAt:Date.now(),endpoint:side==='deepseek'?this.adapters[side].base:undefined};
      const inFlight=this.store.jobs(side,['sending','running','unknown']);
      if(!this.store.get('paused',true)&&!inFlight.length&&snapshot.state!=='running'){
        const queue=this.store.jobs(side),next=queue[0];
        if(next){
          if(next.roomId!==roomId||next.sessionId!==sessionId){
            this.updateUnit(next,'blocked',{error:'投递所属话题或目标会话已变化，请回查原生记录后处理'});
            this.store.set('paused',true);
          }else{
            const batch=this.prepareBatch(side,queue,roomId,sessionId),unit=this.store.delivery(next.id);
            const payload=batch?.payload||envelope(this.store.message(next.messageId),{compact:this.protocolState().mode==='compact'}),requestId=batch?.id||next.id;
            try{
              for(const member of this.deliveryUnit(unit))for(const image of this.store.message(member.messageId).meta.images||[]){
                if(!this.images||this.imageCapability(side).supportsImages!==true)throw new RelayError('接收方图像能力未确认，已暂停图片投递','input');
                const saved=await this.images.read(image.id);if(saved.image.path!==image.path)throw new RelayError('图片存储位置变化，请重新上传后发送','input');
              }
            }catch(error){if(this.deliveryUnit(unit).every(member=>member.status==='queued')){this.updateUnit(unit,'blocked',{error:safeError(error)});this.store.set('paused',true);this.notify();}return;}
            // Reading attachments yields to HTTP handlers: a user may cancel
            // the queued unit during that read. Never send a cancelled batch.
            if(this.deliveryUnit(unit).some(member=>member.status!=='queued'))return;
            if(this.deliveryUnit(unit).some(member=>this.store.message(member.messageId).meta.images?.length)&&this.imageCapability(side).supportsImages!==true){this.updateUnit(unit,'blocked',{error:'接收方图像能力已变化，请重新核验'});this.store.set('paused',true);this.notify();return;}
            this.updateUnit(unit,'sending',{error:null});this.notify();
            try{const result=await this.adapters[side].send(next.sessionId,payload,requestId),receipt={...result,...(batch?{batchId:batch.id}:{})};this.updateUnit(unit,'running',{receipt,error:null});}
            catch(e){if(e.code==='busy')this.updateUnit(unit,'queued',{receipt:null,error:null});else this.updateUnit(unit,e.uncertain?'unknown':'failed',{receipt:e.uncertain?e.receipt||null:undefined,error:safeError(e)});}
          }
        }
      }
      this.notify();
    }catch(e){const text=safeError(e);const now=Date.now();const last=this.connLogAt[side];if(this.health[side]?.error!==text&&(!last||last.text!==text||now-last.t>30000)){this.store.log('connection',`${side==='codex'?'Codex':'DeepSeek'}：${text}`);this.connLogAt[side]={text,t:now};}this.health[side]={ok:false,state:'offline',error:text,checkedAt:Date.now()};this.notify();}
    finally{this.busy[side]=false;}
  }
  state(roomId){return {...this.store.state(roomId),health:Object.fromEntries(SIDES.map(side=>[side,{...this.health[side],...this.imageCapability(side)}])),protocol:this.protocolState()};}
}
