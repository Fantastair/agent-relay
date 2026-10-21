/* 中转台前端：房间化气泡式群聊视图（原生 ES module，无依赖，无内联样式） */

const $ = (id) => document.getElementById(id);

const NAMES = {user: '你', codex: 'Codex', deepseek: 'DeepSeek'};
const INITIALS = {user: '你', codex: 'C', deepseek: 'D'};
const STATUS_LABEL = {
  queued: '排队', sending: '递送中', running: '执行中', completed: '已送达',
  failed: '失败', unknown: '待回查', blocked: '待处理', cancelled: '已取消',
};
const STATE_LABEL = {
  idle: '空闲', running: '工作中', offline: '离线', unbound: '未绑定', notLoaded: '待恢复',
};

const S = {
  state: null,
  catalog: null,
  roomId: null,
  rooms: [],
  messages: [],
  deliveries: [],
  synthetic: true,
  readOnly: false,
  activeRoomId: null,
  sending: false,
  attachments: [],
  quota: null,
  polling: false,
  signature: '',
  expanded: new Set(),
  atBottom: true,
  unseen: 0,
  archivedOpen: false,
  lastRead: readLastRead(),
};

function readLastRead() {
  try { return JSON.parse(localStorage.getItem('relay.lastRead') || '{}'); } catch { return {}; }
}
function markRead(roomId) {
  if (!roomId) return;
  S.lastRead[roomId] = Date.now();
  try { localStorage.setItem('relay.lastRead', JSON.stringify(S.lastRead)); } catch {}
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

async function api(path, body) {
  const r = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : {'content-type': 'application/json', 'x-relay-ui': '1'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = {};
  try { payload = await r.json(); } catch {}
  if (!r.ok) throw new Error(payload.error || '请求失败（' + r.status + '）');
  return payload;
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5200);
}

function clock(ms) {
  return new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai'}).format(ms);
}
function dayLabel(ms) {
  const d = new Date(ms), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return '今天';
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return new Intl.DateTimeFormat('zh-CN', {month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai'}).format(ms);
}
function dayKey(ms) { const d = new Date(ms); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

/* ---------------- rich text ---------------- */

function codeBlock(text) {
  const pre = el('pre');
  pre.append(el('code', null, text));
  return pre;
}

function inlineNodes(host, text) {
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>"'`）)\]，。、；：！？…“”‘’《》【】〔〕]+|\*[^\s*][^*\n]*[^\s*]\*)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) host.append(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('`')) {
      host.append(el('code', null, tok.slice(1, -1)));
    } else if (tok.startsWith('**')) {
      host.append(el('strong', null, tok.slice(2, -2)));
    } else if (tok.startsWith('~~')) {
      host.append(el('del', null, tok.slice(2, -2)));
    } else if (tok.startsWith('[')) {
      const parts = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      host.append(parts ? linkNode(parts[1], parts[2]) : document.createTextNode(tok));
    } else if (/^https?:/i.test(tok)) {
      // 裸 URL 末尾若跟英文标点，剥出去按正文处理，避免把句子标点吞进链接。
      const tailMatch = tok.match(/^([\s\S]*?)([.,;:!?]+)$/);
      const href = tailMatch ? tailMatch[1] : tok;
      const tail = tailMatch ? tailMatch[2] : '';
      const a = el('a', null, href);
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      host.append(a);
      if (tail) host.append(document.createTextNode(tail));
    } else if (tok.startsWith('*')) {
      host.append(el('em', null, tok.slice(1, -1)));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) host.append(document.createTextNode(text.slice(last)));
}

function linkNode(label, href) {
  if (/^https?:\/\//i.test(href)) {
    const a = el('a', null, label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }
  // 本地路径无法从网页直接打开，改为点击复制，避免点了没反应。
  const b = el('button', 'path-link', label);
  b.type = 'button';
  b.title = href;
  b.onclick = () => {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = href;
      ta.setAttribute('readonly', '');
      ta.className = 'copy-helper';
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      toast(ok ? '路径已复制：' + href : href);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(href).then(() => toast('路径已复制：' + href), fallback);
    } else {
      fallback();
    }
  };
  return b;
}

function prose(host, text) {
  const lines = text.split('\n');
  let listEl = null, listType = '';
  const closeList = () => { listEl = null; listType = ''; };
  const ensureList = (type) => {
    if (listEl && listType === type) return listEl;
    const l = el(type === 'ol' ? 'ol' : 'ul', 'md-list');
    host.append(l);
    listEl = l;
    listType = type;
    return l;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      closeList();
      host.append(el('br'));
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      host.append(el('div', 'md-h md-h' + heading[1].length, heading[2].trim()));
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      closeList();
      host.append(el('hr', 'md-rule'));
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      const bq = el('blockquote', 'md-quote');
      inlineNodes(bq, quote[1]);
      host.append(bq);
      continue;
    }
    const item = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
    if (item) {
      const type = /\d/.test(item[1]) ? 'ol' : 'ul';
      const li = el('li');
      inlineNodes(li, item[2]);
      ensureList(type).append(li);
      continue;
    }
    // 表格：首行是表头，第二行是 |---| 分隔
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
      const rows = [];
      let j = i;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { rows.push(lines[j]); j++; }
      if (rows.length >= 2) {
        closeList();
        host.append(tableNode(rows));
        i = j - 1;
        continue;
      }
    }
    closeList();
    inlineNodes(host, line);
    if (i < lines.length - 1) host.append(el('br'));
  }
}

function tableNode(rows) {
  const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
  const header = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  const table = el('table', 'md-table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const h of header) {
    const th = el('th');
    inlineNodes(th, h);
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);
  if (body.length) {
    const tbody = el('tbody');
    for (const row of body) {
      const tr = el('tr');
      for (let c = 0; c < header.length; c++) {
        const td = el('td');
        inlineNodes(td, row[c] || '');
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
  }
  const wrap = el('div', 'md-table-wrap');
  wrap.append(table);
  return wrap;
}

function renderRich(text, host) {
  const segs = String(text ?? '').split(/```/);
  segs.forEach((seg, i) => {
    if (i % 2 === 1) {
      const body = seg.replace(/^[a-zA-Z0-9_+-]*\n/, '');
      host.append(codeBlock(body.replace(/\n$/, '')));
    } else if (seg.trim()) {
      if (i > 0) host.append(el('br'));
      prose(host, seg);
    }
  });
}

/* ---------------- state ---------------- */

function synthRooms(st) {
  const list = st.messages || [];
  const last = list[list.length - 1];
  const createdAt = list[0]?.createdAt || Date.now();
  return [{
    id: 'local', title: '本地协作', kind: 'legacy',
    createdAt, lastAt: last?.createdAt || createdAt,
    messageCount: list.length, archived: false, synthetic: true,
  }];
}

function applyState(st) {
  S.state = st;
  const hasRooms = Array.isArray(st.rooms) && st.rooms.length > 0;
  S.synthetic = !hasRooms;
  S.rooms = hasRooms ? st.rooms : synthRooms(st);

  const preferred = S.roomId || st.settings?.roomId;
  S.roomId = S.rooms.some(r => r.id === preferred) ? preferred : S.rooms[0].id;

  S.messages = (st.messages || []).filter(m => !m.roomId || m.roomId === S.roomId);
  S.deliveries = (st.deliveries || []).filter(d => !d.roomId || d.roomId === S.roomId);
  S.readOnly = !!st.readOnly;
  S.activeRoomId = st.activeRoomId || st.settings?.activeRoomId || st.settings?.roomId || S.rooms[0]?.id;

  const sig = JSON.stringify([
    S.roomId,
    S.readOnly,
    S.activeRoomId,
    S.messages.map(m => m.id),
    S.deliveries.map(d => d.id + ':' + d.status),
    st.settings?.paused, st.settings?.mode,
  ]);

  renderChrome();
  if (sig !== S.signature) {
    S.signature = sig;
    renderTimeline();
  }
  renderJobs();
  renderLogs();
}

/* ---------------- chrome ---------------- */

function currentRoom() {
  return S.rooms.find(r => r.id === S.roomId) || S.rooms[0];
}

function renderChrome() {
  const st = S.state;
  const room = currentRoom();
  const connected = !!(st?.settings?.codexId && st?.settings?.deepseekId);

  document.title = room ? room.title + ' · 中转台' : '中转台';
  $('room-title').textContent = room?.title || '本地协作';
  $('new-room').hidden = S.synthetic;

  const health = st?.health || {};
  const hc = ['codex', 'deepseek'].map(side => {
    const h = health[side] || {};
    if (!st?.settings?.[side + 'Id']) return NAMES[side] + ' 未绑定';
    if (h.state === 'running') return NAMES[side] + ' 工作中';
    if (h.state === 'offline') return NAMES[side] + ' 离线';
    return NAMES[side] + ' 就绪';
  });
  $('room-sub').textContent = connected
    ? S.messages.length + ' 条消息 · ' + hc.join(' · ')
    : '一条消息，同时送达两个 Agent';

  const paused = !!st?.settings?.paused;
  $('pause').textContent = paused ? '开始投递' : '暂停投递';

  const mode = st?.settings?.mode || 'auto';
  $('mode').value = mode;
  $('budget').value = String(st?.settings?.maxTurns ?? 6);
  $('dialog-mode').value = mode;
  $('dialog-budget').value = String(st?.settings?.maxTurns ?? 6);

  $('compose-note').textContent = !connected
    ? '先连接两个原生会话，再发送消息。'
    : paused
      ? '当前暂停投递：消息会保存并排队，点击「开始投递」后发出。'
      : '默认同时发送，两边各自保存原生对话记录。';

  const banner = $('banner');
  if (!connected) {
    banner.hidden = false;
    banner.textContent = '还没有连接两个原生会话。打开「连接与设置」指定会话，或新建一对专用会话。';
  } else if (paused) {
    banner.hidden = false;
    banner.textContent = '投递已暂停。消息仍会保存和排队，已开始的原生任务继续执行。';
  } else {
    banner.hidden = true;
  }

  renderRooms();
  renderConnections();
  renderReadonly();
}

function renderReadonly() {
  const bar = $('readonly-bar');
  bar.hidden = !S.readOnly;
  const input = $('message');
  const send = $('send');
  const target = $('target');
  if (!S.readOnly) {
    input.disabled = false;
    target.disabled = false;
    input.placeholder = '描述任务或补充要求，这条消息默认发送给 Codex 和 DeepSeek…';
    send.disabled = !!S.sending;
    return;
  }
  const active = S.rooms.find(r => r.id === S.activeRoomId);
  $('readonly-text').textContent = '浏览历史话题，只读。当前投递在「' + (active?.title || '当前话题') + '」。';
  input.disabled = true;
  target.disabled = true;
  input.placeholder = '历史话题只读；点「继续此话题」恢复发送。';
  send.disabled = true;
}

function renderRooms() {
  const nav = $('rooms');
  const scrollTop = nav.scrollTop;
  const active = S.rooms.filter(r => !r.archived);
  const archived = S.rooms.filter(r => r.archived);
  const frag = document.createDocumentFragment();
  active.forEach(r => frag.append(roomItem(r)));
  if (archived.length) {
    const box = el('details', 'rooms-archived');
    box.open = !!S.archivedOpen;
    box.addEventListener('toggle', () => { S.archivedOpen = box.open; });
    box.append(el('summary', null, '已归档 · ' + archived.length));
    archived.forEach(r => box.append(roomItem(r)));
    frag.append(box);
  }
  if (!active.length && !archived.length) frag.append(el('p', 'no-jobs', '还没有话题。'));
  nav.replaceChildren(frag);
  nav.scrollTop = scrollTop;
}

function roomItem(room) {
  const item = el('div', 'room-item' + (room.id === S.roomId ? ' active' : ''));
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.setAttribute('aria-current', room.id === S.roomId ? 'true' : 'false');

  const name = el('span', 'room-name', room.title || '未命名话题');
  const meta = el('span', 'room-meta');
  meta.append(el('span', null, room.lastAt ? clock(room.lastAt) : '新'));
  meta.append(el('span', null, '·'));
  meta.append(el('span', null, (room.messageCount ?? 0) + ' 条'));
  if (room.id === S.activeRoomId) meta.append(el('span', 'chip ok', '当前'));
  if (!room.archived && room.id !== S.roomId && room.lastAt && room.lastAt > (S.lastRead[room.id] || 0)) {
    meta.append(el('span', 'unread', '新'));
  }
  item.append(name, meta);

  if (!S.synthetic) {
    const tools = el('div', 'room-tools');
    const rename = el('button', 'icon-btn', '✎');
    rename.title = '重命名';
    rename.setAttribute('aria-label', '重命名话题');
    rename.onclick = (e) => { e.stopPropagation(); renameRoom(room); };
    const arch = el('button', 'icon-btn', room.archived ? '⟲' : '⌫');
    arch.title = room.archived ? '取消归档' : room.id === S.activeRoomId ? '当前投递房间不能归档' : '归档';
    arch.setAttribute('aria-label', arch.title);
    arch.disabled = !room.archived && room.id === S.activeRoomId;
    arch.onclick = (e) => { e.stopPropagation(); toggleArchive(room); };
    tools.append(rename, arch);
    item.append(tools);
  }

  const open = () => { if (room.id !== S.roomId) selectRoom(room.id); };
  item.onclick = open;
  item.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  return item;
}

function renderConnections() {
  const health = S.state?.health || {};
  const box = $('connections');
  box.replaceChildren(...['codex', 'deepseek'].map(side => {
    const h = health[side] || {};
    const card = el('div', 'conn ' + side);
    const head = el('div', 'conn-head');
    head.append(el('span', null, NAMES[side]));
    const label = STATE_LABEL[h.state] || h.state || '未连接';
    const state = el('span', 'conn-state ' + (h.ok ? 'ok' : h.state === 'offline' ? 'bad' : ''), label);
    head.append(state);
    card.append(head);
    card.append(el('small', 'conn-sub', h.title || '尚未连接专用会话'));
    const quota = quotaLine(side);
    if (quota) {
      const line = el('small', 'conn-sub conn-quota' + (quota.low ? ' low' : ''), quota.text);
      if (quota.title) line.title = quota.title;
      card.append(line);
    }
    if (h.error) card.append(el('small', 'conn-sub err', h.error));
    return card;
  }));
}

/* ---------------- timeline ---------------- */

function renderTimeline() {
  const view = $('timeline');
  const prevBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 90;
  const prevScroll = view.scrollTop;

  if (!S.messages.length) {
    const connected = !!(S.state?.settings?.codexId && S.state?.settings?.deepseekId);
    const empty = el('div', 'empty');
    empty.append(el('div', 'empty-symbol', '⇄'));
    empty.append(el('h2', null, connected ? '这个话题还没有消息' : '把任务放到同一个对话里'));
    const p = el('p');
    if (connected) {
      p.append(document.createTextNode('在下方输入任务，消息会同时发给 Codex 和 DeepSeek。'));
    } else {
      p.append(document.createTextNode('连接两边的原生会话，然后在下方发送消息。'));
      p.append(el('br'));
      p.append(document.createTextNode('你可以随时插话，或暂停后续投递。'));
    }
    empty.append(p);
    const btn = el('button', 'btn', connected ? '写第一条消息' : '连接会话');
    btn.onclick = () => {
      if (connected) $('message').focus();
      else void openSettings();
    };
    empty.append(btn);
    view.replaceChildren(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  let prev = null, prevDay = null;
  const visible = S.messages.filter(m => !(m.meta?.silent || /^\s*\[relay-(?:silent|no-reply)\]\s*$/.test(m.text || '')));
  visible.forEach((m, i) => {
    const key = dayKey(m.createdAt);
    let dayBreak = false;
    if (key !== prevDay) {
      const sep = el('div', 'day-sep');
      sep.append(el('span', null, dayLabel(m.createdAt)));
      frag.append(sep);
      prevDay = key;
      prev = null;
      dayBreak = true;
    }
    const row = messageNode(m, prev, i);
    if (dayBreak) row.classList.remove('new-turn');
    frag.append(row);
    prev = m;
  });
  view.replaceChildren(frag);

  if (prevBottom) {
    view.scrollTop = view.scrollHeight;
    S.unseen = 0;
    markRead(S.roomId);
    $('jump-latest').hidden = true;
    S.atBottom = true;
  } else {
    view.scrollTop = prevScroll;
    S.atBottom = false;
    const grew = view.scrollHeight - prevScroll - view.clientHeight > 90;
    if (grew) {
      S.unseen += 1;
      const j = $('jump-latest');
      j.hidden = false;
      j.textContent = '↓ 回到最新' + (S.unseen > 1 ? ' · ' + S.unseen : '');
    }
  }
}

function avatarNode(sender) {
  const box = el('div', 'avatar avatar--' + sender, INITIALS[sender] || '?');
  let src = null;
  try { src = localStorage.getItem('relay.avatar.' + sender); } catch {}
  if (src) {
    const img = el('img');
    img.src = src;
    img.alt = '';
    box.replaceChildren(img);
    box.classList.add('has-img');
  }
  return box;
}

function messageNode(m, prev, index) {
  const mine = m.sender === 'user';
  const cont = !!prev && prev.sender === m.sender;
  const newTurn = !prev || prev.rootId !== m.rootId;

  const row = el('div', 'msg msg--' + m.sender);
  if (cont) row.classList.add('cont');
  if (newTurn && index > 0) row.classList.add('new-turn');
  if (index === 0) row.classList.add('first');
  row.dataset.id = m.id;

  row.append(avatarNode(m.sender));
  const main = el('div', 'msg-main');

  if (!cont) {
    const head = el('div', 'msg-head');
    head.append(el('span', 'name', NAMES[m.sender] || m.sender));
    head.append(el('time', null, clock(m.createdAt)));
    if (m.meta?.native) head.append(el('span', 'chip', '原生'));
    if (m.meta?.stop) head.append(el('span', 'chip info', '已收束'));
    if (m.meta?.wait) head.append(el('span', 'chip warn', '等待你回答'));
    if (Array.isArray(m.meta?.inReplyToMessageIds) && m.meta.inReplyToMessageIds.length > 1) {
      head.append(el('span', 'chip info', '回应 ' + m.meta.inReplyToMessageIds.length + ' 条'));
    }
    for (const chip of deliveryChips(m)) head.append(chip);
    main.append(head);
  }

  const bubble = el('div', 'bubble');
  renderRich(m.text, bubble);
  const images = Array.isArray(m.meta?.images) ? m.meta.images : (m.meta?.image ? [m.meta.image] : []);
  if (images.length) {
    const gallery = el('div', 'md-images');
    for (const img of images.slice(0, 4)) {
      const src = img.url || ('/api/image/' + img.id);
      const a = el('a');
      a.href = src;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const im = el('img');
      im.src = src;
      im.alt = '图片';
      im.loading = 'lazy';
      a.append(im);
      gallery.append(a);
    }
    bubble.append(gallery);
  }
  const long = (m.text || '').length > 700 || (m.text || '').split('\n').length > 14;
  if (long && !S.expanded.has(m.id)) bubble.classList.add('is-clamped');
  main.append(bubble);

  if (long && !S.expanded.has(m.id)) {
    const btn = el('button', 'btn ghost expand', '展开全文');
    btn.onclick = () => {
      S.expanded.add(m.id);
      bubble.classList.remove('is-clamped');
      btn.remove();
    };
    main.append(btn);
  }

  if (m.sender !== 'user') main.append(actions(m, mine));
  row.append(main);
  return row;
}

function deliveryChips(m) {
  const mine = S.deliveries.filter(d => d.messageId === m.id && d.status !== 'cancelled');
  return mine.map(d => {
    const tone = d.status === 'completed' ? 'ok'
      : d.status === 'failed' || d.status === 'blocked' ? 'bad'
      : d.status === 'unknown' ? 'warn' : 'info';
    const batchCount = d.batchId ? S.deliveries.filter(x => x.batchId === d.batchId).length : 0;
    const label = batchCount > 1 ? '批次 ' + batchCount + ' 条 · ' : '';
    const text = NAMES[d.side] + ' ' + label + (STATUS_LABEL[d.status] || d.status);
    return el('span', 'chip ' + tone, text);
  });
}

function actions(m) {
  const box = el('div', 'msg-actions');
  const copy = el('button', null, '复制');
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(m.text); toast('已复制'); }
    catch { toast('复制失败，请手动选择文本'); }
  };
  box.append(copy);

  if (m.sender !== 'user') {
    const other = m.sender === 'codex' ? 'deepseek' : 'codex';
    const sent = S.deliveries.some(d => d.messageId === m.id && d.side === other && d.status !== 'cancelled');
    const fwd = el('button', null, sent ? '已转给 ' + NAMES[other] : '转给 ' + NAMES[other]);
    fwd.disabled = sent || S.readOnly || !S.state?.settings?.[other + 'Id'];
    fwd.onclick = async () => {
      try { await api('forward', {messageId: m.id, side: other}); await refresh(); }
      catch (e) { toast(e.message); }
    };
    box.append(fwd);
  }
  return box;
}

function quotaLine(side) {
  const q = S.quota;
  if (!q) return null;
  if (q.error) return {text: '额度未知', title: '额度查询失败：' + (q.error === 'unavailable' ? '接口不可用（旧后端）' : String(q.error))};
  const expired = (item) => item.status === 'stale' || q.staleNetwork;
  if (side === 'deepseek') {
    const d = q.deepseek;
    if (!d) return {text: '额度未知', title: '后端未返回 DeepSeek 余额'};
    if ((d.status === 'ok' || d.status === 'stale') && d.balance != null) {
      const balance = Number(d.balance);
      let text = '余额 ' + balance.toFixed(2) + ' ' + (d.currency || 'CNY');
      if (expired(d)) text += '（过期）';
      const title = (d.checkedAt ? '更新于 ' + clock(d.checkedAt) : '') + (d.note ? ' · ' + d.note : '');
      return {text, title, low: balance < 2};
    }
    return {text: '额度未知', title: d.note || ''};
  }
  const c = q.codex;
  if (!c) return {text: '额度未知', title: '后端未返回 Codex 额度'};
  if (c.status === 'ok' || c.status === 'stale') {
    const pct = c.remainingPercent ?? (c.usedPercent != null ? 100 - c.usedPercent : null);
    let text = pct != null ? '剩余 ' + pct + '%' : '已用 ' + c.usedPercent + '%';
    if (c.resetAt) {
      const reset = new Date(c.resetAt < 1e12 ? c.resetAt * 1000 : c.resetAt);
      text += ' · ' + new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai'}).format(reset) + ' 重置';
    }
    if (expired(c)) text += '（过期）';
    return {text, title: c.checkedAt ? '更新于 ' + clock(c.checkedAt) : '', low: pct != null && pct < 15};
  }
  return {text: '额度未知', title: c.note || ''};
}

async function refreshQuota() {
  try {
    const next = await api('quota');
    S.quota = {...next, staleNetwork: false};
  } catch {
    // 查询失败时保留上一次结果，只标过期；没有旧值才显示未知。
    if (S.quota && !S.quota.error) S.quota = {...S.quota, staleNetwork: true};
    else S.quota = {error: 'unavailable'};
  }
  renderConnections();
}

/* ---------------- activity ---------------- */

function renderJobs() {
  const active = S.deliveries.filter(d => !['completed', 'cancelled'].includes(d.status));
  $('queue-count').textContent = String(active.length);
  if (!active.length) {
    $('jobs').replaceChildren(el('p', 'no-jobs', '没有待投递消息。'));
    return;
  }
  const frag = document.createDocumentFragment();
  const groups = [];
  const byBatch = new Map();
  for (const d of active.slice().reverse()) {
    const key = d.batchId || d.id;
    if (!byBatch.has(key)) {
      const group = {id: key, items: []};
      byBatch.set(key, group);
      groups.push(group);
    }
    byBatch.get(key).items.push(d);
  }
  for (const group of groups) {
    const d = group.items[0];
    const job = el('div', 'job');
    const head = el('div', 'job-head');
    head.append(el('strong', null, NAMES[d.side] + (group.items.length > 1 ? ' · 合并 ' + group.items.length + ' 条' : '')));
    head.append(el('span', 'job-state ' + d.status, STATUS_LABEL[d.status] || d.status));
    job.append(head);
    for (const item of group.items.slice(0, 4)) {
      const msg = S.messages.find(m => m.id === item.messageId);
      job.append(el('p', 'job-text', msg?.text || item.messageId));
    }
    if (d.error) job.append(el('p', 'job-err', d.error));

    const acts = el('div', 'job-actions');
    const count = group.items.length;
    const allQueued = group.items.every(i => i.status === 'queued');
    const allFailed = group.items.every(i => ['failed', 'blocked'].includes(i.status)) && group.items.every(i => !i.receipt);
    const anyUncertain = group.items.some(i => ['unknown', 'blocked', 'failed'].includes(i.status));

    if (allQueued) {
      const b = el('button', null, count > 1 ? '取消整批（' + count + ' 条）' : '取消');
      b.onclick = () => act(async () => { await api('cancel', {deliveryId: d.id}); await refresh(); });
      acts.append(b);
    }
    if (allFailed) {
      const b = el('button', null, count > 1 ? '重试整批（' + count + ' 条）' : '重试');
      b.onclick = () => act(async () => { await api('retry', {deliveryId: d.id}); await refresh(); });
      acts.append(b);
    }
    if (anyUncertain) {
      const b = el('button', null, count > 1 ? '处理整批（' + count + ' 条）' : '回查后处理');
      b.onclick = () => act(async () => {
        const retry = confirm('请先在原生会话里回查' + (count > 1 ? '这 ' + count + ' 条（整批）' : '这条消息') + '。\n\n确定：确认未送达，重新排队（保持暂停）。\n取消：不重发，继续选择其他处理。');
        if (retry) {
          await api('resolve', {deliveryId: d.id, decision: 'not-delivered', confirmed: true});
        } else if (confirm('是否已在原应用处理完毕，只解除整批的等待？这不会终止原任务。')) {
          await api('resolve', {deliveryId: d.id, decision: 'handled', confirmed: true});
        }
        await refresh();
      });
      acts.append(b);
    }
    if (acts.childElementCount) job.append(acts);
    frag.append(job);
  }
  $('jobs').replaceChildren(frag);
}

function renderLogs() {
  const logs = S.state?.logs || [];
  $('logs').replaceChildren(...logs.slice(0, 20).map(l => el('div', 'log-line', clock(l.createdAt) + '  ' + l.text)));
}

/* ---------------- actions ---------------- */

async function act(fn) {
  try { return await fn(); }
  catch (e) { toast(e.message); }
}

async function refresh() {
  if (S.polling) return;
  S.polling = true;
  try {
    const qs = (!S.synthetic && S.roomId) ? '?roomId=' + encodeURIComponent(S.roomId) : '';
    applyState(await api('state' + qs));
  } catch {
    const b = $('banner');
    b.hidden = false;
    b.textContent = '中转服务暂时无法连接。消息输入仍保留，请检查本机服务。';
  } finally {
    S.polling = false;
  }
}

async function selectRoom(roomId) {
  if (roomId === S.roomId) return;
  const previous = S.roomId;
  S.roomId = roomId;
  S.expanded.clear();
  S.signature = '';
  markRead(roomId);
  closeDrawers();
  try {
    if (!S.synthetic) await api('rooms/select', {roomId});
  } catch (e) {
    S.roomId = previous;
    S.signature = '';
    toast(e.message);
  }
  await refresh();
}

function renameRoom(room) {
  const title = prompt('话题名称', room.title || '');
  if (title == null) return;
  void act(async () => {
    await api('rooms/update', {roomId: room.id, title: title.trim() || room.title});
    await refresh();
  });
}

function toggleArchive(room) {
  void act(async () => {
    await api('rooms/update', {roomId: room.id, archived: !room.archived});
    if (!room.archived) {
      S.archivedOpen = true;
      if (room.id === S.roomId) {
        const next = S.rooms.find(r => !r.archived && r.id !== room.id);
        if (next) { S.roomId = next.id; S.signature = ''; }
      }
    }
    await refresh();
  });
}

async function newTopic() {
  void act(async () => {
    const res = await api('rooms', {});
    if (res?.room?.id) {
      S.roomId = res.room.id;
      S.signature = '';
      S.expanded.clear();
      if (res.warning) toast(res.warning);
    }
    closeDrawers();
    await refresh();
    toast('已新建话题：只分开中转记录，原生会话仍保留上下文；投递已暂停');
  });
}

function scrollBottom(force) {
  const view = $('timeline');
  view.scrollTop = view.scrollHeight;
  S.atBottom = true;
  S.unseen = 0;
  $('jump-latest').hidden = true;
  markRead(S.roomId);
  if (force) view.scrollTo({top: view.scrollHeight});
}

/* ---------------- drawers ---------------- */

function closeDrawers() {
  document.body.classList.remove('nav-open', 'panel-open');
  $('backdrop').hidden = true;
}
function toggleDrawer(name) {
  const body = document.body;
  const on = body.classList.toggle(name);
  body.classList.toggle('nav-open', name === 'nav-open' && on);
  body.classList.toggle('panel-open', name === 'panel-open' && on);
  $('backdrop').hidden = !(body.classList.contains('nav-open') || body.classList.contains('panel-open'));
}

/* ---------------- settings ---------------- */

let catalogTimer = null;
const SOURCE_LABEL = {codex: 'Codex 会话', deepseek: 'DeepSeek 会话', workspaces: '工作区', projects: '项目'};

function stopCatalogPoll() {
  if (catalogTimer) { clearTimeout(catalogTimer); catalogTimer = null; }
}

async function openSettings() {
  stopCatalogPoll();
  $('settings-dialog').showModal();
  $('setup-status').textContent = '正在读取两边的原生会话…首次读取可能需要二十秒，会先显示已就绪的部分。';
  await loadCatalog();
}

async function loadCatalog() {
  try {
    const cat = await api('catalog?partial=1');
    applyCatalog(cat);
    const loading = Object.entries(cat.sources || {})
      .filter(([, s]) => s && s.loading)
      .map(([key]) => SOURCE_LABEL[key] || key);
    if (cat.refreshing && loading.length) {
      $('setup-status').textContent = '已显示部分结果，正在读取：' + loading.join('、') + '…';
      catalogTimer = setTimeout(() => void loadCatalog(), 1200);
    } else {
      stopCatalogPoll();
      const errs = (cat.errors || []).join('；');
      $('setup-status').textContent = errs || '已读取原生会话。绑定不会转发已有的历史回复。';
    }
  } catch (e) {
    stopCatalogPoll();
    $('setup-status').textContent = e.message;
  }
}

function applyCatalog(cat) {
  S.catalog = cat;
  const keep = {
    codex: $('codex-session').value || S.state?.settings?.codexId || '',
    deepseek: $('deepseek-session').value || S.state?.settings?.deepseekId || '',
    workspace: $('workspace').value || S.state?.settings?.workspaceId || '',
  };
  const groups = [
    ['codex-session', (cat.codex || []).map(r => ({value: r.id, label: (r.title || r.id) + ' · ' + r.id})), keep.codex],
    ['deepseek-session', (cat.deepseek || []).map(r => ({value: r.id, label: (r.title || r.id) + ' · ' + r.id})), keep.deepseek],
    ['workspace', (cat.workspaces || []).map(w => ({value: w.workspaceId, label: w.title + ' — ' + w.path})), keep.workspace],
  ];
  for (const [id, rows, selected] of groups) {
    // 部分结果阶段某一侧还没返回时，保留已有选项，避免把用户的选择清空。
    if (!rows.length && selected) continue;
    fillSelect(id, rows, selected);
  }
}

function fillSelect(id, rows, selected) {
  const select = $(id);
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '请选择';
  blank.selected = !rows.some(r => r.value === selected);
  select.replaceChildren(blank, ...rows.map(r => {
    const o = document.createElement('option');
    o.value = r.value;
    o.textContent = r.label;
    o.selected = r.value === selected;
    return o;
  }));
}

/* ---------------- attachments ---------------- */

const MAX_ATTACH = 4;
const MAX_SIDE = 1600;
const MAX_BYTES = 400 * 1024;

function imageTargets() {
  const target = $('target').value;
  return target === 'both' ? ['codex', 'deepseek'] : [target];
}

function unsupportedImageTargets() {
  return imageTargets().filter(side => S.state?.health?.[side]?.supportsImages !== true);
}

async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  let quality = 0.86, dataUrl = canvas.toDataURL('image/jpeg', quality);
  while (dataUrl.length * 0.75 > MAX_BYTES && quality > 0.45) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  return {dataUrl, w, h};
}

function renderAttachments() {
  const box = $('attachments');
  if (!S.attachments.length) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  const frag = document.createDocumentFragment();
  for (const item of S.attachments) {
    const cell = el('div', 'attachment' + (item.status === 'error' ? ' error' : ''));
    const img = el('img');
    img.src = item.localUrl;
    img.alt = '待发送图片';
    cell.append(img);
    if (item.status !== 'ready') {
      const label = item.status === 'error' ? '失败' : item.status === 'uploading' ? '上传中' : '压缩中';
      cell.append(el('div', 'state', label));
    }
    const remove = el('button', 'remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', '移除图片');
    remove.onclick = () => {
      URL.revokeObjectURL(item.localUrl);
      S.attachments = S.attachments.filter(x => x !== item);
      renderAttachments();
    };
    cell.append(remove);
    frag.append(cell);
  }
  const unsupported = unsupportedImageTargets();
  if (unsupported.length) {
    frag.append(el('div', 'attach-warn', '此会话尚未声明图片能力（' + unsupported.map(s => NAMES[s]).join('、') + '），发送会被拒绝'));
  }
  box.replaceChildren(frag);
}

async function addFiles(fileList) {
  const files = [...fileList].filter(f => f.type.startsWith('image/')).slice(0, MAX_ATTACH - S.attachments.length);
  for (const file of files) {
    const item = {localUrl: URL.createObjectURL(file), status: 'compressing'};
    S.attachments.push(item);
    renderAttachments();
    try {
      const {dataUrl} = await compressImage(file);
      item.status = 'uploading';
      renderAttachments();
      const res = await api('image', {dataUrl});
      item.id = res.image.id;
      item.url = res.image.url || ('/api/image/' + res.image.id);
      item.status = 'ready';
    } catch (e) {
      item.status = 'error';
      item.error = e.message;
      toast('图片上传失败：' + e.message);
    }
    renderAttachments();
  }
}

function clearAttachments() {
  for (const item of S.attachments) URL.revokeObjectURL(item.localUrl);
  S.attachments = [];
  renderAttachments();
}

/* ---------------- events ---------------- */

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  void act(async () => {
    const input = $('message');
    const text = input.value.trim();
    const imageIds = S.attachments.filter(a => a.status === 'ready').map(a => a.id);
    if (!text && !imageIds.length) return;
    if (S.attachments.some(a => a.status === 'compressing' || a.status === 'uploading')) {
      toast('图片还在处理，稍等一下');
      return;
    }
    if (S.attachments.some(a => a.status === 'error')) {
      toast('有图片上传失败，请移除后重试');
      return;
    }
    if (imageIds.length) {
      const unsupported = unsupportedImageTargets();
      if (unsupported.length) {
        toast('这些会话还不支持图片：' + unsupported.map(s => NAMES[s]).join('、') + '；请移除图片或改用文字');
        return;
      }
    }
    const target = $('target').value;
    const targets = target === 'both' ? ['codex', 'deepseek'] : [target];
    $('send').disabled = true;
    S.sending = true;
    try {
      await api('message', {text, targets, roomId: S.roomId, imageIds});
      input.value = '';
      clearAttachments();
      await refresh();
      scrollBottom();
      toast(targets.length === 2 ? '已保存，分别加入两边的队列' : '已加入 ' + NAMES[targets[0]] + ' 的队列');
    } finally {
      S.sending = false;
      $('send').disabled = S.readOnly;
    }
  });
});

$('message').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('pick-image').addEventListener('click', () => $('image-input').click());
$('target').addEventListener('change', () => renderAttachments());
$('image-input').addEventListener('change', (e) => {
  void addFiles(e.target.files);
  e.target.value = '';
});
$('message').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.some(f => f.type.startsWith('image/'))) {
    e.preventDefault();
    void addFiles(files);
  }
});
{
  const box = document.querySelector('.composer-box');
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('dragging'); });
  box.addEventListener('dragleave', () => box.classList.remove('dragging'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('dragging');
    if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
  });
}

$('pause').addEventListener('click', () => void act(async () => {
  await api('options', {paused: !S.state?.settings?.paused});
  await refresh();
}));

$('mode').addEventListener('change', () => void act(async () => {
  await api('options', {mode: $('mode').value});
  await refresh();
}));
$('budget').addEventListener('change', () => void act(async () => {
  await api('options', {maxTurns: Number($('budget').value)});
  await refresh();
}));
$('dialog-mode').addEventListener('change', () => void act(async () => {
  await api('options', {mode: $('dialog-mode').value});
  await refresh();
}));
$('dialog-budget').addEventListener('change', () => void act(async () => {
  await api('options', {maxTurns: Number($('dialog-budget').value)});
  await refresh();
}));

$('export').addEventListener('click', () => {
  const suffix = (!S.synthetic && S.roomId) ? '?roomId=' + encodeURIComponent(S.roomId) : '';
  window.location.href = '/api/export' + suffix;
});

$('jump-latest').addEventListener('click', () => scrollBottom(true));

$('room-title').addEventListener('dblclick', () => {
  const room = currentRoom();
  if (room && !S.synthetic) renameRoom(room);
});

$('new-room').addEventListener('click', () => void newTopic());

$('resume-room').addEventListener('click', () => void act(async () => {
  const res = await api('rooms/activate', {roomId: S.roomId});
  S.roomId = res?.roomId || res?.room?.id || S.roomId;
  S.activeRoomId = S.roomId;
  S.signature = '';
  await refresh();
  toast('已切回此话题，并暂停投递；确认无误后点「开始投递」');
}));

$('back-active').addEventListener('click', () => {
  if (S.activeRoomId && S.activeRoomId !== S.roomId) void selectRoom(S.activeRoomId);
});

$('menu').addEventListener('click', () => toggleDrawer('nav-open'));
$('sidebar-close').addEventListener('click', closeDrawers);
$('activity-toggle').addEventListener('click', () => toggleDrawer('panel-open'));
$('activity-close').addEventListener('click', closeDrawers);
$('backdrop').addEventListener('click', closeDrawers);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.body.classList.contains('nav-open') || document.body.classList.contains('panel-open')) {
    closeDrawers();
  }
});

$('open-settings').addEventListener('click', () => void openSettings());
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('close', stopCatalogPoll);
$('settings-dialog').addEventListener('click', (e) => {
  if (e.target === $('settings-dialog')) {
    const r = e.target.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
  }
});

$('empty-settings')?.addEventListener('click', () => void openSettings());

async function compressAvatar(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 96, 96);
  return canvas.toDataURL('image/jpeg', 0.86);
}

function applyAvatars() {
  S.signature = '';
  renderChrome();
  renderTimeline();
}

for (const input of document.querySelectorAll('input[data-avatar]')) {
  input.addEventListener('change', () => void act(async () => {
    const file = input.files?.[0];
    if (!file) return;
    const dataUrl = await compressAvatar(file);
    localStorage.setItem('relay.avatar.' + input.dataset.avatar, dataUrl);
    applyAvatars();
    toast('头像已更新（仅保存在本机浏览器）');
    input.value = '';
  }));
}

$('reset-avatars')?.addEventListener('click', () => {
  for (const side of ['user', 'codex', 'deepseek']) {
    try { localStorage.removeItem('relay.avatar.' + side); } catch {}
  }
  applyAvatars();
  toast('已恢复默认占位头像');
});

for (const side of ['codex', 'deepseek']) {
  $(side + '-id').addEventListener('input', () => { $(side + '-session').value = ''; });
  $(side + '-session').addEventListener('change', () => { $(side + '-id').value = ''; });
}

$('bind-pair').addEventListener('click', () => void act(async () => {
  $('bind-pair').disabled = true;
  try {
    const codexId = $('codex-id').value.trim() || $('codex-session').value;
    const deepseekId = $('deepseek-id').value.trim() || $('deepseek-session').value;
    await api('bind-pair', {codexId, deepseekId});
    S.roomId = null;
    S.signature = '';
    S.expanded.clear();
    await refresh();
    $('setup-status').textContent = '指定的两个会话已绑定。点击「开始投递」后发送消息；旧历史不会重新转发。';
  } catch (e) {
    $('setup-status').textContent = e.message;
    throw e;
  } finally {
    $('bind-pair').disabled = false;
  }
}));

$('provision').addEventListener('click', () => void act(async () => {
  $('provision').disabled = true;
  $('setup-status').textContent = '正在创建并初始化专用会话，请保持两边应用运行…';
  try {
    await api('provision', {workspaceId: $('workspace').value});
    S.roomId = null;
    S.signature = '';
    S.expanded.clear();
    $('setup-status').textContent = '两边专用会话已连接。关闭设置后点击「开始投递」。';
    await refresh();
    toast('两个专用会话已就绪');
  } catch (e) {
    $('setup-status').textContent = e.message;
    throw e;
  } finally {
    $('provision').disabled = false;
  }
}));

/* ---------------- boot ---------------- */

await refresh();
await refreshQuota();
setInterval(() => void refresh(), 1800);
setInterval(() => void refreshQuota(), 60000);
