// Accounts, sessions, Google sign-in, and role-based access control.
//
// Model
//   permissions  fixed catalog below; "site" permissions apply archive-wide,
//                "instance" permissions apply to one server instance.
//   roles        named sets of permissions, editable by the Site Admin.
//   groups       sets of users; a group can hold site roles.
//   users        local accounts (email + password) and/or Google accounts.
//   policy       per server: mode (open | managed), who may join, and bindings
//                of {group, role}. In a Managed Server Instance only members of
//                bound groups get the role's instance permissions.
//
// Everything is stored in DATA/auth.json next to the server registry.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const SITE_PERMISSIONS = {
  'site.admin': 'Site Admin: full control of the archive',
  'access.manage': 'Manage users, groups and roles',
  'servers.play': 'Play worlds open to members or the public',
  'servers.upload': 'Upload new game servers',
  'clients.upload': 'Upload web clients',
  'servers.manage': 'Operate and configure open (unmanaged) servers',
  'servers.logs': 'View logs of open servers',
};
const INSTANCE_PERMISSIONS = {
  'instance.join': 'Join the instance (needed when access is restricted)',
  'instance.logs': 'View server and build logs',
  'instance.operate': 'Start, stop and rebuild the server',
  'instance.configure': 'Upload new server packages or clients, edit details',
  'instance.policy': 'Edit the instance policy and who administers it',
};
const ALL_INSTANCE = Object.keys(INSTANCE_PERMISSIONS);
const PERMISSIONS = { ...SITE_PERMISSIONS, ...INSTANCE_PERMISSIONS };

const BUILTIN_ROLES = [
  { id: 'site-admin', name: 'Site Admin', description: 'Can do everything, including managing access.', permissions: ['site.admin'], builtin: true, locked: true },
  { id: 'guest', name: 'Guest', description: 'Applies to everyone, signed in or not.', permissions: ['servers.play'], builtin: true },
  { id: 'member', name: 'Member', description: 'Applies to every signed-in user.', permissions: ['servers.play'], builtin: true },
  { id: 'curator', name: 'Curator', description: 'Uploads and runs open worlds.', permissions: ['servers.upload', 'clients.upload', 'servers.manage', 'servers.logs'] },
  { id: 'instance-admin', name: 'Instance Admin', description: 'Full control of a server instance it is bound to.', permissions: [...ALL_INSTANCE] },
  { id: 'instance-operator', name: 'Instance Operator', description: 'Starts, stops and reads logs of a bound instance.', permissions: ['instance.join', 'instance.logs', 'instance.operate'] },
  { id: 'instance-player', name: 'Instance Player', description: 'May join a bound instance with restricted access.', permissions: ['instance.join'] },
];

const SESSION_TTL = 30 * 24 * 3600 * 1000;
const PLAY_TOKEN_TTL = 12 * 3600 * 1000;

let FILE = null;
let db = null;
let secret = null;

const now = () => new Date().toISOString();
const newId = p => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = e => String(e || '').trim().toLowerCase();
const cleanText = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

// ---------------- storage ----------------
async function init(dataDir) {
  FILE = path.join(dataDir, 'auth.json');
  try { db = JSON.parse(await fsp.readFile(FILE, 'utf8')); } catch { db = {}; }
  db.users ||= {}; db.groups ||= {}; db.roles ||= {}; db.sessions ||= {};
  db.settings ||= { registration: process.env.ALLOW_REGISTRATION !== '0' };
  for (const r of BUILTIN_ROLES) {
    if (!db.roles[r.id]) db.roles[r.id] = { ...r, createdAt: now() };
    else Object.assign(db.roles[r.id], { builtin: r.builtin, locked: r.locked }, r.locked ? { permissions: r.permissions } : {});
  }
  // Secret for play tokens and OAuth state: env, else generated once and kept in the data volume.
  secret = process.env.SESSION_SECRET;
  if (!secret) {
    const f = path.join(dataDir, 'session-secret');
    try { secret = (await fsp.readFile(f, 'utf8')).trim(); } catch {}
    if (!secret) { secret = crypto.randomBytes(32).toString('hex'); await fsp.writeFile(f, secret, { mode: 0o600 }); }
  }
  // Bootstrap Site Admin from ADMIN_EMAIL / ADMIN_PASSWORD (deploy.sh generates the password).
  if (process.env.ADMIN_PASSWORD) {
    const email = normEmail(process.env.ADMIN_EMAIL || 'admin@localhost');
    let u = findByEmail(email);
    if (!u) {
      u = await createUser({ email, name: 'Site Admin', password: process.env.ADMIN_PASSWORD, roles: ['site-admin'] });
      console.log(`[auth] created Site Admin account ${email}`);
    } else if (!u.roles.includes('site-admin')) u.roles.push('site-admin');
  }
  for (const [h, s] of Object.entries(db.sessions)) if (s.expires < Date.now()) delete db.sessions[h];
  await save();
}

let saving = Promise.resolve();
function save() {
  saving = saving.then(async () => {
    await fsp.writeFile(FILE + '.tmp', JSON.stringify(db, null, 2), { mode: 0o600 });
    await fsp.rename(FILE + '.tmp', FILE);
  }).catch(e => console.error('[auth] save failed', e));
  return saving;
}

// ---------------- passwords ----------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(`scrypt$${salt.toString('hex')}$${k.toString('hex')}`)));
}
function checkPassword(pw, stored) {
  return new Promise(res => {
    const [alg, salt, hash] = String(stored || '').split('$');
    if (alg !== 'scrypt' || !salt || !hash) { crypto.scrypt(pw || '', 'x', 64, () => res(false)); return; }
    crypto.scrypt(pw || '', Buffer.from(salt, 'hex'), 64, (e, k) => res(!e && crypto.timingSafeEqual(k, Buffer.from(hash, 'hex'))));
  });
}
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) fail(400, 'Password must be at least 8 characters');
  if (pw.length > 200) fail(400, 'Password is too long');
}

// ---------------- users ----------------
const findByEmail = email => Object.values(db.users).find(u => u.email === normEmail(email));
const findByGoogle = sub => Object.values(db.users).find(u => u.googleSub === sub);
const validEmail = e => /^[^\s@]+@[^\s@]+$/.test(e) && e.length <= 200;

async function createUser({ email, name, password, googleSub, roles = [], groups = [] }) {
  email = normEmail(email);
  if (!validEmail(email)) fail(400, 'Enter a valid email address');
  if (findByEmail(email)) fail(409, 'An account with this email already exists');
  if (password != null) validatePassword(password);
  const firstUser = Object.keys(db.users).length === 0 && !process.env.ADMIN_PASSWORD;
  const u = {
    id: newId('u'), email, name: cleanText(name) || email.split('@')[0],
    passwordHash: password != null ? await hashPassword(password) : null,
    googleSub: googleSub || null,
    roles: [...new Set([...roles.filter(r => db.roles[r]), ...(firstUser ? ['site-admin'] : [])])],
    disabled: false, createdAt: now(), lastLogin: null,
  };
  db.users[u.id] = u;
  for (const g of groups) if (db.groups[g] && !db.groups[g].members.includes(u.id)) db.groups[g].members.push(u.id);
  if (firstUser) console.log(`[auth] first account ${email} is Site Admin`);
  await save();
  return u;
}

function publicUser(u, { full = false } = {}) {
  if (!u) return null;
  const base = { id: u.id, email: u.email, name: u.name };
  if (!full) return base;
  return { ...base, roles: u.roles, groups: groupsOf(u).map(g => g.id), disabled: u.disabled, google: !!u.googleSub,
    password: !!u.passwordHash, createdAt: u.createdAt, lastLogin: u.lastLogin };
}

// ---------------- sessions ----------------
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.startsWith('https:');
  return req.headers['x-forwarded-proto'] === 'https';
}
function cookie(req, name, value, maxAgeS) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${isHttps(req) ? '; Secure' : ''}`;
}

async function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions[sha256(token)] = { userId: user.id, expires: Date.now() + SESSION_TTL, createdAt: now() };
  user.lastLogin = now();
  await save();
  res.setHeader('set-cookie', cookie(req, 'vwa_session', token, SESSION_TTL / 1000));
}
async function endSession(req, res) {
  const t = parseCookies(req).vwa_session;
  if (t) { delete db.sessions[sha256(t)]; await save(); }
  res.setHeader('set-cookie', cookie(req, 'vwa_session', '', 0));
}
function currentUser(req) {
  const t = parseCookies(req).vwa_session;
  if (!t) return null;
  const s = db.sessions[sha256(t)];
  if (!s || s.expires < Date.now()) return null;
  const u = db.users[s.userId];
  return u && !u.disabled ? u : null;
}

// ---------------- login throttling ----------------
const attempts = new Map();
function throttle(key) {
  const a = attempts.get(key);
  if (a && a.count >= 8 && a.until > Date.now()) fail(429, 'Too many attempts. Try again in a few minutes.');
}
function noteFailure(key) {
  const a = attempts.get(key) || { count: 0, until: 0 };
  if (a.until < Date.now()) a.count = 0;
  a.count++; a.until = Date.now() + 15 * 60 * 1000; attempts.set(key, a);
}

async function login(req, res, { email, password }) {
  const key = `${req.socket.remoteAddress}|${normEmail(email)}`;
  throttle(key);
  const u = findByEmail(email);
  const ok = await checkPassword(password, u && u.passwordHash);
  if (!u || !ok) { noteFailure(key); fail(401, 'Wrong email or password'); }
  if (u.disabled) fail(403, 'This account is disabled');
  attempts.delete(key);
  await startSession(req, res, u);
  return u;
}

async function register(req, res, { email, name, password }) {
  if (!db.settings.registration && Object.keys(db.users).length > 0) fail(403, 'Registration is closed. Ask the Site Admin for an account.');
  validatePassword(password);
  const u = await createUser({ email, name, password });
  await startSession(req, res, u);
  return u;
}

// ---------------- Google sign-in (OAuth 2.0 authorization code + PKCE) ----------------
const googleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const pendingOAuth = new Map(); // state -> { verifier, next, linkUserId, expires }

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  return `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
}
const safeNext = n => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.includes('\\')) ? n : '/';

function googleStart(req, res, url) {
  if (!googleEnabled()) fail(404, 'Google sign-in is not configured');
  const state = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const link = url.searchParams.get('link') === '1' ? currentUser(req) : null;
  for (const [k, v] of pendingOAuth) if (v.expires < Date.now()) pendingOAuth.delete(k);
  pendingOAuth.set(state, { verifier, next: safeNext(url.searchParams.get('next')), linkUserId: link && link.id, expires: Date.now() + 10 * 60 * 1000 });
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: `${baseUrl(req)}/auth/google/callback`,
    response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  res.writeHead(302, { location: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, 'set-cookie': cookie(req, 'vwa_oauth', state, 600) });
  res.end();
}

async function googleCallback(req, res, url) {
  const back = (msg, next = '/login.html') => {
    res.writeHead(302, { location: msg ? `/login.html?error=${encodeURIComponent(msg)}` : next, 'set-cookie': cookie(req, 'vwa_oauth', '', 0) });
    res.end();
  };
  const state = url.searchParams.get('state');
  const p = state && pendingOAuth.get(state);
  if (!p || p.expires < Date.now() || parseCookies(req).vwa_oauth !== state) return back('Sign-in expired, please try again.');
  pendingOAuth.delete(state);
  if (url.searchParams.get('error')) return back('Google sign-in was cancelled.');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') || '', client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${baseUrl(req)}/auth/google/callback`, grant_type: 'authorization_code', code_verifier: p.verifier,
    }),
  });
  const tok = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tok.access_token) { console.error('[auth] google token exchange failed', tok.error, tok.error_description); return back('Google sign-in failed.'); }
  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } });
  const info = await infoRes.json().catch(() => ({}));
  if (!infoRes.ok || !info.sub || !info.email || info.email_verified === false) return back('Google did not return a verified email.');
  const domains = (process.env.GOOGLE_ALLOWED_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (domains.length && !domains.includes(normEmail(info.email).split('@')[1])) return back('That Google account is not allowed on this archive.');

  let u;
  if (p.linkUserId) {
    u = db.users[p.linkUserId];
    const other = findByGoogle(info.sub);
    if (!u) return back('Sign in first, then link Google.');
    if (other && other.id !== u.id) return back('That Google account is already linked to another user.');
    u.googleSub = info.sub;
  } else {
    u = findByGoogle(info.sub);
    if (!u) {
      const existing = findByEmail(info.email);
      // Never auto-link to a password account: its email was never verified, so someone
      // could have registered it first. The owner links Google from their account page.
      if (existing) return back('An account with this email already exists. Sign in with your password, then link Google on your account page.');
      if (!db.settings.registration && Object.keys(db.users).length > 0) return back('Registration is closed. Ask the Site Admin for an account.');
      u = await createUser({ email: info.email, name: info.name, googleSub: info.sub });
    }
  }
  if (u.disabled) return back('This account is disabled.');
  // ADMIN_EMAILS: Google-verified addresses that are always Site Admin.
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(normEmail).filter(Boolean);
  if (admins.includes(normEmail(info.email)) && normEmail(info.email) === u.email && !u.roles.includes('site-admin')) u.roles.push('site-admin');
  await startSession(req, res, u);
  const cookies = [res.getHeader('set-cookie'), cookie(req, 'vwa_oauth', '', 0)];
  res.writeHead(302, { location: p.linkUserId ? '/account.html?linked=1' : p.next, 'set-cookie': cookies });
  res.end();
}

// ---------------- permissions ----------------
const groupsOf = u => u ? Object.values(db.groups).filter(g => g.members.includes(u.id)) : [];
const rolePerms = (ids, keep) => ids.flatMap(id => (db.roles[id] ? db.roles[id].permissions : [])).filter(keep);
const isSitePerm = p => p in SITE_PERMISSIONS;
const isInstancePerm = p => p in INSTANCE_PERMISSIONS;

function sitePermissions(u) {
  const roleIds = ['guest'];
  if (u) roleIds.push('member', ...u.roles, ...groupsOf(u).flatMap(g => g.roles));
  const set = new Set(rolePerms(roleIds, isSitePerm));
  if (set.has('site.admin')) Object.keys(SITE_PERMISSIONS).forEach(p => set.add(p));
  return set;
}
const can = (u, perm) => sitePermissions(u).has(perm);

function defaultPolicy() { return { mode: 'open', access: 'public', bindings: [] }; }

// Instance permissions a user holds on one server.
function instancePermissions(u, server) {
  const pol = server.policy || defaultPolicy();
  const site = sitePermissions(u);
  const set = new Set();
  // Bindings: members of the group get the role's instance permissions (open and managed).
  const mine = new Set(groupsOf(u).map(g => g.id));
  for (const b of pol.bindings || []) if (mine.has(b.group)) rolePerms([b.role], isInstancePerm).forEach(p => set.add(p));
  if (site.has('site.admin')) {
    // Site Admin keeps the policy so a managed instance can't be orphaned; in open mode it has everything.
    set.add('instance.policy'); set.add('instance.join');
    if (pol.mode !== 'managed') ALL_INSTANCE.forEach(p => set.add(p));
  }
  if (pol.mode !== 'managed') {
    if (site.has('servers.logs')) set.add('instance.logs');
    if (site.has('servers.manage')) ALL_INSTANCE.forEach(p => set.add(p));
    if (u && server.createdBy === u.id) ALL_INSTANCE.forEach(p => set.add(p)); // uploader owns an open server
  }
  // Who may join.
  const access = pol.access || 'public';
  if (site.has('servers.play') && (access === 'public' || (access === 'members' && u))) set.add('instance.join');
  return set;
}

function sanitizePolicy(input) {
  const mode = input.mode === 'managed' ? 'managed' : 'open';
  const access = ['public', 'members', 'restricted'].includes(input.access) ? input.access : 'public';
  const seen = new Set(), bindings = [];
  for (const b of Array.isArray(input.bindings) ? input.bindings : []) {
    if (!b || !db.groups[b.group] || !db.roles[b.role]) fail(400, 'Each binding needs an existing group and role');
    if (!db.roles[b.role].permissions.some(isInstancePerm)) fail(400, `Role "${db.roles[b.role].name}" has no instance permissions`);
    const k = `${b.group}|${b.role}`; if (!seen.has(k)) { seen.add(k); bindings.push({ group: b.group, role: b.role }); }
  }
  if (mode === 'managed' && !bindings.some(b => db.roles[b.role].permissions.includes('instance.policy') || db.roles[b.role].permissions.includes('instance.operate')))
    fail(400, 'A Managed Server Instance needs at least one group bound to a role that can operate it or edit its policy');
  return { mode, access, bindings };
}

function describePolicy(pol) {
  pol = pol || defaultPolicy();
  return { ...pol, bindings: (pol.bindings || []).map(b => ({ ...b,
    groupName: db.groups[b.group] ? db.groups[b.group].name : '(deleted group)',
    roleName: db.roles[b.role] ? db.roles[b.role].name : '(deleted role)',
    members: db.groups[b.group] ? db.groups[b.group].members.length : 0 })) };
}

// ---------------- play tokens (for clients without cookies, e.g. Unity) ----------------
function playToken(u, serverId) {
  const body = `${u.id}.${serverId}.${Date.now() + PLAY_TOKEN_TTL}`;
  return `${Buffer.from(body).toString('base64url')}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}
function userFromPlayToken(token, serverId) {
  const [b, sig] = String(token || '').split('.');
  if (!b || !sig) return null;
  const body = Buffer.from(b, 'base64url').toString();
  const want = crypto.createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  const [uid, sid, exp] = body.split('.');
  if (sid !== serverId || Number(exp) < Date.now()) return null;
  const u = db.users[uid];
  return u && !u.disabled ? u : null;
}

// ---------------- admin: users, groups, roles ----------------
function accessSnapshot() {
  return {
    users: Object.values(db.users).map(u => publicUser(u, { full: true })),
    groups: Object.values(db.groups),
    roles: Object.values(db.roles),
    permissions: { site: SITE_PERMISSIONS, instance: INSTANCE_PERMISSIONS },
    settings: { ...db.settings, google: googleEnabled() },
  };
}
// Groups and roles that policy editors may pick from (no member lists).
function directory() {
  return {
    groups: Object.values(db.groups).map(g => ({ id: g.id, name: g.name, members: g.members.length })),
    // instance: the role's instance permissions; roles without any can't be bound to a server.
    roles: Object.values(db.roles).map(r => ({ id: r.id, name: r.name, instance: r.permissions.filter(isInstancePerm) })),
    permissions: INSTANCE_PERMISSIONS,
  };
}

const siteAdmins = () => Object.values(db.users).filter(u => !u.disabled && sitePermissions(u).has('site.admin'));
// Apply a change to users/groups/roles; roll it back if it fails or would leave no active Site Admin.
function guardLastAdmin(fn) {
  const before = siteAdmins().length;
  const snapshot = JSON.stringify({ users: db.users, groups: db.groups, roles: db.roles });
  const restore = () => { const s = JSON.parse(snapshot); db.users = s.users; db.groups = s.groups; db.roles = s.roles; };
  try { fn(); } catch (e) { restore(); throw e; }
  if (before > 0 && siteAdmins().length === 0) { restore(); fail(400, 'That would leave the archive without an active Site Admin'); }
}
const validRoles = ids => [...new Set((ids || []).filter(r => db.roles[r] && r !== 'guest' && r !== 'member'))];

async function adminCreateUser(actor, body) {
  // Only a Site Admin may hand out Site Admin.
  let roles = validRoles(body.roles);
  if (roles.includes('site-admin') && !can(actor, 'site.admin')) fail(403, 'Only a Site Admin can grant Site Admin');
  const u = await createUser({ email: body.email, name: body.name, password: body.password || null, roles, groups: (body.groups || []).filter(g => db.groups[g]) });
  return publicUser(u, { full: true });
}

async function adminUpdateUser(actor, id, body) {
  const u = db.users[id]; if (!u) fail(404, 'No such user');
  const admin = can(actor, 'site.admin');
  if (!admin && sitePermissions(u).has('site.admin')) fail(403, 'Only a Site Admin can change a Site Admin');
  let hash = null;
  if (body.password) { validatePassword(body.password); hash = await hashPassword(body.password); }
  guardLastAdmin(() => {
    if (body.name != null) u.name = cleanText(body.name) || u.name;
    if (body.roles) {
      const roles = validRoles(body.roles);
      if (!admin && roles.includes('site-admin') !== u.roles.includes('site-admin')) fail(403, 'Only a Site Admin can grant or remove Site Admin');
      u.roles = roles;
    }
    if (body.groups) {
      const want = new Set(body.groups.filter(g => db.groups[g]));
      for (const g of Object.values(db.groups)) {
        if (!admin && g.roles.includes('site-admin') && want.has(g.id) !== g.members.includes(u.id)) fail(403, 'Only a Site Admin can change membership of a group with Site Admin');
        g.members = g.members.filter(m => m !== u.id);
        if (want.has(g.id)) g.members.push(u.id);
      }
    }
    if (body.disabled != null) u.disabled = !!body.disabled;
    if (hash) u.passwordHash = hash;
  });
  if (u.disabled || hash) for (const [h, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[h];
  await save();
  return publicUser(u, { full: true });
}

async function adminDeleteUser(actor, id) {
  const u = db.users[id]; if (!u) fail(404, 'No such user');
  if (actor.id === id) fail(400, 'You cannot delete your own account');
  if (!can(actor, 'site.admin') && sitePermissions(u).has('site.admin')) fail(403, 'Only a Site Admin can delete a Site Admin');
  guardLastAdmin(() => {
    delete db.users[id];
    for (const g of Object.values(db.groups)) g.members = g.members.filter(m => m !== id);
  });
  for (const [h, s] of Object.entries(db.sessions)) if (s.userId === id) delete db.sessions[h];
  await save();
}

async function adminSaveGroup(actor, id, body) {
  const admin = can(actor, 'site.admin');
  const g = id ? db.groups[id] : { id: slug(body.name) || newId('g'), members: [], roles: [], createdAt: now() };
  if (!g) fail(404, 'No such group');
  if (!id && db.groups[g.id]) g.id = newId('g');
  const touchesAdmin = (g.roles.includes('site-admin') || (body.roles || []).includes('site-admin'));
  if (!admin && touchesAdmin) fail(403, 'Only a Site Admin can change a group with Site Admin');
  guardLastAdmin(() => {
    if (body.name != null) { g.name = cleanText(body.name); if (!g.name) fail(400, 'Group needs a name'); }
    if (body.description != null) g.description = cleanText(body.description, 300);
    if (body.roles) g.roles = validRoles(body.roles);
    if (body.members) g.members = [...new Set(body.members.filter(m => db.users[m]))];
    db.groups[g.id] = g;
  });
  await save();
  return g;
}

async function adminDeleteGroup(actor, id, servers) {
  const g = db.groups[id]; if (!g) fail(404, 'No such group');
  if (!can(actor, 'site.admin') && g.roles.includes('site-admin')) fail(403, 'Only a Site Admin can delete a group with Site Admin');
  const used = servers.filter(s => (s.policy?.bindings || []).some(b => b.group === id));
  if (used.length) fail(409, `Group is bound in the policy of: ${used.map(s => s.id).join(', ')}`);
  guardLastAdmin(() => { delete db.groups[id]; });
  await save();
}

async function adminSaveRole(actor, id, body) {
  const r = id ? db.roles[id] : { id: slug(body.name) || newId('r'), permissions: [], createdAt: now() };
  if (!r) fail(404, 'No such role');
  if (!id && db.roles[r.id]) r.id = newId('r');
  if (r.locked) fail(400, 'The Site Admin role cannot be changed');
  const admin = can(actor, 'site.admin');
  let perms = null;
  if (body.permissions) {
    perms = [...new Set(body.permissions.filter(p => p in PERMISSIONS))];
    if (!admin && r.permissions.includes('site.admin') !== perms.includes('site.admin')) fail(403, 'Only a Site Admin can grant or remove site.admin');
  }
  guardLastAdmin(() => {
    if (perms) r.permissions = perms;
    if (body.name != null) { r.name = cleanText(body.name); if (!r.name) fail(400, 'Role needs a name'); }
    if (body.description != null) r.description = cleanText(body.description, 300);
    db.roles[r.id] = r;
  });
  await save();
  return db.roles[r.id];
}

async function adminDeleteRole(actor, id, servers) {
  const r = db.roles[id]; if (!r) fail(404, 'No such role');
  if (r.builtin) fail(400, 'Built-in roles cannot be deleted');
  if (!can(actor, 'site.admin') && r.permissions.includes('site.admin')) fail(403, 'Only a Site Admin can delete that role');
  const used = servers.filter(s => (s.policy?.bindings || []).some(b => b.role === id));
  if (used.length) fail(409, `Role is bound in the policy of: ${used.map(s => s.id).join(', ')}`);
  guardLastAdmin(() => {
    delete db.roles[id];
    for (const u of Object.values(db.users)) u.roles = u.roles.filter(x => x !== id);
    for (const g of Object.values(db.groups)) g.roles = g.roles.filter(x => x !== id);
  });
  await save();
}

async function adminSettings(body) {
  if (body.registration != null) db.settings.registration = !!body.registration;
  await save();
  return db.settings;
}

async function updateProfile(u, { name, currentPassword, newPassword }) {
  if (name != null) u.name = cleanText(name) || u.name;
  if (newPassword) {
    if (u.passwordHash && !(await checkPassword(currentPassword, u.passwordHash))) fail(401, 'Current password is wrong');
    validatePassword(newPassword);
    u.passwordHash = await hashPassword(newPassword);
  }
  await save();
  return u;
}

module.exports = {
  HttpError, init, currentUser, login, register, endSession, googleEnabled, googleStart, googleCallback,
  sitePermissions, can, instancePermissions, sanitizePolicy, describePolicy, defaultPolicy, groupsOf,
  playToken, userFromPlayToken, publicUser, accessSnapshot, directory, updateProfile,
  adminCreateUser, adminUpdateUser, adminDeleteUser, adminSaveGroup, adminDeleteGroup, adminSaveRole, adminDeleteRole, adminSettings,
  settings: () => db.settings, SITE_PERMISSIONS, INSTANCE_PERMISSIONS,
};
