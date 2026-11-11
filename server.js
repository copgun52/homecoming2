'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
/* 기록은 DATA_DIR(배포 환경에서는 지워지지 않는 디스크 경로)에 저장해요 */
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA = path.join(DATA_DIR, 'data.json');
const BUILDING_IDS = ['job', 'cert', 'trip', 'rest', 'story', 'soon'];
const MAX_PLAYERS = 100;                 // 동시 접속 최대 인원 (서버 1대)
const KEEP_POSTS = 5000, KEEP_PLEDGES = 1000;   // 서버에 보관하는 최대 개수 (사실상 영구)
const PLEDGE_HOURS = 24;                        // 다짐 등불이 마을에 걸려 있는 시간(지나면 화면에서만 사라지고 기록은 남아요)
const SHOW_POSTS = 100, SHOW_PLEDGES = 60;      // 접속할 때 화면에 보내는 최근 개수
const KEEP_COMMENTS = 300, SHOW_COMMENTS = 30;  // 글 하나당 댓글: 보관 최대 / 화면에 보내는 최근 개수
const W = 1600, H = 1000;                       // 마을 크기(화면과 같아야 해요)
const ADMIN_KEY = process.env.ADMIN_KEY || '';  // 운영자 비밀번호. 없으면 운영자 기능은 꺼져 있어요
const CHAT_KEEP = 5000, CHAT_DAYS = 30;          // 채팅 기록: 최대 개수 / 보관 일수(오래된 것은 자동으로 지워요)
const HIDE_AT = 5;                              // 서로 다른 사람 5명이 신고하면 일단 가려요(운영자가 확인)
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');   // 링크 미리보기에 쓰는 주소(없으면 접속한 주소)

/* ---------- 저장되는 데이터: 등불, 건물별 글 ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { pledges: [], posts: {}, chat: [] };
/* 읽기: 파일이 없으면 새로 시작. 완전히 빈 파일(0바이트)이면 가장 최근의 멀쩡한 백업으로 복구하고, 없으면 새로 시작해요.
   내용은 있는데 깨져 있으면 덮어써서 날리지 않도록 멈춰요. */
const readJson = f => { const t = fs.readFileSync(f, 'utf8'); return t.trim() ? JSON.parse(t) : null; };
try {
  const cur = readJson(DATA);
  if (cur) db = Object.assign(db, cur);
  else {
    console.warn('data.json이 비어 있어요. 백업에서 복구를 시도합니다.');
    const baks = fs.readdirSync(DATA_DIR).filter(f => /^data-.*\.bak\.json$/.test(f)).sort().reverse();
    for (const f of baks) { try { const b = readJson(path.join(DATA_DIR, f)); if (b) { db = Object.assign(db, b); console.warn('백업 ' + f + ' 에서 복구했어요.'); break; } } catch (e) {} }
  }
} catch (e) { if (e.code !== 'ENOENT') { console.error('data.json을 읽지 못했어요(내용이 깨져 있어요). 덮어쓰지 않도록 종료합니다:', e.message); process.exit(1); } }
BUILDING_IDS.forEach(id => { db.posts[id] = db.posts[id] || []; });
/* 글마다 번호(id)와 좋아요 누른 사람 목록(likes)이 있어요. 번호가 없는 예전 글에는 번호를 붙여요. */
db.nextPostId = db.nextPostId || 1;
/* 채팅 기록: { id, t(밀리초), name, text, ip(접속 주소를 해시한 짧은 값) }. 오래된 기록은 정리해요 */
if (!Array.isArray(db.chat)) db.chat = [];
db.nextChatId = db.nextChatId || 1;
const pruneChat = () => { const old = Date.now() - CHAT_DAYS * 86400000; let i = 0; while (i < db.chat.length && db.chat[i].t < old) i++; if (i) db.chat.splice(0, i); if (db.chat.length > CHAT_KEEP) db.chat.splice(0, db.chat.length - CHAT_KEEP); };
pruneChat(); setInterval(pruneChat, 6 * 3600 * 1000).unref();
/* 방문 기록: 누가 들어오고 나갔는지(visits, 30일), 하루별 방문자 수(stats.days), 전체 방문자(stats.total).
   방문자는 브라우저 고유 번호를 해시한 값으로 세요(원래 번호는 저장하지 않아요). 같은 사람이 다른 브라우저로 오면 따로 세어져요. */
if (!Array.isArray(db.visits)) db.visits = [];
db.nextVisitId = db.nextVisitId || 1;
db.stats = db.stats || {}; if (!Array.isArray(db.stats.total)) db.stats.total = []; db.stats.days = db.stats.days || {};
const VISIT_KEEP = 3000, DAYS_KEEP = 400;
const seenAll = new Set(db.stats.total), seenDay = new Map();
const kstDay = t => new Date(t + 9 * 3600000).toISOString().slice(0, 10);
const daySet = d => { if (!seenDay.has(d)) seenDay.set(d, new Set((db.stats.days[d] && db.stats.days[d].v) || [])); return seenDay.get(d); };
function logVisit(ev, p, now, dur) {
  const vk = crypto.createHash('sha256').update('v|' + p.uid).digest('hex').slice(0, 10), d = kstDay(now);
  const day = db.stats.days[d] = db.stats.days[d] || { v: [], n: 0, peak: 0 };
  if (ev === 'in') {
    day.n++; day.peak = Math.max(day.peak || 0, players.size);
    if (!daySet(d).has(vk)) { daySet(d).add(vk); day.v.push(vk); }
    if (!seenAll.has(vk)) { seenAll.add(vk); db.stats.total.push(vk); }
  }
  db.visits.push({ id: db.nextVisitId++, t: now, ev, name: p.name, ip: p.ipk, vk: vk.slice(0, 6), dur: dur || 0 });
  const old = now - 30 * 86400000; while (db.visits.length && (db.visits[0].t < old || db.visits.length > VISIT_KEEP)) db.visits.shift();
  const keys = Object.keys(db.stats.days).sort(); while (keys.length > DAYS_KEEP) { const k = keys.shift(); delete db.stats.days[k]; seenDay.delete(k); }
  save();
}
BUILDING_IDS.forEach(id => db.posts[id].forEach(p => {
  if (!p.id) p.id = db.nextPostId++; if (!Array.isArray(p.likes)) p.likes = []; if (!Array.isArray(p.comments)) p.comments = []; if (!Array.isArray(p.reports)) p.reports = [];
  p.comments.forEach(c => { if (!c.id) c.id = db.nextPostId++; if (!Array.isArray(c.reports)) c.reports = []; });
}));
/* 화면에 보내는 모양: 누가 눌렀는지(uid)는 숨기고, 개수와 "내가 눌렀는지"만 알려줘요. 댓글은 최근 SHOW_COMMENTS개만(전체 개수는 cn) */
const cview = c => ({ id: c.id, name: c.name, text: c.text, date: c.date });
const livePledges = () => { const since = Date.now() - PLEDGE_HOURS * 3600000; return db.pledges.filter(p => p.t && p.t >= since).slice(-SHOW_PLEDGES); };
const view = (p, uid) => { const cs = p.comments.filter(c => !c.hidden);
  return { id: p.id, name: p.name, text: p.text, date: p.date, likes: p.likes.length, liked: !!uid && p.likes.includes(uid),
    comments: cs.slice(-SHOW_COMMENTS).map(cview), cn: cs.length }; };
/* 접속할 때: 최근 글 + 좋아요 많은 2개(오래된 글이어도 인기글은 보여야 하니까) */
function postsFor(id, uid) {
  const all = db.posts[id].filter(p => !p.hidden);
  const top = all.filter(p => p.likes.length > 0).sort((a, b) => b.likes.length - a.likes.length || a.id - b.id).slice(0, 2);
  const picked = new Map(); [...all.slice(-SHOW_POSTS), ...top].forEach(p => picked.set(p.id, p));
  return [...picked.values()].sort((a, b) => a.id - b.id).map(p => view(p, uid));
}

/* 저장은 임시 파일에 쓴 뒤 교체해서, 도중에 꺼져도 기존 파일이 깨지지 않아요. 하루 1번 백업도 남겨요(최근 14개). */
let saveT, lastBackup = '';
function flush() {
  clearTimeout(saveT);
  /* 하루 1번 백업: 새로 덮어쓰기 "전에" 지금 있는 멀쩡한 파일을 복사해요(방금 쓴 파일을 복사하면 같이 망가질 수 있어서) */
  const day = new Date().toISOString().slice(0, 10);
  if (day !== lastBackup) {
    lastBackup = day;
    try {
      if (fs.existsSync(DATA) && fs.statSync(DATA).size > 0) fs.copyFileSync(DATA, path.join(DATA_DIR, 'data-' + day + '.bak.json'));
      fs.readdirSync(DATA_DIR).filter(f => /^data-.*\.bak\.json$/.test(f)).sort().slice(0, -14)
        .forEach(f => fs.unlinkSync(path.join(DATA_DIR, f)));
    } catch (e) {}
  }
  /* 임시 파일에 쓰고 디스크에 완전히 기록(fsync)한 뒤 교체해요. 갑자기 꺼져도 빈 파일이 남지 않게 하려는 거예요. */
  const tmp = DATA + '.tmp', fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(db)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, DATA);
}
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { flush(); } catch (e) { console.error('저장 실패', e.message); } }, 500); };
/* 재배포·종료 신호가 오면 마지막으로 저장하고 꺼져요 */
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { flush(); } catch (e) {} process.exit(0); });

/* ---------- 입력 정리 ---------- */
const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');
const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const color = v => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#6b7f4a');

/* ---------- 도배 방어: 접속한 주소(IP)별 횟수 제한 ---------- */
const hits = new Map();
const count = (key, ms) => { const a = hits.get(key); if (!a) return 0; const t = Date.now() - ms; while (a.length && a[0] <= t) a.shift(); return a.length; };
function hit(key, limit, ms) {          // 허용되면 true(기록), 한도를 넘었으면 false
  if (count(key, ms) >= limit) return false;
  let a = hits.get(key); if (!a) hits.set(key, a = []); a.push(Date.now()); return true;
}
setInterval(() => { const t = Date.now() - 600000; for (const [k, a] of hits) if (!a.length || a[a.length - 1] < t) hits.delete(k); }, 60000);
const ipOf = req => String(req.headers['fly-client-ip'] || req.socket.remoteAddress || '?');   // Fly.io는 진짜 접속자 주소를 fly-client-ip로 알려줘요
const sha = s => crypto.createHash('sha256').update(s).digest();
const ipKey = ip => sha('hv|' + ip).toString('hex').slice(0, 12);   // 주소 자체는 저장하지 않고 짧은 해시만 써요
const TEN_MIN = 600000;

/* ---------- 운영자: 삭제·복구·백업 ---------- */
const findPost = (b, id) => (BUILDING_IDS.includes(b) ? db.posts[b].find(p => p.id === Number(id)) : null);
function adminApi(req, res, ip, url) {
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (!ADMIN_KEY) return json(503, { error: '운영자 기능이 꺼져 있어요(ADMIN_KEY가 설정되지 않았어요)' });
  if (count('admfail:' + ip, TEN_MIN) >= 10) return json(429, { error: '틀린 시도가 많아서 잠시 막았어요. 10분 뒤에 다시 해 주세요' });
  const given = sha(String(req.headers['x-admin-key'] || ''));
  if (!crypto.timingSafeEqual(given, sha(ADMIN_KEY))) { hit('admfail:' + ip, 99, TEN_MIN); return json(401, { error: '비밀번호가 맞지 않아요' }); }

  if (req.method === 'GET' && url === '/api/admin/backup') {
    try { flush(); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="homecoming-backup-' + new Date().toISOString().slice(0, 10) + '.json"' });
    return res.end(JSON.stringify(db));
  }
  if (req.method !== 'POST') return json(405, { error: 'POST만 돼요' });
  let body = '', over = false;
  req.on('data', c => { body += c; if (body.length > 4096) { over = true; req.destroy(); } });
  req.on('end', () => {
    if (over) return;
    let m; try { m = JSON.parse(body || '{}'); } catch (e) { return json(400, { error: '요청이 이상해요' }); }
    if (url === '/api/admin/list') {
      const out = {};
      BUILDING_IDS.forEach(b => {
        out[b] = db.posts[b].slice(-200).map(p => ({ id: p.id, name: p.name, text: p.text, date: p.date, likes: p.likes.length, reports: p.reports.length, hidden: !!p.hidden,
          comments: p.comments.slice(-100).map(c => ({ id: c.id, name: c.name, text: c.text, date: c.date, reports: c.reports.length, hidden: !!c.hidden })) })).reverse();
      });
      const today = kstDay(Date.now()), td = db.stats.days[today] || { v: [], n: 0, peak: 0 };
      const stats = { today: { v: td.v.length, n: td.n, peak: td.peak || 0 }, total: db.stats.total.length, online: [...players.values()].map(p => ({ name: p.name, ip: String(p.ipk).slice(0, 6), since: p.joinedAt })),
        days: Object.keys(db.stats.days).sort().slice(-14).reverse().map(k => ({ d: k, v: db.stats.days[k].v.length, n: db.stats.days[k].n, peak: db.stats.days[k].peak || 0 })),
        visits: db.visits.slice(-200).reverse().map(v => ({ t: v.t, ev: v.ev, name: v.name, ip: String(v.ip).slice(0, 6), vk: v.vk, dur: v.dur })) };
      return json(200, { stats, chat: db.chat.slice(-300).reverse().map(c => ({ id: c.id, t: c.t, name: c.name, text: c.text, ip: String(c.ip || '').slice(0, 6) })), posts: out, pledges: db.pledges.map((p, i) => ({ i, name: p.name, text: p.text, t: p.t || 0, live: !!(p.t && p.t >= Date.now() - PLEDGE_HOURS * 3600000) })).slice(-100).reverse(),
        counts: { posts: BUILDING_IDS.reduce((n, b) => n + db.posts[b].length, 0), pledges: db.pledges.length, chat: db.chat.length } });
    }
    if (url === '/api/admin/delete' || url === '/api/admin/restore') {
      const post = findPost(m.b, m.id); if (!post) return json(404, { error: '글을 찾지 못했어요' });
      let target = post, cid = null;
      if (m.cid) { target = post.comments.find(c => c.id === Number(m.cid)); if (!target) return json(404, { error: '댓글을 찾지 못했어요' }); cid = target.id; }
      if (url === '/api/admin/restore') { target.hidden = false; target.reports = []; save(); return json(200, { ok: true }); }
      if (cid) post.comments = post.comments.filter(c => c.id !== cid); else db.posts[m.b] = db.posts[m.b].filter(p => p.id !== post.id);
      save(); broadcast({ t: 'del', b: m.b, id: post.id, cid });
      console.log('[운영자] 삭제', m.b, post.id, cid || '');
      return json(200, { ok: true });
    }
    if (url === '/api/admin/delchat') {
      const i = db.chat.findIndex(c => c.id === Number(m.id));
      if (i < 0) return json(404, { error: '이미 지워졌어요. 목록을 새로고침해 주세요' });
      db.chat.splice(i, 1); save(); console.log('[운영자] 채팅 삭제', m.id);
      return json(200, { ok: true });
    }
    if (url === '/api/admin/delpledge') {
      const i = Number(m.i), p = db.pledges[i];
      if (!p || p.text !== m.text) return json(404, { error: '이미 바뀌었어요. 목록을 새로고침해 주세요' });
      db.pledges.splice(i, 1); save(); broadcast({ t: 'delpledge', x: p.x, y: p.y, text: p.text });
      console.log('[운영자] 다짐 삭제', p.text);
      return json(200, { ok: true });
    }
    return json(404, { error: '없는 주소예요' });
  });
}

/* ---------- HTTP: 화면 파일 몇 개만 공개 ---------- */
const STATIC = {
  '/favicon.svg': ['favicon.svg', 'image/svg+xml', 'public, max-age=86400'],
  '/og.jpg': ['og.jpg', 'image/jpeg', 'public, max-age=86400'],
  '/admin': ['admin.html', 'text/html; charset=utf-8', 'no-store'],
};
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0], ip = ipOf(req);
  const head = (type, cache) => ({ 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url.startsWith('/api/admin/')) return adminApi(req, res, ip, url);
  if (url === '/robots.txt') { res.writeHead(200, head('text/plain', 'public, max-age=86400')); res.end('User-agent: *\nDisallow: /admin\nDisallow: /api/\n'); return; }
  if (url === '/' || url === '/index.html') {
    /* 링크 미리보기(og) 주소는 PUBLIC_URL, 없으면 지금 접속한 주소로 채워요 */
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0], host = req.headers.host || 'localhost';
    const base = PUBLIC_URL || (proto + '://' + host);
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, html) => {
      if (err) { res.writeHead(500); return res.end('error'); }
      res.writeHead(200, head('text/html; charset=utf-8', 'no-cache')); res.end(html.split('__BASE__').join(base));
    });
    return;
  }
  const st = STATIC[url];
  if (st) {
    const h = head(st[1], st[2]); if (url === '/admin') h['X-Robots-Tag'] = 'noindex';
    fs.readFile(path.join(__dirname, st[0]), (err, buf) => { if (err) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, h); res.end(buf); });
    return;
  }
  res.writeHead(404); res.end('not found');
});

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, maxPayload: 2048 });
const players = new Map();
let nextId = 1;
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const broadcast = (m, except) => { const s = JSON.stringify(m); for (const [ws] of players) if (ws !== except && ws.readyState === 1) ws.send(s); };
const pub = p => ({ id: p.id, name: p.name, uni: p.uni, cap: p.cap, x: p.x, y: p.y, dir: p.dir, act: p.act || null });
const okAct = a => a === 'sit' || /^(swing[01]|pull[01]|bench[01]|jump[01]|curl[01]|punch0)$/.test(a || '');   // 앉기·그네·체력단련 기구 자세

const ipConns = new Map();   // 한 주소에서 동시에 열 수 있는 연결 수
const MAX_PER_IP = 12;       // 부대·학교처럼 여럿이 같은 주소를 쓸 수 있어서 넉넉하게
wss.on('connection', (ws, req) => {
  if (players.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); return ws.close(); }
  const ip = ipOf(req), ipk = ipKey(ip);
  if ((ipConns.get(ip) || 0) >= MAX_PER_IP || !hit('conn:' + ip, 60, 60000)) return ws.close();
  ipConns.set(ip, (ipConns.get(ip) || 0) + 1);
  ws.on('close', () => { const n = (ipConns.get(ip) || 1) - 1; n ? ipConns.set(ip, n) : ipConns.delete(ip); });
  const me = { id: nextId++, ip, ipk, joined: false, name: '', uni: '', cap: '', x: 700, y: 560, dir: 1, last: 0, tokens: 30, tAt: Date.now() };
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    /* 초당 약 25개까지만 허용 */
    const now = Date.now(); me.tokens = Math.min(30, me.tokens + (now - me.tAt) / 40); me.tAt = now;
    if (me.tokens < 1) return; me.tokens--;

    if (m.t === 'join' && !me.joined) {
      me.joined = true; me.name = str(m.name, 8) || '새내기'; me.uni = color(m.uni); me.cap = color(m.cap);
      me.x = num(m.x, 0, W, 700); me.y = num(m.y, 0, H, 560);
      players.set(ws, me); me.joinedAt = now;
      me.uid = typeof m.uid === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(m.uid) ? m.uid : 'conn-' + me.id; // 브라우저 고유 번호(좋아요 1회 제한용)
      logVisit('in', me, now);
      const recent = {}; BUILDING_IDS.forEach(id => { recent[id] = postsFor(id, me.uid); });
      send(ws, { t: 'init', id: me.id, players: [...players.values()].filter(p => p !== me).map(pub), pledges: livePledges(), posts: recent });
      broadcast({ t: 'join', p: pub(me) }, ws);
      return;
    }
    if (!me.joined) return;

    if (m.t === 'move') {
      me.x = num(m.x, 0, W, me.x); me.y = num(m.y, 0, H, me.y); me.dir = m.dir === -1 ? -1 : 1; me.act = null;
      broadcast({ t: 'move', id: me.id, x: me.x, y: me.y, dir: me.dir }, ws);
    } else if (m.t === 'act') {
      /* 자세(앉기·그네)와 그 자리. 일어서면 a가 null */
      me.act = okAct(m.a) ? m.a : null;
      me.x = num(m.x, 0, W, me.x); me.y = num(m.y, 0, H, me.y); me.dir = m.dir === -1 ? -1 : 1;
      broadcast({ t: 'act', id: me.id, a: me.act, x: me.x, y: me.y, dir: me.dir }, ws);
    } else if (m.t === 'fx') {
      /* 폭죽: 광장 위쪽 고정 범위에서만, 3초에 한 번 */
      if (m.k !== 'fw' || now - (me.lastFx || 0) < 2800) return; me.lastFx = now;
      broadcast({ t: 'fx', k: 'fw', x: num(m.x, 600, 1000, 800), y: num(m.y, 480, 640, 578) }, ws);
    } else if (m.t === 'say') {
      if (now - me.last < 400) return; me.last = now;
      const text = str(m.text, 40); if (!text) return;
      broadcast({ t: 'say', id: me.id, text }, ws);
      db.chat.push({ id: db.nextChatId++, t: now, name: me.name, text, ip: me.ipk }); if (db.chat.length > CHAT_KEEP) db.chat.shift(); save();
    } else if (m.t === 'pledge') {
      if (now - me.last < 1500) return; me.last = now;
      const text = str(m.text, 30); if (!text) return;
      if (!hit('pledge:' + ip, 6, TEN_MIN)) return send(ws, { t: 'limit', k: 'pledge' });
      const p = { name: me.name, text, x: num(m.x, 60, W - 60, 700), y: num(m.y, 60, H - 60, 450), t: now };
      db.pledges.push(p); db.pledges = db.pledges.slice(-KEEP_PLEDGES); save();
      broadcast({ t: 'pledge', p });
    } else if (m.t === 'post') {
      if (now - me.last < 1500) return; me.last = now;
      if (!BUILDING_IDS.includes(m.b)) return;
      const text = str(m.text, 300); if (!text) return;
      if (!hit('post:' + ip, 8, TEN_MIN)) return send(ws, { t: 'limit', k: 'post' });
      const post = { id: db.nextPostId++, name: me.name, text, date: new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }), likes: [], lip: [], reports: [], comments: [] };
      db.posts[m.b].push(post); db.posts[m.b] = db.posts[m.b].slice(-KEEP_POSTS); save();
      broadcast({ t: 'post', b: m.b, post: view(post, null) });
    } else if (m.t === 'comment') {
      if (now - (me.lastC || 0) < 1000) return; me.lastC = now;
      if (!BUILDING_IDS.includes(m.b)) return;
      const post = db.posts[m.b].find(p => p.id === Number(m.id)); if (!post) return;
      const text = str(m.text, 150); if (!text) return;
      if (post.hidden) return;
      if (!hit('cmt:' + ip, 30, TEN_MIN)) return send(ws, { t: 'limit', k: 'comment' });
      const c = { id: db.nextPostId++, name: me.name, text, date: new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }), reports: [] };
      post.comments.push(c); post.comments = post.comments.slice(-KEEP_COMMENTS); save();
      const cn = post.comments.filter(x => !x.hidden).length;
      broadcast({ t: 'comment', b: m.b, id: post.id, c: cview(c), cn });
    } else if (m.t === 'report') {
      /* 신고: 주소(IP)당 한 번. 서로 다른 5명이 신고하면 일단 가리고 운영자가 확인해요 */
      const post = findPost(m.b, m.id); if (!post) return;
      if (!hit('rep:' + ip, 20, TEN_MIN)) return send(ws, { t: 'limit', k: 'report' });
      let tgt = post, cid = null;
      if (m.cid) { tgt = post.comments.find(c => c.id === Number(m.cid)); if (!tgt) return; cid = tgt.id; }
      tgt.reports = tgt.reports || [];
      if (!tgt.reports.includes(me.ipk)) {
        tgt.reports.push(me.ipk);
        if (tgt.reports.length >= HIDE_AT && !tgt.hidden) { tgt.hidden = true; broadcast({ t: 'del', b: m.b, id: post.id, cid }); }
        save();
      }
      send(ws, { t: 'reported', b: m.b, id: post.id, cid });
    } else if (m.t === 'like') {
      /* 한 사람(브라우저)당 글마다 한 번만. 이미 눌렀으면 개수만 다시 알려줘요 */
      if (!BUILDING_IDS.includes(m.b)) return;
      const post = db.posts[m.b].find(p => p.id === Number(m.id)); if (!post) return;
      /* 브라우저 번호는 새로 만들 수 있으니, 같은 주소에서 한 글에 누를 수 있는 좋아요는 3개까지로 막아요 */
      if (!post.likes.includes(me.uid)) {
        if (!hit('like:' + ip, 80, TEN_MIN)) return send(ws, { t: 'limit', k: 'like' });
        post.lip = post.lip || [];
        if (post.lip.filter(k => k === me.ipk).length < 3) { post.likes.push(me.uid); post.lip.push(me.ipk); save(); }
        else return send(ws, { t: 'limit', k: 'like' });
      }
      const n = post.likes.length;
      broadcast({ t: 'like', b: m.b, id: post.id, n }, ws);
      send(ws, { t: 'like', b: m.b, id: post.id, n, you: true });
    }
  });

  ws.on('close', () => { if (players.delete(ws)) { broadcast({ t: 'leave', id: me.id }); const t = Date.now(); logVisit('out', me, t, Math.round((t - (me.joinedAt || t)) / 1000)); } });
  ws.on('error', () => {});
});

/* 끊어진 연결 정리 */
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 30000);

server.listen(PORT, () => console.log('복귀마을 서버 시작: http://localhost:' + PORT));
