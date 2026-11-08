// VR Archive world server: a small authoritative-relay multiplayer server.
// Speaks JSON over WebSocket (see ../PROTOCOL.md). Persists visits and chat
// to Postgres when DATABASE_URL is set, and runs without a database otherwise.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 7777);
const TICK_HZ = 10;
const WORLD = process.env.WORLD_ID || 'vrarchive';
const started = Date.now();

// ---------- optional database ----------
let db = null;
async function initDb() {
  if (!process.env.DATABASE_URL) return;
  const { Pool } = require('pg');
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      await pool.query(`CREATE TABLE IF NOT EXISTS visits (
        id SERIAL PRIMARY KEY, name TEXT, platform TEXT,
        joined_at TIMESTAMPTZ DEFAULT now(), left_at TIMESTAMPTZ)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS chat (
        id SERIAL PRIMARY KEY, name TEXT, platform TEXT, zone TEXT, text TEXT,
        sent_at TIMESTAMPTZ DEFAULT now())`);
      db = pool;
      console.log('[db] connected');
      return;
    } catch (e) {
      console.log(`[db] not ready (${attempt}): ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.log('[db] giving up, running without persistence');
}
const q = (sql, args) => db ? db.query(sql, args).catch(e => console.error('[db]', e.message)) : Promise.resolve(null);

// ---------- world state ----------
const players = new Map(); // id -> { ws, name, platform, color, zone, p, ry, visitId }
let nextId = 1;
const COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#008080'];

function pub(id, pl) {
  return { id, name: pl.name, platform: pl.platform, color: pl.color, zone: pl.zone, p: pl.p, ry: pl.ry };
}
function broadcast(msg, exceptId) {
  const s = JSON.stringify(msg);
  for (const [id, pl] of players) if (id !== exceptId && pl.ws.readyState === 1) pl.ws.send(s);
}
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').slice(0, n);
const num = v => (typeof v === 'number' && isFinite(v) ? Math.max(-1e4, Math.min(1e4, v)) : 0);

// ---------- http (status) + websocket ----------
const server = http.createServer(async (req, res) => {
  if (req.url === '/status' || req.url === '/') {
    let visits = null, chats = null;
    if (db) {
      const r = await q('SELECT (SELECT count(*) FROM visits)::int AS v, (SELECT count(*) FROM chat)::int AS c');
      if (r) { visits = r.rows[0].v; chats = r.rows[0].c; }
    }
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({
      world: WORLD, uptime_s: Math.round((Date.now() - started) / 1000),
      database: !!db, total_visits: visits, chat_messages: chats,
      players: [...players].map(([id, pl]) => pub(id, pl)),
    }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let id = null;
  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'hello' && id === null) {
      id = nextId++;
      const pl = {
        ws, name: clean(m.name, 24) || `Visitor ${id}`,
        platform: clean(m.platform, 12) || 'unknown',
        color: COLORS[id % COLORS.length], zone: m.zone === 'hall' ? 'hall' : 'street',
        p: [0, 0, 0], ry: 0, visitId: null,
      };
      players.set(id, pl);
      ws.send(JSON.stringify({ t: 'welcome', id, world: WORLD, players: [...players].map(([i, p]) => pub(i, p)) }));
      broadcast({ t: 'join', player: pub(id, pl) }, id);
      console.log(`[join] ${pl.name} (${pl.platform})`);
      const r = await q('INSERT INTO visits(name, platform) VALUES ($1,$2) RETURNING id', [pl.name, pl.platform]);
      if (r) pl.visitId = r.rows[0].id;
      return;
    }
    const pl = players.get(id);
    if (!pl) return;
    if (m.t === 'move') {
      if (m.zone === 'hall' || m.zone === 'street') pl.zone = m.zone;
      if (Array.isArray(m.p) && m.p.length === 3) pl.p = m.p.map(num);
      pl.ry = num(m.ry);
    } else if (m.t === 'chat') {
      const text = clean(m.text, 200);
      if (!text) return;
      broadcast({ t: 'chat', id, name: pl.name, platform: pl.platform, text });
      q('INSERT INTO chat(name, platform, zone, text) VALUES ($1,$2,$3,$4)', [pl.name, pl.platform, pl.zone, text]);
    }
  });
  ws.on('close', () => {
    if (id === null) return;
    const pl = players.get(id);
    players.delete(id);
    broadcast({ t: 'leave', id });
    if (pl) {
      console.log(`[leave] ${pl.name}`);
      if (pl.visitId) q('UPDATE visits SET left_at = now() WHERE id = $1', [pl.visitId]);
    }
  });
});

setInterval(() => {
  if (players.size) broadcast({ t: 'snapshot', players: [...players].map(([id, pl]) => pub(id, pl)) });
}, 1000 / TICK_HZ);

initDb().finally(() => server.listen(PORT, () => console.log(`[world:${WORLD}] listening on ${PORT}`)));
