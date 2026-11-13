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
const auth = require('./auth');

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
const SEED_OWNER = null; // seeded worlds have no uploader
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

async function registerServer({ id, title, description, port, database, client, sourceDir, packageFile, createdBy, policy }) {
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
    createdBy: prev.createdBy !== undefined ? prev.createdBy : (createdBy || SEED_OWNER),
    policy: prev.policy || policy || auth.defaultPolicy(),
    state: 'queued',
  };
  if (registry.servers[id].database === 'none') registry.servers[id].database = null;
  if (STATIC_SERVERS[id]) registry.servers[id].state = 'running';
  await saveRegistry();
  if (!STATIC_SERVERS[id]) deployServer(id); // async
  return registry.servers[id];
}

async function registerClient({ id, title, server, sourceDir, packageFile, createdBy }) {
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
    createdBy: registry.clients[id]?.createdBy || createdBy || null,
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
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new auth.HttpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new auth.HttpError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ---------------- access checks ----------------
const deny = (status, msg) => { throw new auth.HttpError(status, msg); };
function requireUser(user) { if (!user) deny(401, 'Sign in first'); return user; }
function requireSite(user, perm) {
  if (!auth.can(user, perm)) deny(user ? 403 : 401, user ? 'You do not have permission to do that' : 'Sign in first');
}
function requireInstance(user, s, perm) {
  if (!auth.instancePermissions(user, s).has(perm)) deny(user ? 403 : 401, user ? `You need ${perm} on ${s.id}` : 'Sign in first');
}
// Browsers send Origin on cross-site POSTs; refuse those so a session cookie can't be used by another site.
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  // Behind a forwarding proxy (Codespaces, some tunnels) the public host is in X-Forwarded-Host.
  const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] || '').split(',').map(h => h.trim())];
  try { return hosts.includes(new URL(o).host); } catch { return false; }
}

function serverView(s, user, { detail = false } = {}) {
  const perms = auth.instancePermissions(user, s);
  const pol = s.policy || auth.defaultPolicy();
  const out = { ...publicServer(s), policy: { mode: pol.mode, access: pol.access }, can: [...perms] };
  delete out.createdBy;
  if (detail && (perms.has('instance.policy') || perms.has('instance.operate'))) out.policy = auth.describePolicy(pol);
  return out;
}

async function handleUpload(req, res, user, kind) {
  requireUser(user);
  const tmp = path.join(DATA, `upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const { fields, gotFile } = await parseUpload(req, tmp);
    const id = slug(fields.id || (fields._filename || '').replace(/\.(tar\.gz|tgz|tar|zip)$/i, ''));
    if (!id || !gotFile) return json(res, 400, { error: 'Need an id and a package file' });
    if (kind === 'server') {
      const existing = registry.servers[id];
      let policy = null;
      if (existing) requireInstance(user, existing, 'instance.configure');
      else {
        requireSite(user, 'servers.upload');
        policy = uploadPolicy(user, fields);
      }
      if (fields.client && registry.clients[fields.client] && !canChangeClient(user, registry.clients[fields.client]))
        deny(403, `You cannot attach client ${fields.client}`);
      const s = await registerServer({ id, title: fields.title, description: fields.description, port: fields.port,
        database: fields.database, client: fields.client, packageFile: tmp, createdBy: user.id, policy });
      return json(res, 202, serverView(s, user));
    }
    requireSite(user, 'clients.upload');
    if (registry.clients[id] && !canChangeClient(user, registry.clients[id])) deny(403, `Client ${id} belongs to someone else`);
    const target = fields.server && registry.servers[fields.server];
    if (target) requireInstance(user, target, 'instance.configure');
    const c = await registerClient({ id, title: fields.title, server: fields.server, packageFile: tmp, createdBy: user.id });
    if (target && !target.client) { target.client = id; await saveRegistry(); }
    return json(res, 201, c);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

// A client may be replaced by its uploader, or by whoever can configure the server it belongs to.
function canChangeClient(user, c) {
  if (auth.can(user, 'site.admin') || (user && c.createdBy === user.id)) return true;
  const s = c.server && registry.servers[c.server];
  return s ? auth.instancePermissions(user, s).has('instance.configure') : auth.can(user, 'servers.manage');
}

// Policy chosen on the upload form for a new server.
function uploadPolicy(user, f) {
  if (f.managed !== '1' && f.managed !== 'on') return auth.sanitizePolicy({ mode: 'open', access: f.access });
  const mineOnly = !auth.can(user, 'access.manage');
  const myGroups = new Set(auth.groupsOf(user).map(g => g.id));
  if (!f.adminGroup) deny(400, 'Pick the group that administers this Managed Server Instance');
  if (mineOnly && !myGroups.has(f.adminGroup)) deny(403, 'You can only hand a managed instance to a group you belong to');
  return auth.sanitizePolicy({ mode: 'managed', access: f.access, bindings: [{ group: f.adminGroup, role: f.adminRole || 'instance-admin' }] });
}

async function route(req, res, url, p, user) {
  let m;
  // ---- accounts ----
  if (p === '/api/me' && req.method === 'GET') {
    return json(res, 200, { user: auth.publicUser(user, { full: true }), permissions: [...auth.sitePermissions(user)],
      google: auth.googleEnabled(), registration: auth.settings().registration });
  }
  if (p === '/api/me' && req.method === 'PATCH') {
    const u = await auth.updateProfile(requireUser(user), await readJson(req));
    return json(res, 200, auth.publicUser(u, { full: true }));
  }
  if (p === '/api/auth/login' && req.method === 'POST') return json(res, 200, auth.publicUser(await auth.login(req, res, await readJson(req))));
  if (p === '/api/auth/register' && req.method === 'POST') return json(res, 201, auth.publicUser(await auth.register(req, res, await readJson(req))));
  if (p === '/api/auth/logout' && req.method === 'POST') { await auth.endSession(req, res); return json(res, 200, { ok: true }); }
  if (p === '/auth/google' && req.method === 'GET') return auth.googleStart(req, res, url);
  if (p === '/auth/google/callback' && req.method === 'GET') return auth.googleCallback(req, res, url);

  // ---- access control (Site Admin panel) ----
  if (p === '/api/directory' && req.method === 'GET') { requireUser(user); return json(res, 200, auth.directory()); }
  if (p.startsWith('/api/admin/')) {
    requireSite(user, 'access.manage');
    const servers = Object.values(registry.servers);
    if (p === '/api/admin/access' && req.method === 'GET') {
      return json(res, 200, { ...auth.accessSnapshot(), servers: servers.map(s => ({ id: s.id, title: s.title, policy: auth.describePolicy(s.policy) })) });
    }
    if (p === '/api/admin/settings' && req.method === 'PATCH') { requireSite(user, 'site.admin'); return json(res, 200, await auth.adminSettings(await readJson(req))); }
    if (p === '/api/admin/users' && req.method === 'POST') return json(res, 201, await auth.adminCreateUser(user, await readJson(req)));
    if ((m = p.match(/^\/api\/admin\/(users|groups|roles)(?:\/([\w-]+))?$/))) {
      const [, kind, id] = m;
      if (req.method === 'DELETE' && id) {
        if (kind === 'users') await auth.adminDeleteUser(user, id);
        if (kind === 'groups') await auth.adminDeleteGroup(user, id, servers);
        if (kind === 'roles') await auth.adminDeleteRole(user, id, servers);
        return json(res, 200, { ok: true });
      }
      if ((req.method === 'PATCH' && id) || (req.method === 'POST' && !id)) {
        const body = await readJson(req);
        if (kind === 'users') return json(res, 200, await auth.adminUpdateUser(user, id, body));
        if (kind === 'groups') return json(res, 200, await auth.adminSaveGroup(user, id, body));
        if (kind === 'roles') return json(res, 200, await auth.adminSaveRole(user, id, body));
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  // ---- servers ----
  if (p === '/api/servers' && req.method === 'GET') {
    const list = await Promise.all(Object.values(registry.servers).map(async s => ({ ...serverView(s, user), live: await liveState(s.id).catch(() => null) })));
    return json(res, 200, list);
  }
  if (p === '/api/servers' && req.method === 'POST') return handleUpload(req, res, user, 'server');
  if ((m = p.match(/^\/api\/servers\/([a-z0-9-]+)$/)) && req.method === 'GET') {
    const s = registry.servers[m[1]]; if (!s) return json(res, 404, { error: 'not found' });
    const [live, status] = await Promise.all([liveState(s.id).catch(() => null), fetchStatus(s.id)]);
    return json(res, 200, { ...serverView(s, user, { detail: true }), live, status, client: s.client ? registry.clients[s.client] || { id: s.client } : null });
  }
  if ((m = p.match(/^\/api\/servers\/([a-z0-9-]+)\/policy$/)) && req.method === 'PUT') {
    const s = registry.servers[m[1]]; if (!s) return json(res, 404, { error: 'not found' });
    requireInstance(user, s, 'instance.policy');
    s.policy = auth.sanitizePolicy(await readJson(req));
    await saveRegistry();
    return json(res, 200, auth.describePolicy(s.policy));
  }
  if ((m = p.match(/^\/api\/servers\/([a-z0-9-]+)\/play-token$/)) && req.method === 'GET') {
    const s = registry.servers[m[1]]; if (!s) return json(res, 404, { error: 'not found' });
    requireUser(user); requireInstance(user, s, 'instance.join');
    return json(res, 200, { token: auth.playToken(user, s.id), expiresIn: 12 * 3600 });
  }
  if ((m = p.match(/^\/api\/servers\/([a-z0-9-]+)\/(start|stop|rebuild|logs|buildlog)$/))) {
    const [, id, action] = m; const s = registry.servers[id];
    if (!s) return json(res, 404, { error: 'not found' });
    if (action === 'buildlog' || action === 'logs') {
      requireInstance(user, s, 'instance.logs');
      if (action === 'buildlog') return json(res, 200, { state: s.state, error: s.error, lines: buildLogs[id] || [] });
      return json(res, 200, { text: await docker.logs(containerName(id)).catch(e => e.message) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
    requireInstance(user, s, 'instance.operate');
    if (action === 'rebuild') { deployServer(id); return json(res, 202, { ok: true }); }
    if (action === 'start') { if (s.database) await docker.start(dbName(id)); await docker.start(containerName(id)); s.state = 'running'; }
    if (action === 'stop') { await docker.stop(containerName(id)); if (s.database) await docker.stop(dbName(id)); s.state = 'stopped'; }
    await saveRegistry(); return json(res, 200, { ok: true });
  }
  if (p === '/api/clients' && req.method === 'GET') return json(res, 200, Object.values(registry.clients).map(({ createdBy, ...c }) => c));
  if (p === '/api/clients' && req.method === 'POST') return handleUpload(req, res, user, 'client');

  // ---- static ----
  if (p.startsWith('/clients/')) return serveFile(res, path.join(DATA, 'clients'), p.slice('/clients/'.length));
  if (/^\/details\/[a-z0-9-]+\/?$/.test(p)) return serveFile(res, PUBLIC, 'details.html');
  if (p === '/admin' || p === '/login' || p === '/account') return serveFile(res, PUBLIC, p.slice(1) + '.html');
  return serveFile(res, PUBLIC, p === '/' ? 'index.html' : p);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const p = decodeURIComponent(url.pathname);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE', 'access-control-allow-headers': '*' });
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return json(res, 403, { error: 'Cross-site request refused' });
    await route(req, res, url, p, auth.currentUser(req));
  } catch (e) {
    if (e instanceof auth.HttpError) return json(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

// WebSocket proxy: /play/<serverId>  ->  ws://vwa-<serverId>:<port>/
// The archive decides who may join (instance policy) and tells the world server who
// the player is with X-VWA-* headers; client-supplied X-VWA-* headers are dropped.
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://x');
  const m = url.pathname.match(/^\/play\/([a-z0-9-]+)/);
  const t = m && serverTarget(m[1]);
  const s = m && registry.servers[m[1]];
  if (!t || !s) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  const user = auth.currentUser(req) || (url.searchParams.get('token') ? auth.userFromPlayToken(url.searchParams.get('token'), s.id) : null);
  const perms = auth.instancePermissions(user, s);
  if (!perms.has('instance.join')) { socket.end(`HTTP/1.1 ${user ? '403 Forbidden' : '401 Unauthorized'}\r\n\r\n`); return; }
  const upstream = net.connect(t.port, t.host, () => {
    let headers = `GET / HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      if (/^(x-vwa-|cookie$)/i.test(k)) continue;
      headers += `${k}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    if (user) {
      headers += `X-VWA-User-Id: ${user.id}\r\nX-VWA-User-Name: ${encodeURIComponent(user.name)}\r\n`;
      headers += `X-VWA-Permissions: ${[...perms].join(',')}\r\n`;
    }
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
  await auth.init(DATA);
  server.listen(PORT, () => console.log(`[archive] http://localhost:${PORT}`));
  await seed().catch(e => console.error('[seed]', e));
  await reconcile().catch(e => console.error('[reconcile]', e));
})();
