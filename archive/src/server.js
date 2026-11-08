// Virtual World Archive: portal + server library orchestrator.
// - Serves the Archive-style portal (public/), uploaded web clients (/clients/<id>/)
// - Accepts uploaded game server packages (Dockerfile build context) and web clients
// - Builds and runs each server as a Docker container, with an optional Postgres
//   database container, and proxies player WebSockets at /play/<serverId>
const http = require('http');
const net = require('net');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Busboy = require('busboy');
const docker = require('./docker');

const PORT = Number(process.env.PORT || 8080);
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const SEED = process.env.SEED_DIR ? path.resolve(process.env.SEED_DIR) : null;
const PUBLIC = path.join(__dirname, '..', 'public');
const NETWORK = process.env.VWA_NETWORK || 'vwa';
// Dev mode without Docker: map server ids to already running hosts, e.g. "vrarchive=localhost:7777"
const STATIC_SERVERS = Object.fromEntries((process.env.STATIC_SERVERS || '').split(',').filter(Boolean).map(s => s.split('=')));

const REG_FILE = path.join(DATA, 'registry.json');
let registry = { servers: {}, clients: {} };
const buildLogs = {}; // id -> [lines]

// ---------------- registry ----------------
async function loadRegistry() {
  await fsp.mkdir(path.join(DATA, 'clients'), { recursive: true });
  await fsp.mkdir(path.join(DATA, 'servers'), { recursive: true });
  try { registry = JSON.parse(await fsp.readFile(REG_FILE, 'utf8')); } catch {}
  registry.servers ||= {}; registry.clients ||= {};
}
async function saveRegistry() {
  await fsp.writeFile(REG_FILE + '.tmp', JSON.stringify(registry, null, 2));
  await fsp.rename(REG_FILE + '.tmp', REG_FILE);
}
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const containerName = id => `vwa-${id}`;
const dbName = id => `vwa-${id}-db`;

function log(id, line) {
  (buildLogs[id] ||= []).push(line);
  if (buildLogs[id].length > 500) buildLogs[id].shift();
  console.log(`[${id}] ${line}`);
}

// ---------------- helpers ----------------
function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} failed: ${err.trim()}`))));
    p.on('error', reject);
  });
}

async function extract(file, dest) {
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  const head = Buffer.alloc(4);
  const fd = await fsp.open(file); await fd.read(head, 0, 4, 0); await fd.close();
  if (head[0] === 0x50 && head[1] === 0x4b) await sh('unzip', ['-q', '-o', file, '-d', dest]);
  else if (head[0] === 0x1f && head[1] === 0x8b) await sh('tar', ['-xzf', file, '-C', dest]);
  else await sh('tar', ['-xf', file, '-C', dest]);
}

// Find the directory (up to depth 3) that contains `marker`.
async function findDirWith(root, marker, depth = 3) {
  try { await fsp.access(path.join(root, marker)); return root; } catch {}
  if (depth === 0) return null;
  for (const e of await fsp.readdir(root, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__MACOSX') {
      const r = await findDirWith(path.join(root, e.name), marker, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

async function copyDir(src, dest) {
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.cp(src, dest, { recursive: true, dereference: true, filter: s => !s.includes('node_modules') });
}

// ---------------- server lifecycle ----------------
const deploying = new Set();
async function deployServer(id) {
  if (deploying.has(id)) return;
  deploying.add(id);
  try { await deployServerInner(id); } finally { deploying.delete(id); }
}
async function deployServerInner(id) {
  const s = registry.servers[id];
  buildLogs[id] = [];
  s.state = 'building'; s.error = null; await saveRegistry();
  try {
    const ctx = await findDirWith(path.join(DATA, 'servers', id, 'src'), 'Dockerfile');
    if (!ctx) throw new Error('No Dockerfile found in the uploaded package');
    await docker.ensureNetwork(NETWORK);

    let dbUrl = null;
    if (s.database === 'postgres') {
      log(id, 'Starting Postgres database container');
      await docker.ensureImage('postgres:16-alpine', l => log(id, l));
      s.dbPassword ||= crypto.randomBytes(12).toString('hex');
      const existing = await docker.inspect(dbName(id));
      if (!existing) {
        await docker.run(dbName(id), {
          Image: 'postgres:16-alpine',
          Env: [`POSTGRES_PASSWORD=${s.dbPassword}`, 'POSTGRES_DB=world'],
          Labels: { 'vwa.world': id, 'vwa.role': 'database' },
          HostConfig: {
            NetworkMode: NETWORK, RestartPolicy: { Name: 'unless-stopped' },
            Binds: [`vwa-${id}-pgdata:/var/lib/postgresql/data`],
          },
        });
      } else await docker.start(dbName(id));
      dbUrl = `postgres://postgres:${s.dbPassword}@${dbName(id)}:5432/world`;
    }

    log(id, 'Building server image');
    const tar = spawn('tar', ['-c', '-C', ctx, '.']);
    await docker.build(`vwa-world-${id}:latest`, tar.stdout, l => log(id, l));

    log(id, 'Starting server container');
    const env = [`PORT=${s.port}`, `WORLD_ID=${id}`];
    if (dbUrl) env.push(`DATABASE_URL=${dbUrl}`);
    await docker.run(containerName(id), {
      Image: `vwa-world-${id}:latest`, Env: env,
      Labels: { 'vwa.world': id, 'vwa.role': 'server' },
      HostConfig: { NetworkMode: NETWORK, RestartPolicy: { Name: 'unless-stopped' }, Memory: 512 * 1024 * 1024 },
    });
    s.state = 'running'; s.deployedAt = new Date().toISOString();
    log(id, 'Server is running');
  } catch (e) {
    s.state = 'error'; s.error = e.message; log(id, `ERROR: ${e.message}`);
  }
  await saveRegistry();
}

function serverTarget(id) {
  if (STATIC_SERVERS[id]) { const [host, port] = STATIC_SERVERS[id].split(':'); return { host, port: Number(port) }; }
  const s = registry.servers[id];
  return s ? { host: containerName(id), port: s.port } : null;
}

async function liveState(id) {
  const s = registry.servers[id];
  if (STATIC_SERVERS[id]) return { container: 'external', database: s.database ? 'external' : null };
  const c = await docker.inspect(containerName(id)).catch(() => null);
  const d = s.database ? await docker.inspect(dbName(id)).catch(() => null) : null;
  return { container: c ? c.State.Status : 'absent', database: s.database ? (d ? d.State.Status : 'absent') : null };
}

function fetchStatus(id) {
  const t = serverTarget(id);
  return new Promise(resolve => {
    if (!t) return resolve(null);
    const req = http.get({ host: t.host, port: t.port, path: '/status', timeout: 1500 }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function publicServer(s) {
  const { dbPassword, ...rest } = s; return rest;
}

// ---------------- uploads ----------------
function parseUpload(req, destFile) {
  return new Promise((resolve, reject) => {
    const fields = {}; let gotFile = false, writing = null;
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
    bb.on('field', (k, v) => (fields[k] = v));
    bb.on('file', (k, stream, info) => {
      gotFile = true; fields._filename = info.filename;
      const out = fs.createWriteStream(destFile);
      writing = new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); });
      stream.pipe(out);
    });
    bb.on('close', async () => { try { if (writing) await writing; resolve({ fields, gotFile }); } catch (e) { reject(e); } });
    bb.on('error', reject);
    req.pipe(bb);
  });
}

async function registerServer({ id, title, description, port, database, client, sourceDir, packageFile }) {
  const dir = path.join(DATA, 'servers', id);
  await fsp.mkdir(dir, { recursive: true });
  if (packageFile) await extract(packageFile, path.join(dir, 'src'));
  if (sourceDir) await copyDir(sourceDir, path.join(dir, 'src'));
  let manifest = {};
  const mdir = await findDirWith(path.join(dir, 'src'), 'vwa.json');
  if (mdir) { try { manifest = JSON.parse(await fsp.readFile(path.join(mdir, 'vwa.json'), 'utf8')); } catch {} }
  const prev = registry.servers[id] || {};
  registry.servers[id] = {
    ...prev, id,
    title: title || manifest.title || prev.title || id,
    description: description || manifest.description || prev.description || '',
    port: Number(port || manifest.port || prev.port || 7777),
    database: (database ?? manifest.database ?? prev.database) || null,
    client: client || manifest.client || prev.client || null,
    protocol: manifest.protocol || prev.protocol || 'websocket',
    createdAt: prev.createdAt || new Date().toISOString(),
    state: 'queued',
  };
  if (registry.servers[id].database === 'none') registry.servers[id].database = null;
  if (STATIC_SERVERS[id]) registry.servers[id].state = 'running';
  await saveRegistry();
  if (!STATIC_SERVERS[id]) deployServer(id); // async
  return registry.servers[id];
}

async function registerClient({ id, title, server, sourceDir, packageFile }) {
  const dest = path.join(DATA, 'clients', id);
  if (packageFile) {
    const tmp = dest + '.tmp';
    await extract(packageFile, tmp);
    const root = (await findDirWith(tmp, 'index.html')) || tmp;
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rename(root, dest);
    await fsp.rm(tmp, { recursive: true, force: true });
  }
  if (sourceDir) await copyDir(sourceDir, dest);
  let manifest = {};
  try { manifest = JSON.parse(await fsp.readFile(path.join(dest, 'vwa-client.json'), 'utf8')); } catch {}
  registry.clients[id] = {
    id, title: title || manifest.title || id, server: server || manifest.server || null,
    platform: manifest.platform || 'webgl', createdAt: new Date().toISOString(),
  };
  await saveRegistry();
  return registry.clients[id];
}

async function seed() {
  if (!SEED) return;
  for (const kind of ['clients', 'servers']) {
    let entries = [];
    try { entries = await fsp.readdir(path.join(SEED, kind), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const src = path.join(SEED, kind, e.name);
      if (!(await fsp.stat(src).catch(() => null))?.isDirectory()) continue;
      const id = slug(e.name);
      if (kind === 'clients') {
        // Always refresh seeded clients so code changes show up on restart.
        await registerClient({ id, sourceDir: src });
        console.log(`[seed] client ${id}`);
      } else if (!registry.servers[id] || process.env.RESEED === '1') {
        console.log(`[seed] server ${id}`);
        await registerServer({ id, sourceDir: src });
      }
    }
  }
}

// On boot, restart any registered server whose container is missing.
async function reconcile() {
  if (!(await docker.ping())) { console.log('[docker] not reachable; server containers will not be managed'); return; }
  for (const id of Object.keys(registry.servers)) {
    if (STATIC_SERVERS[id]) continue;
    const st = await liveState(id);
    if (st.container === 'absent' && registry.servers[id].state !== 'stopped' && !deploying.has(id)) deployServer(id);
  }
}

// ---------------- http ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.ico': 'image/x-icon', '.txt': 'text/plain',
};

async function serveFile(res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  let st; try { st = await fsp.stat(file); } catch { res.writeHead(404); return res.end('Not found'); }
  if (st.isDirectory()) return serveFile(res, root, path.join(rel, 'index.html'));
  // Unity WebGL builds ship pre-compressed files (.gz / .br).
  let ext = path.extname(file), enc = null;
  if (ext === '.gz' || ext === '.br') { enc = ext === '.gz' ? 'gzip' : 'br'; ext = path.extname(file.slice(0, -3)); }
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'content-length': st.size,
    'access-control-allow-origin': '*', 'cache-control': 'no-cache' };
  if (enc) headers['content-encoding'] = enc;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': '*' });
      return res.end();
    }
    // ---- API ----
    if (p === '/api/servers' && req.method === 'GET') {
      const list = await Promise.all(Object.values(registry.servers).map(async s => ({ ...publicServer(s), live: await liveState(s.id).catch(() => null) })));
      return json(res, 200, list);
    }
    if (p === '/api/servers' && req.method === 'POST') {
      const tmp = path.join(DATA, `upload-${Date.now()}`);
      const { fields, gotFile } = await parseUpload(req, tmp);
      const id = slug(fields.id || (fields._filename || '').replace(/\.(tar\.gz|tgz|tar|zip)$/i, ''));
      if (!id || !gotFile) { await fsp.rm(tmp, { force: true }); return json(res, 400, { error: 'Need an id and a package file' }); }
      const s = await registerServer({ id, title: fields.title, description: fields.description, port: fields.port,
        database: fields.database, client: fields.client, packageFile: tmp });
      await fsp.rm(tmp, { force: true });
      return json(res, 202, publicServer(s));
    }
    let m;
    if ((m = p.match(/^\/api\/servers\/([a-z0-9-]+)$/)) && req.method === 'GET') {
      const s = registry.servers[m[1]]; if (!s) return json(res, 404, { error: 'not found' });
      const [live, status] = await Promise.all([liveState(s.id).catch(() => null), fetchStatus(s.id)]);
      return json(res, 200, { ...publicServer(s), live, status, client: s.client ? registry.clients[s.client] || { id: s.client } : null });
    }
    if ((m = p.match(/^\/api\/servers\/([a-z0-9-]+)\/(start|stop|rebuild|logs|buildlog)$/))) {
      const [, id, action] = m; const s = registry.servers[id];
      if (!s) return json(res, 404, { error: 'not found' });
      if (action === 'buildlog') return json(res, 200, { state: s.state, error: s.error, lines: buildLogs[id] || [] });
      if (action === 'logs') return json(res, 200, { text: await docker.logs(containerName(id)).catch(e => e.message) });
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
      if (action === 'rebuild') { deployServer(id); return json(res, 202, { ok: true }); }
      if (action === 'start') { if (s.database) await docker.start(dbName(id)); await docker.start(containerName(id)); s.state = 'running'; }
      if (action === 'stop') { await docker.stop(containerName(id)); if (s.database) await docker.stop(dbName(id)); s.state = 'stopped'; }
      await saveRegistry(); return json(res, 200, { ok: true });
    }
    if (p === '/api/clients' && req.method === 'GET') return json(res, 200, Object.values(registry.clients));
    if (p === '/api/clients' && req.method === 'POST') {
      const tmp = path.join(DATA, `upload-${Date.now()}`);
      const { fields, gotFile } = await parseUpload(req, tmp);
      const id = slug(fields.id || (fields._filename || '').replace(/\.(tar\.gz|tgz|tar|zip)$/i, ''));
      if (!id || !gotFile) { await fsp.rm(tmp, { force: true }); return json(res, 400, { error: 'Need an id and a package file' }); }
      const c = await registerClient({ id, title: fields.title, server: fields.server, packageFile: tmp });
      await fsp.rm(tmp, { force: true });
      if (c.server && registry.servers[c.server] && !registry.servers[c.server].client) { registry.servers[c.server].client = id; await saveRegistry(); }
      return json(res, 201, c);
    }
    // ---- static ----
    if (p.startsWith('/clients/')) return serveFile(res, path.join(DATA, 'clients'), p.slice('/clients/'.length));
    if ((m = p.match(/^\/details\/[a-z0-9-]+\/?$/))) return serveFile(res, PUBLIC, 'details.html');
    return serveFile(res, PUBLIC, p === '/' ? 'index.html' : p);
  } catch (e) {
    console.error(e); json(res, 500, { error: e.message });
  }
});

// WebSocket proxy: /play/<serverId>  ->  ws://vwa-<serverId>:<port>/
server.on('upgrade', (req, socket, head) => {
  const m = (req.url || '').match(/^\/play\/([a-z0-9-]+)/);
  const t = m && serverTarget(m[1]);
  if (!t) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  const upstream = net.connect(t.port, t.host, () => {
    let headers = `GET / HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    upstream.write(headers + '\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  const close = () => { upstream.destroy(); socket.destroy(); };
  upstream.on('error', () => { if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); close(); });
  socket.on('error', close);
});

(async () => {
  await loadRegistry();
  server.listen(PORT, () => console.log(`[archive] http://localhost:${PORT}`));
  await seed().catch(e => console.error('[seed]', e));
  await reconcile().catch(e => console.error('[reconcile]', e));
})();
