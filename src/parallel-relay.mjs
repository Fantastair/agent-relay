import {Relay,SIDES,isControl} from './relay.mjs';
import {parseEnvelope,parseBatchEnvelope,RelayError,sleep,safeError} from './util.mjs';

const bindingKey=side=>side==='codex'?'codexId':'deepseekId';
const resourceKey=(side,sessionId)=>JSON.stringify([side,sessionId]);
const unresolved=['queued','sending','running','unknown','blocked','failed'];
const inFlight=['sending','running','unknown'];
const localKeys=new Set(['paused','mode','maxTurns','protocolReady','imageCapabilities','provisionDraft','channelHistory']);

// Existing delivery/reconciliation code runs against a pinned room. Global
// UI selection can never redirect a worker, option write, or late receipt.
function scopedStore(owner,roomId){
  const root=owner.store;
  return new Proxy(root,{
    get(target,key,receiver){
      if(key==='activeRoomId')return ()=>roomId;
      if(key==='get')return (name,fallback)=>{
        if(name==='activeRoomId'||name==='selectedRoomId')return roomId;
        if(['codexId','deepseekId','workspaceId'].includes(name))return root.room(roomId)?.[name]??fallback;
        if(localKeys.has(name)){
          const value=root.roomOptions(roomId)[name]??fallback;
          if(name==='mode'&&(root.room(roomId)?.archived||!root.room(roomId)?.codexId||!root.room(roomId)?.deepseekId||root.bindingConflicts(roomId).length))return 'manual';
          if(name==='paused'&&owner.engines.get(roomId)?.dispatching)return !!value||owner.store.get('pausedAll',false)||!owner.claim(roomId);
          return value;
        }
        return root.get(name,fallback);
      };
      if(key==='set')return (name,value)=>{
        if(localKeys.has(name))return root.patchRoomOptions(roomId,{[name]:value});
        if(['codexId','deepseekId','workspaceId'].includes(name))return root.bindRoom(roomId,{...root.requireRoom(roomId),[name]:value});
        if(name==='selectedRoomId')return root.set(name,value);
        if(name==='activeRoomId')throw new RelayError('话题引擎不能改变其他话题的路由','input');
        return root.set(name,value);
      };
      if(key==='jobs')return (side,statuses,requestedRoom=roomId)=>root.jobs(side,statuses,requestedRoom);
      if(key==='state')return ()=>root.state(roomId);
      if(key==='enqueue')return (message,...args)=>{
        if(message.roomId!==roomId)throw new RelayError('消息不属于此话题','input');
        if(root.requireRoom(roomId).archived)throw new RelayError('归档话题只读，请先恢复','input');
        return Reflect.get(target,key,receiver).call(receiver,message,...args);
      };
      return Reflect.get(target,key,receiver);
    },
  });
}

export class ParallelRelay{
  constructor(store,adapters,{images}={}){
    this.store=store;this.adapters=adapters;this.images=images;
    this.engines=new Map();this.leases=new Set();this.reserved=new Set();this.lastServed=new Map();this.sequence=0;
    this.sessionHealth=new Map();this.snapshots=new Map();this.polling=new Map();this.ticks=new Set();this.mutations=new Set();
    this.historicalBackoff=new Map();this.closed=false;this.health={};this.busy={};
  }
  notify(){this.onChange?.();}
  defaultRoom(){return this.store.get('selectedRoomId',this.store.activeRoomId());}
  requireRoom(roomId=this.defaultRoom()){
    if(typeof roomId!=='string'||!roomId)throw new RelayError('请指定话题 roomId','input');
    const room=this.store.room(roomId);if(!room)throw new RelayError('话题不存在，请刷新列表','not_found');return room;
  }
  engine(roomId=this.defaultRoom()){
    this.requireRoom(roomId);let engine=this.engines.get(roomId);if(engine)return engine;
    const native=Object.fromEntries(SIDES.map(side=>[side,{
      snapshot:async(sessionId,options)=>{
        const key=resourceKey(side,sessionId);let request=this.snapshots.get(key);
        if(!request){request=Promise.resolve().then(()=>this.adapters[side].snapshot(sessionId,options));this.snapshots.set(key,request);}
        let snapshot;try{snapshot=await request;}catch(error){this.sessionHealth.set(key,{ok:false,state:'offline',error:safeError(error),checkedAt:Date.now()});throw error;}
        this.sessionHealth.set(key,{ok:true,state:snapshot.state,hasInProgressTurn:snapshot.turns.some(turn=>turn.status==='inProgress'),title:snapshot.title,cwd:snapshot.cwd,checkedAt:Date.now()});
        return {...snapshot,turns:snapshot.turns.filter(turn=>this.belongs(turn,side,sessionId,roomId))};
      },
      send:async(sessionId,text,requestId)=>{
        if(this.closed||this.mutations.has(roomId)||this.store.get('pausedAll',false)||this.store.roomOptions(roomId).paused||this.store.bindingConflicts(roomId).length||!this.owns(roomId))throw new RelayError('话题等待投递槽位或需要换绑','busy');
        if(sessionId!==this.sessionId(side,roomId))throw new RelayError('会话绑定已变化','binding');
        return this.adapters[side].send(sessionId,text,requestId);
      },
    }]));
    engine=new Relay(scopedStore(this,roomId),native,{images:this.images});engine.onChange=()=>this.notify();
    engine.assertActiveRoom=target=>{const room=this.requireRoom(roomId);if(target!==roomId||room.archived)throw new RelayError('归档话题只读，请先恢复','input');if(this.mutations.has(roomId))throw new RelayError('正在配置该话题','busy');this.store.assertBindingAvailable(roomId,room);if(!room.codexId||!room.deepseekId)throw new RelayError('此话题尚未绑定完整的一对会话，请先连接 Codex 和 DeepSeek','binding');};
    this.engines.set(roomId,engine);return engine;
  }
  sessionId(side,roomId=this.defaultRoom()){return this.store.room(roomId)?.[bindingKey(side)]||null;}
  belongs(turn,side,sessionId,roomId){
    // Exact saved request/receipt identities take precedence over a session's
    // current binding, including cancelled deliveries and deleted records.
    for(const input of turn.inputs){
      const batch=parseBatchEnvelope(input.text),single=parseEnvelope(input.text);
      if(batch){const saved=this.store.batch(batch.id);if(saved)return saved.roomId===roomId;}
      if(single){const message=this.store.message(single.id);if(message)return message.roomId===roomId;}
    }
    const delivery=this.store.jobs(side,[...inFlight,'completed','cancelled','failed','blocked']).find(d=>d.sessionId===sessionId&&(d.receipt?.nativeTurnId===turn.id||turn.inputs.some(input=>input.requestId===(d.batchId||d.id))));
    if(delivery)return delivery.roomId===roomId;
    if(this.store.seen(side,sessionId,'turn:'+turn.id))return false;
    const rooms=this.store.rooms().filter(r=>r[bindingKey(side)]===sessionId);
    if(rooms.length===1)return rooms[0].id===roomId;
    // Control / deleted / unverifiable relay inputs can be safely reconciled
    // once. Unlinked native chat in a shared session has no trustworthy topic.
    if(rooms[0]?.id!==roomId)return false;
    if(isControl(turn)||this.store.deletedRef('turn',turn.id,side,sessionId)||turn.inputs.some(input=>parseEnvelope(input.text)||parseBatchEnvelope(input.text)||this.store.deletedRef('request',input.requestId,side,sessionId)))return true;
    if(['completed','failed','interrupted','blocked'].includes(turn.status)){
      this.store.log('attention','共用原生会话中的直接输入无法确定所属话题，未导入或转发；请在对应话题中发送。',roomId);
      this.store.markSeen(side,sessionId,'turn:'+turn.id);
    }
    return false;
  }
  roomKeys(roomId){const room=this.store.room(roomId);return room?SIDES.filter(side=>room[bindingKey(side)]).map(side=>resourceKey(side,room[bindingKey(side)])):[];}
  flights(roomId){return SIDES.flatMap(side=>this.store.jobs(side,inFlight,roomId));}
  cleanLeases(){for(const roomId of this.leases)if(!this.flights(roomId).length&&!this.reserved.has(roomId))this.leases.delete(roomId);for(const d of SIDES.flatMap(side=>this.store.jobs(side,inFlight)))this.leases.add(d.roomId);}
  runningRooms(){return [...this.leases].filter(roomId=>this.reserved.has(roomId)||this.flights(roomId).some(d=>d.status!=='unknown'||this.sessionHealth.get(resourceKey(d.side,d.sessionId))?.state==='running'));}
  shares(a,b){const keys=this.roomKeys(a);return this.roomKeys(b).some(key=>keys.includes(key));}
  compareRooms(a,b){const order=roomId=>Number(this.store.db.prepare("SELECT min(rowid) AS n FROM deliveries WHERE room_id=? AND status='queued'").get(roomId).n??Number.MAX_SAFE_INTEGER);return (this.lastServed.get(a.id)||0)-(this.lastServed.get(b.id)||0)||order(a.id)-order(b.id)||a.createdAt-b.createdAt||a.id.localeCompare(b.id);}
  owns(roomId){return this.leases.has(roomId)&&![...this.leases].some(other=>other!==roomId&&this.shares(roomId,other));}
  eligible(room){
    if(room.archived||!room.codexId||!room.deepseekId||this.store.bindingConflicts(room.id).length||this.mutations.has(room.id)||this.store.roomOptions(room.id).paused)return false;
    if(SIDES.some(side=>this.store.jobs(side,['unknown','blocked','failed'],room.id).length))return false;
    return SIDES.some(side=>this.store.jobs(side,['queued'],room.id).length&&this.sessionId(side,room.id)&&this.sessionHealth.get(resourceKey(side,this.sessionId(side,room.id)))?.ok===true&&this.sessionHealth.get(resourceKey(side,this.sessionId(side,room.id)))?.state!=='running');
  }
  claim(roomId){
    this.cleanLeases();
    if(this.store.get('pausedAll',false)||this.mutations.has(roomId)||this.store.bindingConflicts(roomId).length)return false;
    if(SIDES.some(side=>this.store.jobs(side,['unknown','blocked','failed'],roomId).length))return false;
    const limit=this.store.get('concurrencyLimit',2);
    if(this.runningRooms().length>limit)return false;
    if(this.leases.has(roomId))return this.owns(roomId);
    if(this.runningRooms().length>=limit)return false;
    const candidates=this.store.rooms().filter(room=>this.eligible(room)&&!this.leases.has(room.id)&&![...this.leases].some(other=>this.shares(room.id,other))).sort((a,b)=>this.compareRooms(a,b));
    if(candidates[0]?.id!==roomId)return false;
    this.leases.add(roomId);this.reserved.add(roomId);this.lastServed.set(roomId,++this.sequence);return true;
  }
  async tick(side){
    if(this.closed)return;
    // Only the individual native session is coalesced. A slow session must
    // never stop later timer cycles from polling/reconciling healthy sessions.
    const operation=(async()=>{await this.pollPass(side);await this.pollHistorical(side);await this.pollPass(side);})();
    this.ticks.add(operation);try{await operation;}finally{this.ticks.delete(operation);}
  }
  async pollPass(side){
    if(this.closed)return;
    const rooms=this.store.rooms().sort((a,b)=>this.compareRooms(a,b));
    await Promise.all(rooms.map(async room=>{
      if(this.mutations.has(room.id)||!this.sessionId(side,room.id))return;
      const key=resourceKey(side,this.sessionId(side,room.id));
      if(this.polling.has(key))return;
      // Shared sessions are polled once, then each room filters exact receipts.
      const shared=rooms.filter(r=>this.sessionId(side,r.id)===this.sessionId(side,room.id));
      const operation=(async()=>{
        for(const target of shared.sort((a,b)=>this.compareRooms(a,b))){
          if(this.closed||this.mutations.has(target.id))continue;
          const engine=this.engine(target.id);engine.dispatching=(engine.dispatching||0)+1;
          try{await engine.tick(side);}finally{engine.dispatching--;if(!SIDES.some(s=>engine.busy[s]))this.reserved.delete(target.id);this.cleanLeases();}
        }
      })();
      this.polling.set(key,operation);try{await operation;}finally{this.polling.delete(key);this.snapshots.delete(key);}
    }));
  }
  async pollHistorical(side){
    if(this.closed)return;
    const groups=new Map();
    for(const delivery of this.store.jobs(side,['cancelled'])){
      if(!delivery.attempts||!delivery.sessionId||delivery.sessionId===this.sessionId(side,delivery.roomId))continue;
      if(delivery.receipt?.nativeTurnId&&this.store.seen(side,delivery.sessionId,'turn:'+delivery.receipt.nativeTurnId))continue;
      const key=resourceKey(side,delivery.sessionId);if(!groups.has(key))groups.set(key,new Set());groups.get(key).add(delivery.roomId);
    }
    await Promise.all([...groups].map(async([key,roomIds])=>{
      if(this.polling.has(key)||Date.now()<(this.historicalBackoff.get(key)||0))return;
      const sessionId=JSON.parse(key)[1];
      const operation=(async()=>{try{
        const snapshot=await this.adapters[side].snapshot(sessionId,{knownTurn:turnId=>this.store.seen(side,sessionId,'turn:'+turnId)});
        if(this.closed)return;
        for(const roomId of roomIds)if(this.store.room(roomId))this.ingest(side,sessionId,snapshot,roomId);
      }catch(error){this.historicalBackoff.set(key,Date.now()+60000);for(const roomId of roomIds)if(this.store.room(roomId))this.store.log('attention','旧会话回执暂时无法回查，未重发任何消息：'+safeError(error),roomId);}})();
      this.polling.set(key,operation);try{await operation;}finally{this.polling.delete(key);}
    }));
  }
  start(){this.timer=setInterval(()=>{for(const side of SIDES)void this.tick(side);},1800);for(const side of SIDES)void this.tick(side);}
  async stop(){this.closed=true;clearInterval(this.timer);for(const engine of this.engines.values())engine.closed=true;await Promise.allSettled([...this.ticks]);this.adapters.codex.close?.();}
  assertQueueSettled(roomId=this.defaultRoom()){if(SIDES.some(side=>this.store.jobs(side,unresolved,roomId).length))throw new RelayError('请先完成、取消或处理该话题的未完成投递','busy');}
  async reserveSides(sides,roomId=this.defaultRoom()){
    this.requireRoom(roomId);if(this.mutations.has(roomId))throw new RelayError('正在配置该话题','busy');this.mutations.add(roomId);
    const start=Date.now();while(sides.some(side=>this.polling.has(resourceKey(side,this.sessionId(side,roomId))))){if(Date.now()-start>5000){this.mutations.delete(roomId);throw new RelayError('该话题仍在同步，请稍后重试','busy');}await sleep(50);}
  }
  releaseSides(sides,roomId=this.defaultRoom()){this.mutations.delete(roomId);}
  async checkRoomBindings(room){return this.engine(room.id).checkRoomBindings(room);}
  changedRoom(){this.notify();}
  selectRoom(roomId){const room=this.requireRoom(roomId);this.store.set('selectedRoomId',room.id);this.notify();return room;}
  async createRoom({title,reuseBindings=false,roomId=this.defaultRoom()}={}){
    const previous=this.requireRoom(roomId);title=this.engine(roomId).roomTitle(title);
    if(typeof reuseBindings!=='boolean')throw new RelayError('话题绑定选项不正确','input');
    if(reuseBindings)throw new RelayError('一个话题必须使用独立的一对会话，新话题不能复用来源绑定','input');
    const room=this.store.transaction(()=>{
      const created=this.store.createRoom({title,kind:'topic',parentId:previous.id,workspaceId:previous.workspaceId});
      this.store.writeRoomOptions(created.id,{...this.store.roomOptions(previous.id),paused:true,protocolReady:{},imageCapabilities:{},provisionDraft:null,channelHistory:[]});this.store.set('selectedRoomId',created.id);return created;
    });this.notify();return room;
  }
  async activateRoom(roomId){const room=this.requireRoom(roomId);this.store.transaction(()=>{this.store.archiveRoom(roomId,false);this.store.patchRoomOptions(roomId,{paused:true});this.store.set('selectedRoomId',roomId);});this.notify();return this.store.room(room.id);}
  renameRoom(roomId,title){return this.updateRoom({roomId,title});}
  updateRoom({roomId,title,archived}){
    this.requireRoom(roomId);if(title!==undefined)title=this.engine(roomId).roomTitle(title);
    if(archived!==undefined&&typeof archived!=='boolean')throw new RelayError('归档选项不正确','input');
    if(archived)this.assertQueueSettled(roomId);
    if(this.mutations.has(roomId))throw new RelayError('正在配置该话题','busy');
    const result=this.store.transaction(()=>{if(title!==undefined)this.store.renameRoom(roomId,title);if(archived!==undefined){this.store.archiveRoom(roomId,archived);if(archived)this.store.patchRoomOptions(roomId,{paused:true});}return this.store.room(roomId);});this.notify();return result;
  }
  deleteRoom({roomId}={}){
    if(typeof roomId!=='string'||!roomId)throw new RelayError('请指定话题 roomId','input');
    this.requireRoom(roomId);this.assertQueueSettled(roomId);if(this.mutations.has(roomId)||SIDES.some(side=>this.engines.get(roomId)?.busy[side]))throw new RelayError('话题仍在同步，请稍后重试','busy');
    if(roomId===this.store.activeRoomId()){
      const next=this.store.rooms().find(room=>room.id!==roomId);if(!next)throw new RelayError('请先新建另一个话题，再删除最后一个话题','busy');
      // Store's legacy default must always point at a surviving room.
      const result=this.store.deleteRoom(roomId,{replacementRoomId:next.id});this.engines.delete(roomId);this.notify();return result;
    }
    const result=this.deleteStoredRoom(roomId);this.engines.delete(roomId);this.notify();return result;
  }
  deleteStoredRoom(roomId){return this.store.deleteRoom(roomId);}
  context(roomId=this.defaultRoom()){return this.engine(roomId).store;}
  ingest(side,sessionId,snapshot,roomId){const candidates=roomId?[this.requireRoom(roomId)]:this.store.rooms().filter(room=>room[bindingKey(side)]===sessionId);for(const room of candidates)this.engine(room.id).ingest(side,sessionId,{...snapshot,turns:snapshot.turns.filter(turn=>this.belongs(turn,side,sessionId,room.id))},room.id);}
  async bindPair({roomId=this.defaultRoom(),codexId,deepseekId,title}={}){
    const room=this.requireRoom(roomId);if([codexId,deepseekId].some(v=>typeof v!=='string'||!v.trim()||v.length>256))throw new RelayError('请分别选择有效的会话 ID','input');
    if(room.archived)throw new RelayError('请先恢复归档话题','input');if(title!==undefined)title=this.engine(roomId).roomTitle(title);
    this.store.assertBindingAvailable(roomId,{codexId:codexId.trim(),deepseekId:deepseekId.trim()});
    await this.reserveSides(SIDES,roomId);try{
      this.assertQueueSettled(roomId);
      for(const side of SIDES){const oldSession=room[bindingKey(side)],nextSession=side==='codex'?codexId.trim():deepseekId.trim();if(oldSession&&oldSession!==nextSession){const previous=await this.adapters[side].snapshot(oldSession);if(previous.state==='running')throw new RelayError('原绑定的会话仍在工作，请完成后再换绑','busy');this.ingest(side,oldSession,previous,roomId);}}
      const snapshots=await Promise.all(SIDES.map(side=>this.adapters[side].snapshot(side==='codex'?codexId.trim():deepseekId.trim())));
      if(snapshots.some(snapshot=>snapshot.state==='running'))throw new RelayError('指定的原生会话正在工作，请空闲后再绑定','busy');
      // bindRoom checks ownership again inside this transaction after all
      // native reads have finished; concurrent requests cannot both win.
      this.store.transaction(()=>{this.store.bindRoom(roomId,{...room,codexId:codexId.trim(),deepseekId:deepseekId.trim()});this.store.patchRoomOptions(roomId,{paused:true,protocolReady:{},imageCapabilities:{}});if(title)this.store.renameRoom(roomId,title);this.engine(roomId).baseline(this.store.room(roomId),Object.fromEntries(SIDES.map((side,i)=>[side,snapshots[i]])));});
      this.notify();return {roomId,codexId:codexId.trim(),deepseekId:deepseekId.trim(),room:this.store.room(roomId)};
    }finally{this.releaseSides(SIDES,roomId);}
  }
  async bind(side,sessionId,roomId=this.defaultRoom()){if(!SIDES.includes(side))throw new RelayError('接收方不正确','input');const room=this.requireRoom(roomId);return this.bindPair({roomId,codexId:room.codexId,deepseekId:room.deepseekId,[bindingKey(side)]:sessionId});}
  setOptions(options){
    if(!options||typeof options!=='object'||Array.isArray(options))throw new RelayError('选项格式不正确','input');
    const room=this.requireRoom(options.roomId);if(options.paused!==undefined&&typeof options.paused!=='boolean')throw new RelayError('暂停选项必须是布尔值','input');
    this.engine(room.id).setOptions(options);return {ok:true,roomId:room.id};
  }
  setScheduler({limit,pausedAll}={}){
    if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1))throw new RelayError('并发上限必须为正整数','input');
    if(pausedAll!==undefined&&typeof pausedAll!=='boolean')throw new RelayError('总闸选项必须是布尔值','input');
    this.store.transaction(()=>{if(limit!==undefined)this.store.set('concurrencyLimit',limit);if(pausedAll!==undefined)this.store.set('pausedAll',pausedAll);});this.notify();return this.concurrency();
  }
  concurrency(){this.cleanLeases();return {limit:this.store.get('concurrencyLimit',2),running:this.runningRooms().length,pausedAll:this.store.get('pausedAll',false)};}
  sendUser(text,targets=SIDES,roomId=this.defaultRoom()){return this.sendMessage({text,targets,roomId});}
  sendMessage(body={}){const room=this.requireRoom(body.roomId);if(this.mutations.has(room.id))throw new RelayError('正在配置该话题，请稍后发送','busy');return this.engine(room.id).sendMessage({...body,roomId:room.id});}
  forward(messageId,side){const message=this.store.message(messageId);if(!message)throw new RelayError('消息不存在','input');return this.engine(message.roomId).forward(messageId,side);}
  retry(deliveryId){const delivery=this.store.delivery(deliveryId);if(!delivery)throw new RelayError('投递不存在','input');return this.engine(delivery.roomId).retry(deliveryId);}
  cancel(deliveryId){const delivery=this.store.delivery(deliveryId);if(!delivery)throw new RelayError('投递不存在','input');return this.engine(delivery.roomId).cancel(deliveryId);}
  resolve(deliveryId,...args){const delivery=this.store.delivery(deliveryId);if(!delivery)throw new RelayError('投递不存在','input');return this.engine(delivery.roomId).resolve(deliveryId,...args);}
  confirmProtocol(body){return this.engine(this.requireRoom(body.roomId).id).confirmProtocol(body);}
  confirmImageCapability(body){return this.engine(this.requireRoom(body.roomId).id).confirmImageCapability(body);}
  protocolState(roomId=this.defaultRoom()){return this.engine(roomId).protocolState();}
  imageCapability(side,roomId=this.defaultRoom()){return this.engine(roomId).imageCapability(side);}
  roomHealth(room){return Object.fromEntries(SIDES.map(side=>{
    const engine=this.engines.get(room.id),sessionId=room[bindingKey(side)],cached=this.sessionHealth.get(resourceKey(side,sessionId));
    return [side,{...(cached||engine?.health[side]||{state:sessionId?'unknown':'unbound'}),...this.imageCapability(side,room.id)}];
  }));}
  describe(room){
    const options=this.store.roomOptions(room.id),health=this.roomHealth(room),queued=SIDES.flatMap(side=>this.store.jobs(side,['queued'],room.id)),flight=this.flights(room.id);
    const waiting=SIDES.some(side=>this.store.jobs(side,['unknown','blocked','failed'],room.id).length)||this.store.db.prepare("SELECT json_extract(meta,'$.wait') AS waiting FROM messages WHERE room_id=? AND coalesce(json_extract(meta,'$.silent'),0)!=1 ORDER BY created_at DESC,rowid DESC LIMIT 1").get(room.id)?.waiting;
    const bindingConflicts=this.store.bindingConflicts(room.id),bindingStatus=bindingConflicts.length?'conflict':!room.codexId||!room.deepseekId?'unbound':'ready';
    const runState=room.archived?'idle':flight.some(d=>d.status!=='unknown')?'running':bindingStatus==='conflict'?'waiting':bindingStatus==='unbound'?'unbound':waiting?'waiting':options.paused?'paused':queued.length?'queued':'idle';
    return {...room,paused:!!options.paused,mode:options.mode,maxTurns:options.maxTurns,queueLength:queued.length,runState,health,bindingStatus,bindingConflicts,sharedWith:[...new Map(bindingConflicts.map(conflict=>[conflict.roomId,{roomId:conflict.roomId,title:conflict.title}])).values()]};
  }
  state(roomId=this.defaultRoom()){
    if(this.store.deletedRef('room',roomId))roomId=this.store.activeRoomId();const room=this.requireRoom(roomId),base=this.store.state(roomId),options=this.store.roomOptions(roomId),rooms=this.store.rooms().map(r=>this.describe(r)),view=rooms.find(r=>r.id===roomId);
    return {...base,room:view,rooms,readOnly:room.archived,health:view.health,settings:{...base.settings,roomId,paused:!!options.paused,mode:options.mode,maxTurns:options.maxTurns,codexId:room.codexId,deepseekId:room.deepseekId,workspaceId:room.workspaceId},protocol:this.protocolState(roomId),concurrency:this.concurrency(),logs:this.store.db.prepare('SELECT * FROM logs WHERE room_id=? ORDER BY id DESC LIMIT 60').all(roomId).map(log=>({id:log.id,kind:log.kind,text:log.text,roomId:log.room_id,createdAt:log.created_at}))};
  }
}
