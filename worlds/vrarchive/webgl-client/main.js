// Internet Archive VR: browser client for the Virtual World Archive.
// Loads the street and great hall models, walks with simple collision, and
// syncs avatars with the world server over WebSocket (see ../PROTOCOL.md).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const qs = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);

// ---------- server address ----------
function serverUrl() {
  if (qs.get('server')) return qs.get('server');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Served by the archive at /clients/<id>/ -> same-origin proxy at /play/<serverId>
  if (location.pathname.startsWith('/clients/')) return `${proto}//${location.host}/play/${qs.get('world') || 'vrarchive'}`;
  return `${proto}//${location.hostname || 'localhost'}:8080/play/vrarchive`;
}

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 2000);
scene.add(camera);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
});
scene.add(new THREE.HemisphereLight(0xffffff, 0x554433, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(40, 80, -60); scene.add(sun);

// ---------- world ----------
const world = await (await fetch('./world.json')).json();
const zones = {};       // name -> { group, colliders: [], def }
const portals = [];     // { def, mesh, label }
const loader = new GLTFLoader();
const rc = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);

function setStatus(t) { $('status').textContent = t; }

async function loadZone(name, def) {
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  const colliders = [];
  for (const url of def.models) {
    setStatus(`Loading ${url.split('/').pop()}…`);
    const g = await loader.loadAsync(url);
    g.scene.traverse(o => {
      if (o.isMesh) { o.geometry.computeBoundsTree(); colliders.push(o); }
    });
    group.add(g.scene);
  }
  if (def.ground) {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(def.ground.size, def.ground.size),
      new THREE.MeshLambertMaterial({ color: def.ground.color }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(def.spawn[0], def.ground.y - 0.01, def.spawn[2]);
    ground.geometry.computeBoundsTree(); group.add(ground); colliders.push(ground);
    // A simple street stripe so the space reads as Funston Ave.
    const road = new THREE.Mesh(new THREE.PlaneGeometry(def.ground.size, 12), new THREE.MeshLambertMaterial({ color: '#3b3b3e' }));
    road.rotation.x = -Math.PI / 2; road.position.set(def.spawn[0], def.ground.y, def.spawn[2] - 8); group.add(road);
  }
  group.updateMatrixWorld(true);
  zones[name] = { group, colliders, def };
}

function floorAt(zone, x, y, z, maxUp = 0.6) {
  rc.set(new THREE.Vector3(x, y + maxUp + 0.01, z), DOWN); rc.far = 50; rc.firstHitOnly = true;
  const h = rc.intersectObjects(zones[zone].colliders, false)[0];
  return h ? h.point.y : null;
}

function makePortal(def) {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(def.radius * 0.6, 0.08, 12, 48),
    new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.9 }));
  ring.position.y = 1.4; group.add(ring);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(def.radius * 0.6, 48),
    new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
  disc.position.y = 1.4; group.add(disc);
  const label = textSprite(def.label, '#66ccff'); label.position.y = 2.6; group.add(label);
  const y = floorAt(def.zone, def.pos[0], def.pos[1], def.pos[2], 1.0) ?? def.pos[1];
  group.position.set(def.pos[0], y, def.pos[2]);
  zones[def.zone].group.add(group);
  portals.push({ def, group, ring, disc });
}

function textSprite(text, color = '#fff', sub = '') {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.roundRect(6, 14, 500, sub ? 100 : 76, 18); g.fill();
  g.fillStyle = color; g.font = 'bold 44px sans-serif'; g.textAlign = 'center'; g.fillText(text, 256, 66);
  if (sub) { g.fillStyle = '#ccc'; g.font = '30px sans-serif'; g.fillText(sub, 256, 104); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(2, 0.5, 1); s.renderOrder = 10; return s;
}

for (const [name, def] of Object.entries(world.zones)) await loadZone(name, def);
for (const p of world.portals) makePortal(p);
setStatus('Ready');

// ---------- local player ----------
const me = { zone: 'street', pos: new THREE.Vector3(), ry: 0, pitch: 0, vy: 0, id: null, name: '' };
const EYE = 1.6;

function enterZone(name, at, ry) {
  for (const [n, z] of Object.entries(zones)) z.group.visible = n === name;
  me.zone = name;
  const def = world.zones[name];
  scene.background = new THREE.Color(def.sky);
  const p = at || def.spawn;
  // Spread arrivals out a little so players do not stand inside each other.
  me.pos.set(p[0] + (Math.random() - 0.5) * 3, p[1], p[2] + (Math.random() - 0.5) * 3);
  const f = floorAt(name, me.pos.x, p[1], me.pos.z, 1.5); if (f !== null) me.pos.y = f;
  me.ry = ry ?? def.spawnRy ?? 0; me.pitch = 0; me.vy = 0;
  $('hud-zone').innerHTML = `${def.label}<small>${world.title}</small>`;
  for (const r of remotes.values()) r.group.visible = r.zone === me.zone;
  sendMove(true);
}

// ---------- input ----------
const keys = new Set();
const chatin = $('chatin');
addEventListener('keydown', e => {
  if (document.activeElement === chatin) {
    if (e.key === 'Enter') { const t = chatin.value.trim(); if (t) send({ t: 'chat', text: t }); chatin.value = ''; chatin.blur(); }
    if (e.key === 'Escape') chatin.blur();
    return;
  }
  if (document.activeElement === $('nameinput')) return;
  if (e.key === 'Enter') { document.exitPointerLock?.(); chatin.focus(); e.preventDefault(); return; }
  keys.add(e.code);
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock?.());
let dragging = false, lastX = 0, lastY = 0;
renderer.domElement.addEventListener('mousedown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
addEventListener('mouseup', () => (dragging = false));
addEventListener('mousemove', e => {
  let dx = 0, dy = 0;
  if (document.pointerLockElement === renderer.domElement) { dx = e.movementX; dy = e.movementY; }
  else if (dragging) { dx = e.clientX - lastX; dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; }
  me.ry -= dx * 0.0025; me.pitch = Math.max(-1.4, Math.min(1.4, me.pitch - dy * 0.0025));
});

// ---------- movement with collision ----------
const tmpV = new THREE.Vector3();
function blocked(from, dir, dist) {
  // Chest-height ray only, so scanned clutter on the floor does not trap players.
  rc.set(tmpV.set(from.x, from.y + 1.1, from.z), dir); rc.far = dist + 0.35; rc.firstHitOnly = true;
  return rc.intersectObjects(zones[me.zone].colliders, false).length > 0;
}
function step(dt) {
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? 7 : 3.2;
  let f = 0, s = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyA')) s -= 1;
  if (keys.has('KeyD')) s += 1;
  if (keys.has('ArrowLeft')) me.ry += 2 * dt;
  if (keys.has('ArrowRight')) me.ry -= 2 * dt;
  const fwd = new THREE.Vector3(-Math.sin(me.ry), 0, -Math.cos(me.ry));
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const move = fwd.multiplyScalar(f).add(right.multiplyScalar(s));
  if (move.lengthSq() > 0) {
    move.normalize().multiplyScalar(speed * dt);
    // Try full move, then slide along each axis.
    for (const m of [move, new THREE.Vector3(move.x, 0, 0), new THREE.Vector3(0, 0, move.z)]) {
      const d = m.length(); if (d < 1e-5) continue;
      if (!blocked(me.pos, m.clone().normalize(), d)) { me.pos.add(m); break; }
    }
  }
  // Ground follow: step up to 0.6 m, fall with gravity otherwise.
  const floor = floorAt(me.zone, me.pos.x, me.pos.y, me.pos.z);
  if (floor !== null && floor >= me.pos.y - 0.05) { me.pos.y = floor; me.vy = 0; }
  else {
    me.vy -= 18 * dt; me.pos.y += me.vy * dt;
    if (floor !== null && me.pos.y < floor) { me.pos.y = floor; me.vy = 0; }
    if (me.pos.y < -30) enterZone(me.zone);
  }
  camera.position.set(me.pos.x, me.pos.y + EYE, me.pos.z);
  camera.rotation.set(me.pitch, me.ry, 0, 'YXZ');

  // Portals
  let near = null;
  for (const p of portals) {
    if (p.def.zone !== me.zone) continue;
    const dx = me.pos.x - p.group.position.x, dz = me.pos.z - p.group.position.z;
    const d = Math.hypot(dx, dz);
    if (d < p.def.radius) { const target = p.def.to; enterZone(target, p.def.arriveAt); return; }
    if (d < p.def.radius * 4) near = p;
  }
  const pr = $('prompt');
  if (near) { pr.style.display = 'block'; pr.textContent = `${near.def.label} ↑`; } else pr.style.display = 'none';
}

// ---------- remote avatars ----------
const remotes = new Map(); // id -> { group, target, zone, info }
function makeAvatar(p) {
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: p.color });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.9, 6, 12), mat); body.position.y = 0.75; group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), mat); head.position.y = 1.55; group.add(head);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.12), new THREE.MeshBasicMaterial({ color: 0x111111 }));
  visor.position.set(0, 1.58, -0.18); group.add(visor);
  const label = textSprite(p.name, '#fff', p.platform === 'unity' ? 'Unity client' : p.platform === 'webgl' ? 'WebGL client' : p.platform);
  label.position.y = 2.25; group.add(label);
  scene.add(group);
  return { group, label, target: new THREE.Vector3(...p.p), targetRy: p.ry, zone: p.zone, info: p };
}
function upsertRemote(p) {
  if (p.id === me.id) return;
  let r = remotes.get(p.id);
  if (!r) { r = makeAvatar(p); r.group.position.set(...p.p); remotes.set(p.id, r); renderPlayers(); }
  r.target.set(...p.p); r.targetRy = p.ry;
  if (r.zone !== p.zone) { r.zone = p.zone; r.group.position.set(...p.p); renderPlayers(); }
  r.info = p;
  // Zones are separate spaces: only show avatars that share our zone.
  r.group.visible = r.zone === me.zone;
}
function removeRemote(id) {
  const r = remotes.get(id); if (!r) return;
  scene.remove(r.group); remotes.delete(id); renderPlayers();
}
function lerpAngle(a, b, t) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * t; }
function renderPlayers() {
  const rows = [`<div><span class="dot" style="background:#fff"></span>${esc(me.name)} (you)<span class="tag webgl">WebGL</span></div>`];
  for (const r of remotes.values()) {
    const zl = r.zone === 'hall' ? 'hall' : 'street';
    rows.push(`<div><span class="dot" style="background:${r.info.color}"></span>${esc(r.info.name)}<span class="tag ${r.info.platform}">${esc(r.info.platform)}</span> <small style="opacity:.7">${zl}</small></div>`);
  }
  $('plist').innerHTML = rows.join('');
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function chatLine(name, text, color = '#9cf') {
  const d = document.createElement('div'); d.innerHTML = `<b style="color:${color}">${esc(name)}:</b> ${esc(text)}`;
  $('log').appendChild(d); $('log').scrollTop = 1e9;
}

// ---------- network ----------
let ws = null, lastSent = 0, lastSentKey = '';
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function sendMove(force) {
  const now = performance.now();
  const p = [+me.pos.x.toFixed(3), +me.pos.y.toFixed(3), +me.pos.z.toFixed(3)];
  const key = me.zone + p.join(',') + me.ry.toFixed(2);
  if (!force && (now - lastSent < 100 || key === lastSentKey)) return;
  lastSent = now; lastSentKey = key;
  send({ t: 'move', zone: me.zone, p, ry: +me.ry.toFixed(3) });
}
function connect() {
  const url = serverUrl();
  $('net').textContent = `connecting to ${url}`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    $('net').textContent = 'connected';
    send({ t: 'hello', name: me.name, platform: 'webgl', zone: me.zone });
  };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') { me.id = m.id; m.players.forEach(upsertRemote); sendMove(true); chatLine('server', `Welcome to ${m.world}. You are player #${m.id}.`, '#fc6'); }
    else if (m.t === 'join') { upsertRemote(m.player); chatLine('server', `${m.player.name} joined from ${m.player.platform}`, '#fc6'); }
    else if (m.t === 'leave') { const r = remotes.get(m.id); if (r) chatLine('server', `${r.info.name} left`, '#fc6'); removeRemote(m.id); }
    else if (m.t === 'snapshot') {
      const seen = new Set();
      for (const p of m.players) { seen.add(p.id); upsertRemote(p); }
      for (const id of [...remotes.keys()]) if (!seen.has(id)) removeRemote(id);
      $('net').textContent = `connected · ${m.players.length} online`;
    }
    else if (m.t === 'chat') chatLine(m.name, m.text, m.platform === 'unity' ? '#7d7' : '#9cf');
  };
  ws.onclose = () => {
    $('net').textContent = 'disconnected, retrying…';
    for (const id of [...remotes.keys()]) removeRemote(id);
    setTimeout(connect, 2000);
  };
}

// ---------- start ----------
$('nameinput').value = qs.get('name') || localStorage.getItem('vwa-name') || '';
function begin(e) {
  e?.preventDefault();
  me.name = $('nameinput').value.trim() || `Visitor ${Math.floor(Math.random() * 900 + 100)}`;
  try { localStorage.setItem('vwa-name', me.name); } catch {}
  $('start').style.display = 'none';
  enterZone(qs.get('zone') === 'hall' ? 'hall' : 'street');
  renderPlayers();
  connect();
}
$('startform').addEventListener('submit', begin);
if (qs.get('autostart') || window.__vwaWantStart) begin();
else { enterZone('street'); $('nameinput').focus(); }

// Hooks for automated tests.
window.vwa = { me, remotes, keys, enterZone, send };

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if ($('start').style.display === 'none') { step(dt); sendMove(false); }
  else { camera.position.set(me.pos.x, me.pos.y + EYE, me.pos.z); camera.rotation.set(0, me.ry, 0, 'YXZ'); }
  const t = Math.min(1, dt * 10);
  for (const r of remotes.values()) {
    r.group.position.lerp(r.target, t);
    r.group.rotation.y = lerpAngle(r.group.rotation.y, r.targetRy, t);
  }
  const pulse = 1 + Math.sin(performance.now() / 300) * 0.06;
  for (const p of portals) { p.ring.scale.setScalar(pulse); p.ring.rotation.y += dt; p.disc.rotation.y = p.ring.rotation.y; }
  renderer.render(scene, camera);
});
