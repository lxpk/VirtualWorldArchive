// Minimal Docker Engine API client over the unix socket (no dependencies).
const http = require('http');

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const API = '/v1.43';

function request(method, path, { body, headers = {}, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const isStream = body && typeof body.pipe === 'function';
    const data = body && !isStream ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      socketPath: SOCKET, method, path: API + path,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length, ...headers } : headers,
    }, res => {
      if (stream) return resolve(res);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString();
        if (res.statusCode >= 400) {
          let msg = text; try { msg = JSON.parse(text).message; } catch {}
          const err = new Error(`docker ${method} ${path}: ${res.statusCode} ${msg}`);
          err.status = res.statusCode; return reject(err);
        }
        let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, json, raw: buf });
      });
    });
    req.on('error', reject);
    if (isStream) body.pipe(req); else { if (data) req.write(data); req.end(); }
  });
}

// Read a streaming JSON-lines response (build / pull), collect log, throw on error.
function consumeProgress(res, onLine) {
  return new Promise((resolve, reject) => {
    let buf = '', error = null;
    res.on('data', c => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m.error || m.errorDetail) error = m.error || m.errorDetail.message;
          const text = m.stream || m.status || m.error;
          if (text && onLine) onLine(String(text).replace(/\n$/, ''));
        } catch {}
      }
    });
    res.on('end', () => (error ? reject(new Error(error)) : resolve()));
    res.on('error', reject);
  });
}

async function ping() {
  try { await request('GET', '/_ping'); return true; } catch { return false; }
}

async function ensureImage(image, onLine) {
  try { await request('GET', `/images/${encodeURIComponent(image)}/json`); return; } catch (e) { if (e.status !== 404) throw e; }
  const [name, tag = 'latest'] = image.split(':');
  const res = await request('POST', `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`, { stream: true });
  await consumeProgress(res, onLine);
}

// Optional build settings for hosts behind a proxy:
//   DOCKER_BUILD_NETWORK=host   DOCKER_BUILD_ARGS='{"HTTPS_PROXY":"http://..."}'
async function build(tag, tarStream, onLine) {
  let qs = `t=${encodeURIComponent(tag)}&rm=1&forcerm=1`;
  if (process.env.DOCKER_BUILD_NETWORK) qs += `&networkmode=${encodeURIComponent(process.env.DOCKER_BUILD_NETWORK)}`;
  if (process.env.DOCKER_BUILD_ARGS) qs += `&buildargs=${encodeURIComponent(process.env.DOCKER_BUILD_ARGS)}`;
  const res = await request('POST', `/build?${qs}`, {
    body: tarStream, headers: { 'content-type': 'application/x-tar' }, stream: true,
  });
  await consumeProgress(res, onLine);
}

async function inspect(name) {
  try { return (await request('GET', `/containers/${name}/json`)).json; } catch (e) { if (e.status === 404) return null; throw e; }
}

async function remove(name) {
  try { await request('DELETE', `/containers/${name}?force=1`); } catch (e) { if (e.status !== 404) throw e; }
}

async function run(name, spec) {
  await remove(name);
  await request('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body: spec });
  await request('POST', `/containers/${name}/start`);
}

async function start(name) { try { await request('POST', `/containers/${name}/start`); } catch (e) { if (e.status !== 304) throw e; } }
async function stop(name) { try { await request('POST', `/containers/${name}/stop?t=3`); } catch (e) { if (e.status !== 304 && e.status !== 404) throw e; } }

async function ensureNetwork(name) {
  try { await request('GET', `/networks/${name}`); } catch (e) {
    if (e.status !== 404) throw e;
    await request('POST', '/networks/create', { body: { Name: name, Driver: 'bridge' } });
  }
}

async function logs(name, tail = 200) {
  const r = await request('GET', `/containers/${name}/logs?stdout=1&stderr=1&tail=${tail}`);
  // Demultiplex the docker log stream: 8-byte header per frame.
  const b = r.raw, out = [];
  let i = 0;
  while (i + 8 <= b.length) {
    const len = b.readUInt32BE(i + 4);
    out.push(b.slice(i + 8, i + 8 + len).toString());
    i += 8 + len;
  }
  return out.length ? out.join('') : b.toString();
}

module.exports = { request, ping, ensureImage, build, inspect, remove, run, start, stop, ensureNetwork, logs };
