import {DatabaseSync} from 'node:sqlite';
import {id,RelayError} from './util.mjs';
export class Store{
  constructor(file){this.db=new DatabaseSync(file);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,sender TEXT NOT NULL,text TEXT NOT NULL,reply_to TEXT,root_id TEXT NOT NULL,hop INTEGER NOT NULL DEFAULT 0,native_key TEXT UNIQUE,meta TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS roots(id TEXT PRIMARY KEY,max_turns INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id),side TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(message_id,side));
    CREATE TABLE IF NOT EXISTS seen(side TEXT NOT NULL,session_id TEXT NOT NULL,native_key TEXT NOT NULL,PRIMARY KEY(side,session_id,native_key));
    CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS delivery_status ON deliveries(side,status,created_at);
    CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,title TEXT NOT NULL,codex_id TEXT,deepseek_id TEXT,workspace_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,archived_at INTEGER);`);
    this.transaction(()=>{
      this.db.exec(`CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,filename TEXT NOT NULL UNIQUE,mime TEXT NOT NULL,bytes INTEGER NOT NULL,w INTEGER NOT NULL,h INTEGER NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL);`);
      const add=(table,name,type)=>{if(!this.db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===name))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);};
      this.db.exec(`CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,side TEXT NOT NULL,room_id TEXT NOT NULL REFERENCES rooms(id),session_id TEXT NOT NULL,payload TEXT NOT NULL,delivery_ids TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);
      add('messages','room_id','TEXT REFERENCES rooms(id)');add('deliveries','room_id','TEXT REFERENCES rooms(id)');add('deliveries','session_id','TEXT');add('deliveries','batch_id','TEXT REFERENCES batches(id)');add('logs','room_id','TEXT REFERENCES rooms(id)');add('rooms','kind',"TEXT NOT NULL DEFAULT 'binding'");add('rooms','parent_id','TEXT');
      let active=this.get('activeRoomId',null);
      if(!active||!this.room(active)){const now=Date.now(),hasHistory=!!this.db.prepare('SELECT 1 FROM messages LIMIT 1').get();active=id();this.db.prepare('INSERT INTO rooms(id,title,codex_id,deepseek_id,workspace_id,created_at,updated_at,kind) VALUES(?,?,?,?,?,?,?,?)').run(active,hasHistory?'历史对话':'本地协作',this.get('codexId',null),this.get('deepseekId',null),this.get('workspaceId',null),now,now,hasHistory?'legacy':'binding');this.set('activeRoomId',active);}
      this.db.prepare('UPDATE messages SET room_id=? WHERE room_id IS NULL').run(active);
      this.db.exec('UPDATE deliveries SET room_id=(SELECT room_id FROM messages WHERE messages.id=deliveries.message_id) WHERE room_id IS NULL');
      this.db.exec("UPDATE deliveries SET session_id=(SELECT CASE deliveries.side WHEN 'codex' THEN codex_id ELSE deepseek_id END FROM rooms WHERE rooms.id=deliveries.room_id) WHERE session_id IS NULL");
      this.db.prepare('UPDATE logs SET room_id=? WHERE room_id IS NULL').run(active);
      this.db.exec(`CREATE TABLE IF NOT EXISTS message_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE REFERENCES messages(id));
        INSERT OR IGNORE INTO message_events(message_id) SELECT id FROM messages ORDER BY created_at,rowid;
        CREATE TRIGGER IF NOT EXISTS message_event_insert AFTER INSERT ON messages BEGIN INSERT OR IGNORE INTO message_events(message_id) VALUES(NEW.id); END;`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS deleted_relay_refs(kind TEXT NOT NULL,ref TEXT NOT NULL,side TEXT NOT NULL DEFAULT '',session_id TEXT NOT NULL DEFAULT '',PRIMARY KEY(kind,ref,side,session_id));`);
      this.db.exec('CREATE INDEX IF NOT EXISTS message_room ON messages(room_id,created_at);CREATE INDEX IF NOT EXISTS delivery_room ON deliveries(room_id,side,status);CREATE INDEX IF NOT EXISTS log_room ON logs(room_id,id)');
      this.db.prepare("UPDATE deliveries SET status='unknown',error='服务重启时投递尚未确认，正在回查原生记录',updated_at=? WHERE status='sending'").run(Date.now());
      this.db.prepare("UPDATE batches SET status='unknown',error='服务重启时整批投递尚未确认，正在回查原生记录',updated_at=? WHERE status='sending'").run(Date.now());
    });}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  get(key,fallback){const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}
  set(key,value){this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));const column={codexId:'codex_id',deepseekId:'deepseek_id',workspaceId:'workspace_id'}[key];if(column)this.db.prepare(`UPDATE rooms SET ${column}=?,updated_at=? WHERE id=?`).run(value,Date.now(),this.activeRoomId());}
  activeRoomId(){return this.get('activeRoomId',null);}
  decodeRoom(r){return r?{id:r.id,title:r.title,kind:r.kind,parentId:r.parent_id,codexId:r.codex_id,deepseekId:r.deepseek_id,workspaceId:r.workspace_id,createdAt:r.created_at,updatedAt:r.updated_at,lastAt:r.updated_at,archivedAt:r.archived_at,archived:!!r.archived_at,messageCount:Number(r.message_count||0),lastMessage:r.last_message||''}:null;}
  room(roomId){if(typeof roomId!=='string'||!roomId||roomId.length>256)return null;return this.decodeRoom(this.db.prepare('SELECT r.*,(SELECT count(*) FROM messages m WHERE m.room_id=r.id AND coalesce(json_extract(m.meta,\'$.silent\'),0)!=1) AS message_count,(SELECT text FROM messages m WHERE m.room_id=r.id AND coalesce(json_extract(m.meta,\'$.silent\'),0)!=1 ORDER BY created_at DESC,rowid DESC LIMIT 1) AS last_message FROM rooms r WHERE id=?').get(roomId));}
  rooms(){return this.db.prepare('SELECT id FROM rooms ORDER BY updated_at DESC,rowid DESC').all().map(r=>this.room(r.id));}
  requireRoom(roomId){const room=this.room(roomId);if(!room)throw new RelayError('话题不存在，请刷新列表','input');return room;}
  createRoom({title='新话题',kind='binding',parentId=null,codexId=null,deepseekId=null,workspaceId=null}={}){const roomId=id(),now=Date.now();this.db.prepare('INSERT INTO rooms(id,title,codex_id,deepseek_id,workspace_id,created_at,updated_at,kind,parent_id) VALUES(?,?,?,?,?,?,?,?,?)').run(roomId,title,codexId,deepseekId,workspaceId,now,now,kind,parentId);return this.room(roomId);}
  activateRoom(roomId){const room=this.requireRoom(roomId),now=Date.now();this.db.prepare('UPDATE rooms SET archived_at=NULL,updated_at=? WHERE id=?').run(now,roomId);this.set('activeRoomId',roomId);this.set('selectedRoomId',roomId);this.set('codexId',room.codexId);this.set('deepseekId',room.deepseekId);this.set('workspaceId',room.workspaceId);this.set('paused',true);return this.room(roomId);}
  renameRoom(roomId,title){this.requireRoom(roomId);this.db.prepare('UPDATE rooms SET title=?,updated_at=? WHERE id=?').run(title,Date.now(),roomId);return this.room(roomId);}
  archiveRoom(roomId,archived){this.requireRoom(roomId);this.db.prepare('UPDATE rooms SET archived_at=?,updated_at=? WHERE id=?').run(archived?Date.now():null,Date.now(),roomId);return this.room(roomId);}
  deletedRef(kind,ref,side='',sessionId=''){return typeof ref==='string'&&!!this.db.prepare('SELECT 1 FROM deleted_relay_refs WHERE kind=? AND ref=? AND side=? AND session_id=?').get(kind,ref,side,sessionId);}
  deleteRoom(roomId){return this.transaction(()=>{
    if(typeof roomId!=='string'||!roomId||roomId.length>256)throw new RelayError('请选择有效的话题','input');
    if(!this.room(roomId))throw new RelayError('话题不存在，可能已经删除，请刷新列表','not_found');
    const activeRoomId=this.activeRoomId();
    if(roomId===activeRoomId)throw new RelayError('当前投递话题不能删除，请先新建或继续其他话题','busy');
    if(this.db.prepare("SELECT 1 FROM deliveries WHERE room_id=? AND status NOT IN ('completed','cancelled') LIMIT 1").get(roomId)||this.db.prepare("SELECT 1 FROM batches WHERE room_id=? AND status NOT IN ('completed','cancelled') LIMIT 1").get(roomId))throw new RelayError('该话题存在未完成投递，请先完成、取消或处理后再删除','busy');
    // Keep opaque identities, never message content, so late native receipts
    // cannot resurrect deleted conversations after their delivery rows are gone.
    const remember=this.db.prepare('INSERT OR IGNORE INTO deleted_relay_refs(kind,ref,side,session_id) VALUES(?,?,?,?)');
    for(const row of this.db.prepare('SELECT id FROM messages WHERE room_id=?').all(roomId))remember.run('message',row.id,'','');
    for(const row of this.db.prepare('SELECT id,side,session_id,receipt FROM deliveries WHERE room_id=?').all(roomId)){
      const receipt=row.receipt?JSON.parse(row.receipt):null;
      remember.run('request',row.id,row.side,row.session_id||'');
      if(receipt?.requestId)remember.run('request',receipt.requestId,row.side,row.session_id||'');
      if(receipt?.nativeTurnId)remember.run('turn',receipt.nativeTurnId,row.side,row.session_id||'');
    }
    for(const row of this.db.prepare('SELECT id,side,session_id,receipt FROM batches WHERE room_id=?').all(roomId)){
      const receipt=row.receipt?JSON.parse(row.receipt):null;
      remember.run('batch',row.id,'','');remember.run('request',row.id,row.side,row.session_id);
      if(receipt?.requestId)remember.run('request',receipt.requestId,row.side,row.session_id);
      if(receipt?.nativeTurnId)remember.run('turn',receipt.nativeTurnId,row.side,row.session_id);
    }
    this.db.prepare('DELETE FROM deliveries WHERE room_id=?').run(roomId);
    this.db.prepare('DELETE FROM batches WHERE room_id=?').run(roomId);
    this.db.prepare('DELETE FROM message_events WHERE message_id IN (SELECT id FROM messages WHERE room_id=?)').run(roomId);
    this.db.prepare('DELETE FROM roots WHERE id IN (SELECT root_id FROM messages WHERE room_id=?) AND NOT EXISTS (SELECT 1 FROM messages WHERE root_id=roots.id AND room_id!=?)').run(roomId,roomId);
    this.db.prepare('DELETE FROM messages WHERE room_id=?').run(roomId);
    this.db.prepare('DELETE FROM logs WHERE room_id=?').run(roomId);
    this.db.prepare('UPDATE rooms SET parent_id=NULL WHERE parent_id=?').run(roomId);
    this.db.prepare('DELETE FROM rooms WHERE id=?').run(roomId);
    if(this.get('selectedRoomId',activeRoomId)===roomId)this.set('selectedRoomId',activeRoomId);
    return {ok:true,roomId,selectedRoomId:this.get('selectedRoomId',activeRoomId)};
  });}
  log(kind,text,roomId=this.activeRoomId()){this.db.prepare('INSERT INTO logs(kind,text,created_at,room_id) VALUES(?,?,?,?)').run(kind,text,Date.now(),roomId);}
  root(rootId,maxTurns){this.db.prepare('INSERT OR IGNORE INTO roots VALUES(?,?)').run(rootId,maxTurns);}
  addMessage({id:messageId=id(),sender,text,replyTo=null,rootId=messageId,hop=0,nativeKey=null,meta={},roomId}){const parent=replyTo?this.message(replyTo):null,root=this.message(rootId);roomId=roomId||parent?.roomId||root?.roomId||this.activeRoomId();this.requireRoom(roomId);if((parent&&parent.roomId!==roomId)||(root&&root.roomId!==roomId))throw new RelayError('回复和原消息必须属于同一话题','input');const now=Date.now(),result=this.db.prepare('INSERT OR IGNORE INTO messages(id,sender,text,reply_to,root_id,hop,native_key,meta,created_at,room_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(messageId,sender,text,replyTo,rootId,hop,nativeKey,JSON.stringify(meta),now,roomId);if(result.changes&&!meta.silent)this.db.prepare('UPDATE rooms SET updated_at=? WHERE id=?').run(now,roomId);return this.message(messageId);}
  decodeMessage(m){return m?{id:m.id,sender:m.sender,text:m.text,replyTo:m.reply_to,rootId:m.root_id,hop:m.hop,nativeKey:m.native_key,meta:JSON.parse(m.meta),createdAt:m.created_at,roomId:m.room_id}:null;}
  message(messageId){return this.decodeMessage(this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId));}
  nativeMessage(key){return this.decodeMessage(this.db.prepare('SELECT * FROM messages WHERE native_key=?').get(key));}
  addImage(image){this.db.prepare('INSERT INTO images(id,filename,mime,bytes,w,h,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)').run(image.id,image.filename,image.mime,image.bytes,image.w,image.h,image.sha256,Date.now());}
  image(imageId){const row=this.db.prepare('SELECT * FROM images WHERE id=?').get(imageId);if(!row)return null;const {created_at,...image}=row;return {...image,createdAt:created_at};}
  decodeDelivery(d){return d?{id:d.id,messageId:d.message_id,side:d.side,status:d.status,receipt:d.receipt?JSON.parse(d.receipt):null,error:d.error,attempts:d.attempts,createdAt:d.created_at,updatedAt:d.updated_at,roomId:d.room_id,sessionId:d.session_id,batchId:d.batch_id||null,batchIndex:d.batch_id?this.batch(d.batch_id).deliveryIds.indexOf(d.id):null}:null;}
  delivery(deliveryId){return this.decodeDelivery(this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(deliveryId));}
  forMessage(messageId,side){return this.decodeDelivery(this.db.prepare('SELECT * FROM deliveries WHERE message_id=? AND side=?').get(messageId,side));}
  enqueue(message,side,{force=false}={}){const existing=this.forMessage(message.id,side);if(existing)return {delivery:existing,existing:true};const room=this.requireRoom(message.roomId);if(room.id!==this.activeRoomId())throw new RelayError('历史话题不能直接投递，请先继续该话题','input');const max=this.db.prepare('SELECT max_turns FROM roots WHERE id=?').get(message.rootId)?.max_turns||6;const count=this.db.prepare("SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.root_id=? AND d.status!='cancelled'").get(message.rootId).n;if(!force&&count>=max)return {limited:true};const deliveryId=id(),now=Date.now(),sessionId=side==='codex'?room.codexId:room.deepseekId;this.db.prepare('INSERT INTO deliveries(id,message_id,side,status,receipt,error,attempts,created_at,updated_at,room_id,session_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(deliveryId,message.id,side,'queued',null,null,0,now,now,room.id,sessionId);return {delivery:this.delivery(deliveryId)};}
  updateDelivery(deliveryId,status,{receipt,error}={}){const old=this.delivery(deliveryId);if(!old)return;this.db.prepare('UPDATE deliveries SET status=?,receipt=?,error=?,attempts=?,updated_at=? WHERE id=?').run(status,receipt===undefined?(old.receipt?JSON.stringify(old.receipt):null):JSON.stringify(receipt),error===undefined?old.error:error,old.attempts+(status==='sending'?1:0),Date.now(),deliveryId);}
  jobs(side,statuses=['queued'],roomId){if(!statuses.length)return [];return this.db.prepare(`SELECT * FROM deliveries WHERE side=? AND status IN (${statuses.map(()=>'?').join(',')})${roomId?' AND room_id=?':''} ORDER BY created_at,rowid`).all(side,...statuses,...(roomId?[roomId]:[])).map(d=>this.decodeDelivery(d));}
  batch(batchId){const row=this.db.prepare('SELECT * FROM batches WHERE id=?').get(batchId);return row?{id:row.id,side:row.side,roomId:row.room_id,sessionId:row.session_id,payload:row.payload,deliveryIds:JSON.parse(row.delivery_ids),status:row.status,receipt:row.receipt?JSON.parse(row.receipt):null,error:row.error,createdAt:row.created_at,updatedAt:row.updated_at}:null;}
  batchDeliveries(batchId){return (this.batch(batchId)?.deliveryIds||[]).map(deliveryId=>this.delivery(deliveryId));}
  createBatch({id:batchId,deliveryIds,payload}){return this.transaction(()=>{
    const deliveries=deliveryIds.map(deliveryId=>this.delivery(deliveryId)),first=deliveries[0];
    if(deliveries.length<2||deliveries.length>6||new Set(deliveryIds).size!==deliveries.length||!first?.sessionId||deliveries.some(d=>!d||d.status!=='queued'||d.batchId||d.side!==first.side||d.roomId!==first.roomId||d.sessionId!==first.sessionId)||Buffer.byteLength(payload,'utf8')>100*1024)throw new RelayError('合批成员或大小不符合投递条件','input');
    const now=Date.now();this.db.prepare('INSERT INTO batches(id,side,room_id,session_id,payload,delivery_ids,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(batchId,first.side,first.roomId,first.sessionId,payload,JSON.stringify(deliveryIds),'queued',now,now);
    for(const d of deliveries)this.db.prepare('UPDATE deliveries SET batch_id=? WHERE id=?').run(batchId,d.id);
    return this.batch(batchId);
  });}
  updateBatch(batchId,status,options={}){return this.transaction(()=>{
    const batch=this.batch(batchId);if(!batch)throw new RelayError('批次不存在','input');
    for(const deliveryId of batch.deliveryIds)this.updateDelivery(deliveryId,status,options);
    this.db.prepare('UPDATE batches SET status=?,receipt=?,error=?,updated_at=? WHERE id=?').run(status,options.receipt===undefined?(batch.receipt?JSON.stringify(batch.receipt):null):JSON.stringify(options.receipt),options.error===undefined?batch.error:options.error,Date.now(),batchId);
  });}
  publicBatches(roomId,{all=false}={}){let completed=0;return this.db.prepare(`SELECT id FROM batches${roomId?' WHERE room_id=?':''} ORDER BY created_at DESC,rowid DESC`).all(...(roomId?[roomId]:[])).map(row=>this.batch(row.id)).filter(batch=>all||!['completed','cancelled'].includes(batch.status)||completed++<600).map(({payload,...batch})=>({...batch,count:batch.deliveryIds.length,messageIds:batch.deliveryIds.map(deliveryId=>this.delivery(deliveryId).messageId),byteLength:Buffer.byteLength(payload,'utf8')}));}
  seen(side,sessionId,key){return !!this.db.prepare('SELECT 1 FROM seen WHERE side=? AND session_id=? AND native_key=?').get(side,sessionId,key);}
  markSeen(side,sessionId,key){this.db.prepare('INSERT OR IGNORE INTO seen VALUES(?,?,?)').run(side,sessionId,key);}
  inbox({side,all=false,roomId,after='0',limit=100}={}){
    if(!['codex','deepseek'].includes(side))throw new RelayError('请指定收件方 codex 或 deepseek','input');
    if(typeof all!=='boolean'||(all&&roomId))throw new RelayError('收件箱范围不正确','input');
    if(!Number.isInteger(limit)||limit<1||limit>500)throw new RelayError('分页条数需要在 1 到 500 之间','input');
    let cursor;if(/^\d+$/.test(String(after)))cursor=Number(after);else if(typeof after==='string'){const known=this.db.prepare('SELECT seq FROM message_events WHERE message_id=?').get(after);if(!known)throw new RelayError('收件箱游标消息不存在，请明确重新定位','input');cursor=Number(known.seq);}
    if(!Number.isSafeInteger(cursor)||cursor<0)throw new RelayError('收件箱游标无效','input');
    if(!all){roomId=roomId||this.activeRoomId();this.requireRoom(roomId);}
    // AUTOINCREMENT's high-water mark survives removal of the latest event.
    const latest=Number(this.db.prepare("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='message_events'),0) AS seq").get().seq);
    if(cursor>latest)throw new RelayError('游标超出当前历史范围，请明确重新定位','input');
    const rows=this.db.prepare(`SELECT m.*,e.seq AS sequence FROM message_events e JOIN messages m ON m.id=e.message_id WHERE e.seq>? AND m.sender!=? AND coalesce(json_extract(m.meta,\'$.silent\'),0)!=1${all?'':' AND m.room_id=?'} ORDER BY e.seq LIMIT ?`).all(cursor,side,...(all?[]:[roomId]),limit+1);
    const hasMore=rows.length>limit,messages=rows.slice(0,limit).map(row=>({...this.decodeMessage(row),sequence:Number(row.sequence)}));
    const observedLatest=Math.max(latest,messages.at(-1)?.sequence||0),nextCursor=hasMore?messages.at(-1).sequence:observedLatest;
    return {side,scope:all?'all':'room',roomId:all?null:roomId,activeRoomId:this.activeRoomId(),messages,hasMore,nextCursor:String(nextCursor),latestCursor:String(observedLatest)};
  }
  state(roomId=this.get('selectedRoomId',this.activeRoomId())){const room=this.requireRoom(roomId),activeRoomId=this.activeRoomId();return {activeRoomId,roomId,room,rooms:this.rooms(),batches:this.publicBatches(roomId),readOnly:roomId!==activeRoomId,settings:{roomId,activeRoomId,paused:this.get('paused',true),mode:this.get('mode','auto'),maxTurns:this.get('maxTurns',6),codexId:this.get('codexId',null),deepseekId:this.get('deepseekId',null),workspaceId:this.get('workspaceId',null)},messages:this.db.prepare('SELECT * FROM (SELECT *,rowid AS position FROM messages WHERE room_id=? AND coalesce(json_extract(meta,\'$.silent\'),0)!=1 ORDER BY created_at DESC,rowid DESC LIMIT 500) ORDER BY created_at,position').all(roomId).map(m=>this.decodeMessage(m)),deliveries:[...this.db.prepare("SELECT * FROM deliveries WHERE room_id=? AND status NOT IN ('completed','cancelled') ORDER BY created_at DESC,rowid DESC").all(roomId),...this.db.prepare("SELECT * FROM deliveries WHERE room_id=? AND status IN ('completed','cancelled') ORDER BY created_at DESC,rowid DESC LIMIT 600").all(roomId)].map(d=>this.decodeDelivery(d)),logs:this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 60').all().map(l=>({id:l.id,kind:l.kind,text:l.text,roomId:l.room_id,createdAt:l.created_at}))};}
  close(){this.db.close();}
  exportHistory(roomId){if(roomId)this.requireRoom(roomId);const state=this.state(roomId||this.activeRoomId()),where=roomId?' WHERE room_id=?':'',args=roomId?[roomId]:[];return {...state,batches:this.publicBatches(roomId,{all:true}),scope:roomId?'room':'all',rooms:roomId?[this.room(roomId)]:this.rooms(),messages:this.db.prepare('SELECT * FROM messages'+where+' ORDER BY created_at,rowid').all(...args).map(m=>this.decodeMessage(m)),deliveries:this.db.prepare('SELECT * FROM deliveries'+where+' ORDER BY created_at,rowid').all(...args).map(d=>this.decodeDelivery(d)),logs:this.db.prepare('SELECT * FROM logs'+where+' ORDER BY id').all(...args)};}
}
