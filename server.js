'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
/* 기록은 DATA_DIR(배포 환경에서는 지워지지 않는 디스크 경로)에 저장해요 */
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA = path.join(DATA_DIR, 'data.json');
const BUILDING_IDS = ['job', 'cert', 'biz', 'trip', 'rest', 'senior', 'story', 'soon'];
const MAX_PLAYERS = 100;                 // 동시 접속 최대 인원 (서버 1대)
const KEEP_POSTS = 5000, KEEP_PLEDGES = 1000;   // 서버에 보관하는 최대 개수 (사실상 영구)
const SHOW_POSTS = 100, SHOW_PLEDGES = 60;      // 접속할 때 화면에 보내는 최근 개수
const W = 1400, H = 920;

/* ---------- 저장되는 데이터: 등불, 건물별 글 ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { pledges: [], posts: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA, 'utf8'))); }
catch (e) { if (e.code !== 'ENOENT') { console.error('data.json을 읽지 못했어요. 덮어쓰지 않도록 종료합니다:', e.message); process.exit(1); } }
BUILDING_IDS.forEach(id => { db.posts[id] = db.posts[id] || []; });

/* 저장은 임시 파일에 쓴 뒤 교체해서, 도중에 꺼져도 기존 파일이 깨지지 않아요. 하루 1번 백업도 남겨요(최근 14개). */
let saveT, lastBackup = '';
function flush() {
  clearTimeout(saveT);
  const tmp = DATA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA);
  const day = new Date().toISOString().slice(0, 10);
  if (day !== lastBackup) {
    lastBackup = day;
    try {
      fs.copyFileSync(DATA, path.join(DATA_DIR, 'data-' + day + '.bak.json'));
      fs.readdirSync(DATA_DIR).filter(f => /^data-.*\.bak\.json$/.test(f)).sort().slice(0, -14)
        .forEach(f => fs.unlinkSync(path.join(DATA_DIR, f)));
    } catch (e) {}
  }
}
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { flush(); } catch (e) { console.error('저장 실패', e.message); } }, 500); };
/* 재배포·종료 신호가 오면 마지막으로 저장하고 꺼져요 */
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { flush(); } catch (e) {} process.exit(0); });

/* ---------- 입력 정리 ---------- */
const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');
const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const color = v => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#6b7f4a');

/* ---------- HTTP: index.html 하나만 공개 ---------- */
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (req.url === '/'|| req.url.startsWith('/?') || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  } else { res.writeHead(404); res.end('not found'); }
});

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, maxPayload: 2048 });
const players = new Map();
let nextId = 1;
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const broadcast = (m, except) => { const s = JSON.stringify(m); for (const [ws] of players) if (ws !== except && ws.readyState === 1) ws.send(s); };
const pub = p => ({ id: p.id, name: p.name, uni: p.uni, cap: p.cap, x: p.x, y: p.y, dir: p.dir });

wss.on('connection', ws => {
  if (players.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); return ws.close(); }
  const me = { id: nextId++, joined: false, name: '', uni: '', cap: '', x: 700, y: 560, dir: 1, last: 0, tokens: 30, tAt: Date.now() };
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
      players.set(ws, me);
      const recent = {}; BUILDING_IDS.forEach(id => { recent[id] = db.posts[id].slice(-SHOW_POSTS); });
      send(ws, { t: 'init', id: me.id, players: [...players.values()].filter(p => p !== me).map(pub), pledges: db.pledges.slice(-SHOW_PLEDGES), posts: recent });
      broadcast({ t: 'join', p: pub(me) }, ws);
      return;
    }
    if (!me.joined) return;

    if (m.t === 'move') {
      me.x = num(m.x, 0, W, me.x); me.y = num(m.y, 0, H, me.y); me.dir = m.dir === -1 ? -1 : 1;
      broadcast({ t: 'move', id: me.id, x: me.x, y: me.y, dir: me.dir }, ws);
    } else if (m.t === 'say') {
      if (now - me.last < 400) return; me.last = now;
      const text = str(m.text, 40); if (!text) return;
      broadcast({ t: 'say', id: me.id, text }, ws);
    } else if (m.t === 'pledge') {
      if (now - me.last < 1500) return; me.last = now;
      const text = str(m.text, 30); if (!text) return;
      const p = { name: me.name, text, x: num(m.x, 60, W - 60, 700), y: num(m.y, 60, H - 60, 450) };
      db.pledges.push(p); db.pledges = db.pledges.slice(-KEEP_PLEDGES); save();
      broadcast({ t: 'pledge', p });
    } else if (m.t === 'post') {
      if (now - me.last < 1500) return; me.last = now;
      if (!BUILDING_IDS.includes(m.b)) return;
      const text = str(m.text, 300); if (!text) return;
      const post = { name: me.name, text, date: new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) };
      db.posts[m.b].push(post); db.posts[m.b] = db.posts[m.b].slice(-KEEP_POSTS); save();
      broadcast({ t: 'post', b: m.b, post });
    }
  });

  ws.on('close', () => { if (players.delete(ws)) broadcast({ t: 'leave', id: me.id }); });
  ws.on('error', () => {});
});

/* 끊어진 연결 정리 */
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 30000);

server.listen(PORT, () => console.log('복귀마을 서버 시작: http://localhost:' + PORT));
