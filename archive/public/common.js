// Shared header and helpers for the portal pages.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let mePromise = null;
// The signed-in user and their site permissions: { user, permissions, google, registration }.
export function me() {
  mePromise ||= api('/api/me').catch(() => ({ user: null, permissions: [], google: false, registration: false }));
  return mePromise;
}
export const has = (m, perm) => m.permissions.includes(perm) || m.permissions.includes('site.admin');

export function header(active) {
  const el = document.createElement('header');
  el.className = 'topnav';
  el.innerHTML = `
    <a class="logo" href="/">
      <svg viewBox="0 0 40 40" fill="#fff" aria-hidden="true"><rect x="4" y="32" width="32" height="4"/><rect x="6" y="12" width="4" height="18"/><rect x="14" y="12" width="4" height="18"/><rect x="22" y="12" width="4" height="18"/><rect x="30" y="12" width="4" height="18"/><path d="M3 10 20 3l17 7z"/></svg>
      Virtual World Archive
    </a>
    <nav>
      <a class="ext" href="https://archive.org/details/software">Software</a>
      <a class="ext" href="https://archive.org/details/emulation">Emulation</a>
      <a href="/" class="${active === 'servers' ? 'active' : ''}">Server Library</a>
      <a href="/#upload" class="${active === 'upload' ? 'active' : ''}">Upload</a>
      <a href="/toolkit.html" class="${active === 'toolkit' ? 'active' : ''}">Toolkit</a>
      <a href="/admin" class="${active === 'admin' ? 'active' : ''}" data-admin hidden>Access control</a>
    </nav>
    <div class="account" data-account></div>`;
  document.body.prepend(el);
  me().then(m => {
    const box = el.querySelector('[data-account]');
    if (has(m, 'access.manage')) el.querySelector('[data-admin]').hidden = false;
    if (m.user) {
      box.innerHTML = `<a href="/account" class="${active === 'account' ? 'active' : ''}">${esc(m.user.name)}</a>
        <button class="linkbtn" data-signout>Sign out</button>`;
      box.querySelector('[data-signout]').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; };
    } else {
      box.innerHTML = `<a href="/login?next=${encodeURIComponent(location.pathname + location.search)}">Sign in</a>`;
    }
  });
}

// fetch wrapper: JSON in and out; plain objects are sent as JSON.
export async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', ...opts };
  if (o.body && !(o.body instanceof FormData) && typeof o.body === 'object') {
    o.body = JSON.stringify(o.body); o.headers = { 'content-type': 'application/json', ...(o.headers || {}) };
  }
  const r = await fetch(path, o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.status = r.status; throw e; }
  return j;
}

export function pill(state) {
  const s = state || 'unknown';
  return `<span class="pill ${esc(s)}">${esc(s)}</span>`;
}

// Policy badge for a server tile or page.
export function policyBadge(policy) {
  if (!policy) return '';
  const parts = [];
  if (policy.mode === 'managed') parts.push('<span class="badge managed" title="Managed Server Instance: only bound group roles administer it">Managed</span>');
  if (policy.access === 'members') parts.push('<span class="badge" title="Sign in to join">Members</span>');
  if (policy.access === 'restricted') parts.push('<span class="badge restricted" title="Only bound group roles can join">Restricted</span>');
  return parts.join(' ');
}
