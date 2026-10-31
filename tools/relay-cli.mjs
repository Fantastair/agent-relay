#!/usr/bin/env node
/**
 * relay-cli — 中转台补充通道。
 *
 * 正常对话仍走中转台自动转发；本工具用于：
 *   status  查看两边健康、队列、最后活动
 *   inbox   主动读取自己没收到的消息（推进已读游标）
 *   send    作为某一方主动发一条消息
 *   quota   查询两边额度
 *   mail    通过本机配置的邮件 API 通知用户
 *
 * 仅在本机使用，读取 agent-relay/data/control.key；不打印该 key。
 */
import {readFile, writeFile, mkdir, access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.RELAY_DATA_DIR || path.join(ROOT, 'data');
const NAMES = {user: '你', codex: 'Codex', deepseek: 'DeepSeek'};

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined;
};
const has = (name) => argv.includes('--' + name);
const positional = () => {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { i++; continue; }
    out.push(argv[i]);
  }
  return out;
};

async function readKey(name) {
  try {
    return (await readFile(path.join(DATA, name), 'utf8')).replace(/^\uFEFF/, '').trim();
  } catch {
    return null;
  }
}

async function baseUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL.replace(/\/$/, '');
  try {
    const j = JSON.parse(await readFile(path.join(DATA, 'instance.json'), 'utf8'));
    if (j.url) return j.url.replace(/\/$/, '');
  } catch {}
  return 'http://127.0.0.1:4319';
}

async function api(pathname, body) {
  const key = await readKey('control.key');
  if (!key) throw new Error('缺少 data/control.key，无法访问中转台');
  const res = await fetch((await baseUrl()) + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined
      ? {authorization: 'Bearer ' + key}
      : {authorization: 'Bearer ' + key, 'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`);
  return json;
}

function clock(ms) {
  return new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai'}).format(ms);
}
function ago(ms) {
  if (!ms) return '无记录';
  const d = Math.max(0, Date.now() - ms);
  if (d < 60000) return Math.floor(d / 1000) + ' 秒前';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}
function cut(s, n) {
  const flat = String(s || '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}
function sideOf(value) {
  if (value === 'codex' || value === 'deepseek') return value;
  throw new Error('请用 --as codex 或 --as deepseek 指定自己');
}

async function resolveRoom(arg, {required = false} = {}) {
  const st = await api('/api/state');
  const rooms = st.rooms || [];
  const live = rooms.filter(r => !r.archived);
  if (!arg) {
    if (required && live.length > 1) {
      throw new Error('有多个话题，请用 --room 指定（话题 ID 或唯一标题）：' + live.map(r => r.title + '=' + r.id.slice(0, 8)).join(' · '));
    }
    return {st, room: rooms.find(r => r.id === st.roomId) || live[0] || rooms[0] || null};
  }
  const byId = rooms.find(r => r.id === arg || r.id.startsWith(arg));
  if (byId) return {st, room: byId};
  const byTitle = rooms.filter(r => r.title === arg);
  if (byTitle.length === 1) return {st, room: byTitle[0]};
  if (byTitle.length > 1) throw new Error('有多个同名话题，请用 ID：' + byTitle.map(r => r.id).join('，'));
  throw new Error('找不到话题：' + arg);
}

/* ---------------- status ---------------- */

async function status(json) {
  const st = await api('/api/state');
  const health = st.health || {};
  const settings = st.settings || {};
  const last = st.messages[st.messages.length - 1];
  const active = (st.deliveries || []).filter(d => !['completed', 'cancelled'].includes(d.status));

  if (json) {
    console.log(JSON.stringify({settings, health, last, active, concurrency: st.concurrency, rooms: st.rooms}, null, 2));
    return;
  }
  console.log('中转台 ' + (await baseUrl()));
  console.log('房间 ' + (st.rooms?.find(r => r.id === settings.roomId)?.title || '本地协作') + ' · ' + st.messages.length + ' 条消息');
  const gatePaused = st.concurrency ? st.concurrency.pausedAll : settings.paused;
  console.log('投递 ' + (gatePaused ? '已暂停' : '进行中') + ' · 上限 ' + settings.maxTurns + ' · 模式 ' + settings.mode);
  if (st.concurrency) {
    const c = st.concurrency;
    console.log(`并行 ${c.running}/${c.limit}${c.pausedAll ? ' · 总闸已暂停' : ''}`);
  }
  if (Array.isArray(st.rooms) && st.rooms.length) {
    const label = {idle: '空闲', queued: '排队', running: '运行', waiting: '待处理', paused: '暂停', unbound: '未绑定'};
    console.log('话题 ' + st.rooms.filter(r => !r.archived).map(r => {
      const state = label[r.runState] || r.runState || '空闲';
      const bind = r.bindingStatus && r.bindingStatus !== 'ready'
        ? (r.bindingStatus === 'unbound' ? '未绑定' : '绑定冲突')
        : '';
      const parts = bind && bind !== state ? [state, bind] : [state];
      return r.title + ' ' + parts.join('/') + (r.queueLength ? '(' + r.queueLength + ')' : '');
    }).join(' · '));
  }
  for (const side of ['codex', 'deepseek']) {
    const h = health[side] || {};
    const state = h.state || (settings[side + 'Id'] ? '未知' : '未绑定');
    console.log(`  ${NAMES[side].padEnd(8)} ${state.padEnd(6)} ${h.title || ''} ${h.error ? '· ' + cut(h.error, 60) : ''}`);
  }
  if (last) console.log('最后消息 ' + clock(last.createdAt) + ' ' + NAMES[last.sender] + '：' + cut(last.text, 60));
  else console.log('最后消息 无');
  if (active.length) {
    console.log('待投递：');
    active.slice(-8).forEach(d => {
      const uncertain = ['unknown', 'blocked', 'failed'].includes(d.status);
      const mode = uncertain ? '待回查' : d.deliveryMode === 'steer' ? '引导' : d.deliveryMode === 'start' ? '启动' : '排队';
      const turn = d.nativeTurnId ? ' · turn ' + String(d.nativeTurnId).slice(0, 8) : (d.acceptedAt ? ' · 轮次待确认' : '');
      console.log(`  #${d.id.slice(0, 6)} ${NAMES[d.side]} ${d.status} · ${mode}${turn} ${cut(d.error || '', 50)}`);
    });
  } else {
    console.log('待投递：无');
  }
  console.log('提示：inbox --as <me> 查看自己没读到的消息；quota 查额度。');
}

/* ---------------- inbox ---------------- */

async function cursorPath(side) {
  return path.join(DATA, 'collab', side + '.json');
}
async function loadCursor(side) {
  try { return JSON.parse(await readFile(await cursorPath(side), 'utf8')); } catch { return {lastId: null, lastAt: 0}; }
}
async function saveCursor(side, cursor) {
  await mkdir(path.join(DATA, 'collab'), {recursive: true});
  await writeFile(await cursorPath(side), JSON.stringify(cursor, null, 2));
}

async function features() {
  try {
    const j = await api('/api/health');
    return new Set(Array.isArray(j.features) ? j.features : []);
  } catch {
    return new Set();
  }
}

async function inboxCursorFile(side, scope) {
  return path.join(DATA, 'collab', 'inbox-' + side + '-' + scope + '.json');
}
async function loadInboxCursor(side, scope) {
  try { return JSON.parse(await readFile(await inboxCursorFile(side, scope), 'utf8')); } catch { return null; }
}
async function saveInboxCursor(side, scope, value) {
  await mkdir(path.join(DATA, 'collab'), {recursive: true});
  await writeFile(await inboxCursorFile(side, scope), JSON.stringify(value, null, 2));
}

function printMessages(list, side, cursorLabel) {
  if (!list.length) {
    console.log(`没有新消息（${side}，游标 ${cursorLabel}）。`);
    return;
  }
  for (const m of list) {
    console.log('');
    console.log(`[${clock(m.createdAt)}] ${NAMES[m.sender] || m.sender} #${m.id.slice(0, 8)}${m.meta?.origin === 'test' ? ' [测试]' : ''}${m.meta?.wait ? ' [等用户]' : ''}${m.meta?.stop ? ' [已收束]' : ''}`);
    console.log(has('full') ? m.text : cut(m.text, 400));
  }
  console.log('');
  console.log(`共 ${list.length} 条新消息。`);
}

async function inbox() {
  const side = sideOf(flag('as'));
  const peek = has('peek') || has('json');
  const all = has('all');
  const roomArg = typeof flag('room') === 'string' ? flag('room') : null;
  const sinceArg = flag('since');
  if (all && roomArg) throw new Error('--all 和 --room 不能同时使用');

  const feats = await features();
  if (!feats.has('inbox-cursor-v1')) {
    await inboxLegacy(side, {peek, sinceArg});
    return;
  }

  let targetRoom = null;
  if (!all) {
    const resolved = await resolveRoom(roomArg, {required: true});
    targetRoom = resolved.room;
    if (!targetRoom) throw new Error('没有可用话题');
  }

  // 先探一次，拿到真实活动房间；游标按 roomId 存，切换活动房间不会复用。
  const probeQuery = new URLSearchParams({as: side, limit: '1'});
  if (all) probeQuery.set('all', '1');
  else probeQuery.set('roomId', targetRoom.id);
  const probe = await api('/api/inbox?' + probeQuery);
  const roomKey = all ? 'all' : targetRoom.id;

  const stored = await loadInboxCursor(side, roomKey);
  let after;
  if (sinceArg === 'all') after = 0;
  else if (typeof sinceArg === 'string') after = sinceArg;
  else if (stored) after = stored.cursor;
  else after = null;

  if (after === null) {
    const latest = probe.latestCursor ?? 0;
    if (!peek) await saveInboxCursor(side, roomKey, {cursor: latest, roomId: probe.roomId, at: Date.now()});
    console.log(`首次运行：${peek ? '只读模式，未写游标' : '游标定位到最新'}（${latest}，房间 ${roomKey}）。`);
    return;
  }

  let cursor = after, out = [], page = null, guard = 0;
  while (guard++ < 25) {
    const q = new URLSearchParams({as: side, after: String(cursor), limit: '200'});
    if (all) q.set('all', '1');
    else q.set('roomId', targetRoom.id);
    page = await api('/api/inbox?' + q);
    out.push(...(page.messages || []));
    if (!page.hasMore) { cursor = page.nextCursor ?? cursor; break; }
    cursor = page.nextCursor ?? cursor;
  }

  if (has('json')) {
    console.log(JSON.stringify({side, scope: page?.scope, roomId: roomKey, after, cursor, messages: out}, null, 2));
  } else {
    printMessages(out, side, after);
  }
  if (!peek && out.length) {
    await saveInboxCursor(side, roomKey, {cursor, roomId: page?.roomId || roomKey, at: Date.now()});
  }
}

async function inboxLegacy(side, {peek, sinceArg}) {
  const st = await api('/api/state');
  const messages = st.messages || [];
  const cursor = await loadCursor(side);
  const sinceAll = sinceArg === 'all';
  const sinceId = typeof sinceArg === 'string' && !sinceAll ? sinceArg : cursor.lastId;
  const firstRun = !cursor.lastId && !sinceArg;

  let start = 0;
  if (sinceAll) start = 0;
  else if (sinceId) {
    const idx = messages.findIndex(m => m.id === sinceId || m.id.startsWith(sinceId));
    if (idx >= 0) start = idx + 1;
    else {
      const byTime = messages.findIndex(m => m.createdAt > (cursor.lastAt || 0));
      start = byTime < 0 ? messages.length : byTime;
      if (cursor.lastId) console.log('提示：游标消息不在当前窗口，已按时间回退；旧消息不会重放。');
    }
  }

  if (firstRun) {
    const tail = messages.slice(-2);
    if (!peek && tail.length) await saveCursor(side, {lastId: tail[tail.length - 1].id, lastAt: tail[tail.length - 1].createdAt});
    console.log(`首次运行：${peek ? '只读模式，未写游标' : `已把 ${side} 的游标定位到最新消息`}。要看历史用 inbox --as ${side} --since all --peek。`);
    for (const m of tail) console.log(`  [${clock(m.createdAt)}] ${NAMES[m.sender]}：${cut(m.text, 100)}`);
    return;
  }

  const fresh = messages.slice(start).filter(m => m.sender !== side);
  if (has('json')) console.log(JSON.stringify({side, since: sinceId, cursor, messages: fresh}, null, 2));
  else printMessages(fresh, side, sinceId || '无');

  if (!peek && fresh.length) {
    const last = fresh[fresh.length - 1];
    await saveCursor(side, {lastId: last.id, lastAt: last.createdAt});
  }
}

/* ---------------- send ---------------- */

async function send() {
  const side = sideOf(flag('as'));
  const to = flag('to');
  if (to !== 'codex' && to !== 'deepseek') throw new Error('请用 --to codex|deepseek');
  if (to === side) throw new Error('不能向自己投递');
  const text = positional().join(' ').trim();
  if (!text) throw new Error('缺少消息内容');

  let roomId = null;
  const roomArg = typeof flag('room') === 'string' ? flag('room') : null;
  const {room} = await resolveRoom(roomArg, {required: true});
  if (room) roomId = room.id;

  const feats = await features();
  if (!feats.has('message-attribution-v1')) {
    throw new Error('后端缺少 message-attribution-v1（多半还是旧进程），拒绝发送：否则 Agent 发言会被记成用户。--force 也不放行，等 4319 重启到新后端。');
  }

  const clientMessageId = 'cli-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const res = await api('/api/message', {text, targets: [to], sender: side, origin: 'agent', clientMessageId, ...(roomId ? {roomId} : {})});
  const got = res.message?.sender;
  if (got && got !== side) throw new Error('后端把来源记成了 ' + got + '，已停止；请核对队列里是否已入队。');
  let mode = '';
  try {
    for (let i = 0; i < 12 && !mode; i++) {
      await new Promise(r => setTimeout(r, 500));
      const st = await api('/api/state' + (roomId ? '?roomId=' + encodeURIComponent(roomId) : ''));
      const d = (st.deliveries || []).find(x => x.messageId === res.message.id);
      if (!d) continue;
      if (['unknown', 'blocked', 'failed'].includes(d.status)) { mode = '待回查'; break; }
      if (d.status === 'queued' || !d.acceptedAt) continue;
      const label = d.deliveryMode === 'steer' ? '已注入当前轮' : d.deliveryMode === 'start' ? '已启动新轮' : '已接受';
      mode = d.nativeTurnId ? label + ' · turn ' + String(d.nativeTurnId).slice(0, 8) : '已接受 · 轮次待确认';
    }
  } catch {}
  if (!mode) mode = '待投递';
  console.log('已入队 #' + (res.message?.id || '?').slice(0, 8) + ' → ' + NAMES[to] + (roomId ? '（话题 ' + roomId.slice(0, 8) + '）' : '') + '，' + mode + '，来源 ' + side);
}

/* ---------------- quota ---------------- */

async function dshBase() {
  const cache = path.join(DATA, 'collab', 'dsh-base.json');
  try {
    const j = JSON.parse(await readFile(cache, 'utf8'));
    if (Date.now() - j.at < 300000 && j.base) return j.base;
  } catch {}

  let pids = [];
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], {encoding: 'utf8'});
    pids = out.split('\n').map(l => l.match(/^"([^"]+)","(\d+)"/)).filter(Boolean).map(m => Number(m[2]));
  } catch {}
  if (!pids.length) return null;

  let netstat = '';
  try { netstat = execFileSync('netstat', ['-ano'], {encoding: 'utf8'}); } catch { return null; }
  const ports = [];
  for (const line of netstat.split('\n')) {
    const m = line.trim().match(/^TCP\s+(127\.0\.0\.1|0\.0\.0\.0):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
    if (m && pids.includes(Number(m[3]))) ports.push(Number(m[2]));
  }
  const base = ports.length ? 'http://127.0.0.1:' + ports[0] : null;
  if (base) {
    await mkdir(path.join(DATA, 'collab'), {recursive: true});
    await writeFile(cache, JSON.stringify({base, at: Date.now()}));
  }
  return base;
}

async function deepseekQuota() {
  const base = await dshBase();
  if (!base) return {status: 'unknown', note: '未发现 DeepSeek Harness 端口'};
  try {
    const res = await fetch(base + '/plugin/balance-chip4/state', {signal: AbortSignal.timeout(15000)});
    const j = await res.json();
    const value = j?.result?.value;
    if (!Array.isArray(value) || !value.length) return {status: 'unknown', note: '余额接口没有返回钱包数据'};
    const wallet = value[0];
    return {
      status: 'ok',
      currency: wallet.currency,
      balance: Number(wallet.balance),
      source: 'dsh-account',
      checkedAt: Date.now(),
    };
  } catch (e) {
    return {status: 'error', note: e.message};
  }
}

async function codexQuota() {
  // 后端上线后优先用 /api/quota；否则读 codex 侧写的快照，并自行判断过期。
  try {
    const j = await api('/api/quota');
    if (j?.codex) return j.codex;
  } catch {}
  try {
    const j = JSON.parse((await readFile(path.join(DATA, 'quota', 'codex.json'), 'utf8')).replace(/^\uFEFF/, ''));
    const now = Date.now();
    const checkedAt = Number(j.checkedAt) || 0;
    let resetAt = j.resetAt ? Number(j.resetAt) : null;
    if (resetAt && resetAt < 1e12) resetAt *= 1000;
    const expired = (checkedAt && now - checkedAt > 10 * 60 * 1000) || (resetAt && now > resetAt);
    return {...j, resetAt, status: expired ? 'stale' : (j.status || 'ok'), source: j.source || 'codex-snapshot'};
  } catch {}
  return {status: 'unknown', note: 'Codex 未提供额度快照（等后端 /api/quota 或 data/quota/codex.json）'};
}

async function quota() {
  const [ds, cx] = await Promise.all([deepseekQuota(), codexQuota()]);
  const payload = {deepseek: ds, codex: cx, checkedAt: Date.now()};
  if (has('json')) return console.log(JSON.stringify(payload, null, 2));

  console.log('额度');
  if (ds.status === 'ok') console.log(`  DeepSeek  余额 ${ds.balance} ${ds.currency}（${ago(ds.checkedAt)}）`);
  else console.log(`  DeepSeek  ${ds.status}${ds.note ? '：' + ds.note : ''}`);
  if (cx.status === 'ok' || cx.status === 'stale') {
    const pct = cx.remainingPercent ?? (cx.usedPercent != null ? 100 - cx.usedPercent : null);
    const label = pct != null ? '剩余 ' + pct + '%' : '已用 ' + cx.usedPercent + '%';
    console.log(`  Codex     ${label}（${cx.window || '5h'}，${ago(cx.checkedAt)}${cx.status === 'stale' ? '，快照已过期' : ''}）`);
  } else {
    console.log(`  Codex     ${cx.status}${cx.note ? '：' + cx.note : ''}`);
  }
}

/* ---------------- mail ---------------- */

async function mailLog() {
  try { return JSON.parse(await readFile(path.join(DATA, 'collab', 'mail-sent.json'), 'utf8')); } catch { return []; }
}
async function saveMailLog(list) {
  await mkdir(path.join(DATA, 'collab'), {recursive: true});
  await writeFile(path.join(DATA, 'collab', 'mail-sent.json'), JSON.stringify(list.slice(-100), null, 2));
}

async function mail() {
  const key = await readKey('mail.key');
  if (!key) throw new Error('缺少 data/mail.key（本机邮件 API 密钥）');
  let cfg = {};
  try { cfg = JSON.parse((await readFile(path.join(DATA, 'mail.json'), 'utf8')).replace(/^\uFEFF/, '')); } catch {}
  const endpoint = process.env.RELAY_MAIL_ENDPOINT || cfg.endpoint;
  if (!endpoint) {
    throw new Error('未配置邮件服务地址：在 data/mail.json 写 {"endpoint":"https://…/v1/send","to":["…"]}，或设置 RELAY_MAIL_ENDPOINT');
  }
  let to = flag('to') || cfg.to;
  if (!to) throw new Error('未配置收件人：用 --to a@b.com 或写 data/mail.json {"to":["…"]}');
  const subject = flag('subject');
  const text = flag('text') || positional().join(' ');
  if (!subject || !text) throw new Error('需要 --subject 和 --text');

  const fp = createHash('sha256').update(subject + '\n' + text).digest('hex').slice(0, 16);
  const log = await mailLog();
  const recent = log.find(x => x.fp === fp && Date.now() - x.at < 10 * 60 * 1000);
  if (recent && !has('force')) {
    console.log(`10 分钟内已发过同一封（${new Date(recent.at).toLocaleTimeString('zh-CN')}，状态 ${recent.status}），跳过。要强制重发加 --force。`);
    return;
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {authorization: 'Bearer ' + key, 'content-type': 'application/json'},
      body: JSON.stringify({to: Array.isArray(to) ? to : [to], subject, text}),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`邮件发送失败 HTTP ${res.status}：${body.slice(0, 200)}`);
    log.push({fp, at: Date.now(), status: 'accepted', subject});
    await saveMailLog(log);
    console.log(body);
  } catch (e) {
    if (/abort|timeout|timed out/i.test(String(e.name) + ' ' + e.message)) {
      log.push({fp, at: Date.now(), status: 'unknown', subject});
      await saveMailLog(log);
      console.log('结果未知（超时）：邮件可能已经发出。先去收件箱确认，不要直接重发；确需重发用 --force。');
      return;
    }
    throw e;
  }
}

/* ---------------- protocol ready ---------------- */

async function ready() {
  const side = sideOf(flag('as'));
  const {st, room} = await resolveRoom(typeof flag('room') === 'string' ? flag('room') : null, {required: true});
  const sessionId = (typeof flag('session') === 'string' && flag('session')) || room?.[side === 'codex' ? 'codexId' : 'deepseekId'];
  const version = (typeof flag('version') === 'string' && flag('version')) || '1.0.0';
  if (!sessionId) throw new Error('缺少会话 ID：该话题尚未绑定 ' + side + '，或先用 --session 指定');
  if (!room) throw new Error('缺少话题 ID：用 --room 指定');
  const res = await api('/api/protocol/ready', {side, sessionId, version, roomId: room.id});
  console.log(JSON.stringify(res));
}

async function capability() {
  const side = sideOf(flag('as'));
  const {room} = await resolveRoom(typeof flag('room') === 'string' ? flag('room') : null, {required: true});
  if (!room) throw new Error('缺少话题 ID：用 --room 指定');
  const sessionId = (typeof flag('session') === 'string' && flag('session')) || room?.[side === 'codex' ? 'codexId' : 'deepseekId'];
  if (!sessionId) throw new Error('该话题尚未绑定 ' + side + '；绑定后再声明');
  const raw = flag('supports');
  const supportsImages = raw === undefined ? true : raw === 'true' || raw === '1';
  const res = await api('/api/capabilities/image', {roomId: room.id, side, sessionId, supportsImages});
  console.log('已声明 ' + side + '（会话 ' + sessionId + '）图片能力 = ' + supportsImages + (res?.imageMode ? ' · ' + res.imageMode : ''));
}

/* ---------------- main ---------------- */

const HELP = `relay-cli — 中转台补充通道

  status                      两边健康、队列、最后消息
  inbox --as <side> [--peek]  读取自己没收到的消息（默认推进游标）
  send --as <side> --to <peer> "文本"   需要新后端（message-attribution-v1）
  quota [--json]              查询 DeepSeek / Codex 额度
  ready --as <side> [--version 1.0.0]   声明已加载协作协议版本
  capability --as <side> --room <话题> [--supports true|false]   声明图片能力
  mail --subject "…" --text "…" [--to a@b.com]

side ∈ codex | deepseek
`;

try {
  if (!cmd || cmd === 'help' || has('help')) console.log(HELP);
  else if (cmd === 'status') await status(has('json'));
  else if (cmd === 'inbox') await inbox();
  else if (cmd === 'send') await send();
  else if (cmd === 'quota') await quota();
  else if (cmd === 'ready') await ready();
else if (cmd === 'capability') await capability();
  else if (cmd === 'mail') await mail();
  else { console.error('未知命令：' + cmd); console.log(HELP); process.exitCode = 1; }
} catch (e) {
  console.error('错误：' + e.message);
  process.exitCode = 1;
}
